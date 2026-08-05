// 阿里云百炼实时语音识别（主进程）
//
// 依赖 Node 22+ 内置的 WebSocket，无需安装第三方包。
// 配置保存于 userData/asr-config.json；apiKey 可回退到环境变量 DASHSCOPE_API_KEY。
// 协议：WebSocket → run-task → task-started → 二进制 PCM → finish-task → task-finished
// 参考：https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AsrConfig } from '../shared/chat-types';

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const DEFAULT_MODEL = 'qwen-audio-3.0-asr-flash-streaming';

/** 解析热词：支持中英文逗号、顿号、空格分隔；每个词不超过 15 字符 */
function parseHotWords(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw ?? '').split(/[,，、;；\s]+/)) {
    const w = part.trim();
    if (!w || w.length > 15 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 100) break;
  }
  return out;
}

// ---- 配置读写 ----

function configPath(): string {
  return path.join(app.getPath('userData'), 'asr-config.json');
}

export function loadAsrConfig(): AsrConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return JSON.parse(raw) as AsrConfig;
  } catch {
    return {};
  }
}

export function saveAsrConfig(patch: Partial<AsrConfig>): AsrConfig {
  const merged: AsrConfig = { ...loadAsrConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ASR] failed to save config:', err);
  }
  return merged;
}

/** 归一化配置：apiKey 优先取环境变量；模型默认千问流式（更准） */
export function resolveAsrConfig(): Required<AsrConfig> {
  const cfg = loadAsrConfig();
  const model = cfg.model === 'paraformer-realtime-v2' ? cfg.model : DEFAULT_MODEL;
  return {
    apiKey: cfg.apiKey || process.env.DASHSCOPE_API_KEY || '',
    model,
    hotWords: typeof cfg.hotWords === 'string' ? cfg.hotWords : '',
  };
}

// ---- WebSocket 识别会话 ----
//
// Node 内置 WebSocket（undici）签名与 DOM 不同：支持第二个参数 { headers }，
// 事件用 onopen/onmessage 属性。用局部类型声明避免与 DOM 类型冲突。

interface DashWsMessageEvent {
  data: unknown;
}

interface DashWs {
  onopen: (() => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  onmessage: ((ev: DashWsMessageEvent) => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

type DashWsCtor = new (url: string, options?: { headers?: Record<string, string> }) => DashWs;

const DashWebSocket = (globalThis as unknown as { WebSocket?: DashWsCtor }).WebSocket;

export interface AsrCallbacks {
  /** 中间结果（边说边出字） */
  onPartial: (text: string) => void;
  /** 一句话识别完成 */
  onFinal: (text: string) => void;
  /** 识别出错 */
  onError: (message: string) => void;
}

class AsrSession {
  readonly id: string;
  private ws: DashWs;
  private started = false;
  private settled = false;
  private finalText = '';
  private pending: ArrayBuffer[] = [];
  private resolveStop: ((text: string) => void) | null = null;

  constructor(
    apiKey: string,
    private callbacks: AsrCallbacks,
    private model: string,
    private hotWords: string[],
  ) {
    this.id = randomUUID();
    if (!DashWebSocket) {
      throw new Error('当前 Node 环境不支持全局 WebSocket（需要 Node 22+）');
    }
    this.ws = new DashWebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.ws.onopen = () => this.sendStart();
    this.ws.onmessage = (ev) => this.onMessage(ev);
    this.ws.onerror = (ev) => this.fail(ev?.message ?? 'unknown');
    this.ws.onclose = () => {
      if (!this.settled) this.finishStop();
    };
  }

  private sendStart(): void {
    try {
      const parameters: Record<string, unknown> = { format: 'pcm', sample_rate: 16000 };
      // 即时热词：提升人名/专有名词识别准确率（权重 4，免费）
      if (this.hotWords.length > 0) {
        parameters.vocabulary = Object.fromEntries(this.hotWords.map((w) => [w, 4]));
      }
      // Paraformer 专属参数；千问模型只需 format + sample_rate
      if (this.model === 'paraformer-realtime-v2') {
        Object.assign(parameters, {
          disfluency_removal_enabled: true,
          semantic_punctuation_enabled: false,
          punctuation_prediction_enabled: true,
          max_sentence_silence: 800,
        });
      }
      this.ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: this.id, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: this.model,
          parameters,
          input: {},
        },
      }));
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private onMessage(ev: DashWsMessageEvent): void {
    let msg: {
      header?: {
        event?: string;
        error_code?: string;
        error_message?: string;
      };
      payload?: {
        output?: {
          sentence?: { text?: string; sentence_end?: boolean };
        };
      };
    };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }

    const event = msg.header?.event;
    if (event === 'task-started') {
      this.started = true;
      // 补发连接/启动期间积累的音频
      for (const buf of this.pending) {
        try { this.ws.send(buf); } catch { /* ignore */ }
      }
      this.pending = [];
      return;
    }

    if (event === 'result-generated') {
      const sentence = msg.payload?.output?.sentence;
      if (sentence?.text) {
        if (sentence.sentence_end) {
          this.finalText += sentence.text;
          this.callbacks.onFinal(sentence.text);
        } else {
          this.callbacks.onPartial(sentence.text);
        }
      }
      return;
    }

    if (event === 'task-finished') {
      this.finishStop();
      return;
    }

    if (event === 'task-failed') {
      this.fail(`${msg.header?.error_message ?? 'unknown'} (${msg.header?.error_code ?? '?'})`);
    }
  }

  sendAudio(data: ArrayBuffer): void {
    if (this.settled) return;
    if (this.started) {
      try { this.ws.send(data); } catch { /* ignore */ }
    } else {
      this.pending.push(data);
    }
  }

  /** 结束识别：等服务端返回最终结果 */
  stop(): Promise<string> {
    if (this.settled) return Promise.resolve(this.finalText);
    return new Promise((resolve) => {
      this.resolveStop = resolve;
      try {
        this.ws.send(JSON.stringify({
          header: { action: 'finish-task', task_id: this.id, streaming: 'duplex' },
          payload: { input: {} },
        }));
      } catch {
        this.finishStop();
      }
      // 10 秒兜底：服务端没回 task-finished 也返回已有文本
      setTimeout(() => {
        if (!this.settled) this.finishStop();
      }, 10000);
    });
  }

  /** 立即放弃识别 */
  abort(): void {
    this.settled = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }

  private finishStop(): void {
    if (this.settled) return;
    this.settled = true;
    try { this.ws.close(); } catch { /* ignore */ }
    this.resolveStop?.(this.finalText);
    this.resolveStop = null;
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.callbacks.onError(message);
    this.finishStop();
  }
}

// ---- 会话管理 ----

const sessions = new Map<string, AsrSession>();

/** 开启识别会话，返回 sessionId（音频在 task-started 前会先缓冲） */
export function startAsr(
  cfg: { apiKey: string; model: string; hotWords: string },
  callbacks: AsrCallbacks,
): string {
  const session = new AsrSession(cfg.apiKey, callbacks, cfg.model, parseHotWords(cfg.hotWords));
  sessions.set(session.id, session);
  return session.id;
}

/** 发送 16k 单声道 PCM（Int16）音频块 */
export function sendAsrAudio(sessionId: string, data: unknown): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  let buf: ArrayBuffer;
  if (data instanceof ArrayBuffer) {
    buf = data;
  } else if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    buf = (view.buffer as ArrayBuffer).slice(view.byteOffset, view.byteOffset + view.byteLength);
  } else {
    return;
  }
  session.sendAudio(buf);
}

/** 结束识别，返回最终文本 */
export function stopAsr(sessionId: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.resolve('');
  sessions.delete(sessionId);
  return session.stop();
}

/** 放弃识别（窗口关闭等场景） */
export function abortAsr(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  session.abort();
}

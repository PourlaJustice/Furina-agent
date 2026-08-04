// MiniMax TTS 语音合成（主进程）
//
// 依赖 Node 22+ 内置的 fetch 与 WebSocket，无需安装第三方包。
// 配置保存于 userData/tts-config.json；apiKey 可回退到环境变量 MINIMAX_API_KEY。
// API 参考：https://platform.minimaxi.com/document

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { TtsConfig, TtsSpeakResult } from '../shared/chat-types';

const DEFAULT_MODEL = 'speech-2.8-hd';
const WS_URL = 'wss://api.minimaxi.com/ws/v1/t2a_v2';

// ---- 配置读写 ----

function configPath(): string {
  return path.join(app.getPath('userData'), 'tts-config.json');
}

export function loadTtsConfig(): TtsConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return JSON.parse(raw) as TtsConfig;
  } catch {
    return { enabled: false };
  }
}

export function saveTtsConfig(patch: Partial<TtsConfig>): TtsConfig {
  const merged: TtsConfig = { ...loadTtsConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf-8');
  } catch (err) {
    console.error('[TTS] failed to save config:', err);
  }
  return merged;
}

/** 归一化配置：填入默认值，apiKey 优先取环境变量 */
export function resolveTtsConfig(): Required<TtsConfig> {
  const cfg = loadTtsConfig();
  return {
    enabled: Boolean(cfg.enabled),
    apiKey: cfg.apiKey || process.env.MINIMAX_API_KEY || '',
    voiceId: cfg.voiceId || '',
    model: cfg.model === 'speech-2.8-turbo' ? 'speech-2.8-turbo' : DEFAULT_MODEL,
    speed: typeof cfg.speed === 'number' ? Math.min(2, Math.max(0.5, cfg.speed)) : 1,
    volume: typeof cfg.volume === 'number' ? Math.min(2, Math.max(0, cfg.volume)) : 1,
  };
}

// ---- MiniMax WebSocket 语音合成 ----
//
// Node 22+ 内置的全局 WebSocket（undici）签名与 DOM WebSocket 不同：
// 支持第二个参数 { headers }，且事件是 onopen/onmessage 属性。
// 这里用局部类型声明避免与 tsconfig 默认 DOM 类型冲突。

interface MiniWsMessageEvent {
  data: unknown;
}

interface MiniWs {
  onopen: (() => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  onmessage: ((ev: MiniWsMessageEvent) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
}

type MiniWsCtor = new (url: string, options?: { headers?: Record<string, string> }) => MiniWs;

const MiniWebSocket = (globalThis as unknown as { WebSocket?: MiniWsCtor }).WebSocket;

interface SynthesizeOptions {
  apiKey: string;
  voiceId: string;
  text: string;
  model?: 'speech-2.8-hd' | 'speech-2.8-turbo';
  speed?: number;
  volume?: number;
  /** 超时毫秒，默认 30000 */
  timeoutMs?: number;
}

/** 朗读前清理文本：去掉括号内的动作/舞台说明（如（眨眨眼）），避免被语音读出 */
export function cleanTtsText(raw: string): string {
  let text = String(raw ?? '');
  // 反复去除全角/半角括号与方括号内容（支持嵌套），直到没有可去除的内容
  for (let i = 0; i < 5; i++) {
    const cleaned = text
      .replace(/（[^（）]*）/g, '')
      .replace(/\([^()]*\)/g, '')
      .replace(/【[^【】]*】/g, '')
      .replace(/\[[^\[\]]*\]/g, '');
    if (cleaned === text) break;
    text = cleaned;
  }
  // 合并多余空白，避免出现连续空格/换行
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 用克隆好的音色合成一段语音，返回音频 Buffer（mp3）。
 * 协议：建立 WS → task_start → task_started → task_continue(发文本) → 收 hex 音频块 → is_final 结束。
 */
export async function synthesizeMiniMax(opts: SynthesizeOptions): Promise<Buffer> {
  const text = opts.text.trim();
  if (!text) throw new Error('TTS 文本为空');
  if (!opts.apiKey) throw new Error('未配置 MiniMax API Key');
  if (!opts.voiceId) throw new Error('未配置 MiniMax 音色 ID');
  if (!MiniWebSocket) {
    throw new Error('当前 Node 环境不支持全局 WebSocket（需要 Node 22+）');
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeoutMs = opts.timeoutMs ?? 30000;
    let settled = false;

    const ws: MiniWs = new MiniWebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('TTS 合成超时'));
    }, timeoutMs);

    ws.onopen = () => { /* 等待 connected_success */ };
    ws.onerror = (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('TTS WebSocket 错误: ' + (ev?.message ?? 'unknown')));
    };
    ws.onmessage = (ev) => {
      if (settled) return;
      let msg: {
        event?: string;
        data?: { audio?: string };
        is_final?: boolean;
        base_resp?: { status_code?: number; status_msg?: string };
      };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (msg.event === 'connected_success') {
        ws.send(JSON.stringify({
          event: 'task_start',
          model: opts.model ?? DEFAULT_MODEL,
          voice_setting: {
            voice_id: opts.voiceId,
            speed: opts.speed ?? 1,
            vol: opts.volume ?? 1,
            pitch: 0,
            english_normalization: false,
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: 'mp3',
            channel: 1,
          },
        }));
        return;
      }

      if (msg.event === 'task_started') {
        ws.send(JSON.stringify({ event: 'task_continue', text }));
        return;
      }

      if (msg.data?.audio) {
        chunks.push(Buffer.from(msg.data.audio, 'hex'));
        return;
      }

      if (msg.is_final) {
        settled = true;
        clearTimeout(timeout);
        try { ws.send(JSON.stringify({ event: 'task_finish' })); } catch { /* ignore */ }
        try { ws.close(); } catch { /* ignore */ }
        const audio = Buffer.concat(chunks);
        if (audio.length === 0) {
          reject(new Error('TTS 合成结果为空'));
        } else {
          resolve(audio);
        }
        return;
      }

      if (msg.base_resp && msg.base_resp.status_code !== 0) {
        settled = true;
        clearTimeout(timeout);
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`TTS 合成失败: ${msg.base_resp.status_msg} (${msg.base_resp.status_code})`));
      }
    };
  });
}

/** 供 IPC 调用：合成一句，返回渲染进程可直接播放的结果；失败时返回空音频而不是抛错（不阻塞聊天） */
export async function speakWithConfig(text: string): Promise<TtsSpeakResult> {
  const cfg = resolveTtsConfig();
  if (!cfg.enabled) return { audioBase64: '', format: 'mp3' };
  if (!cfg.apiKey || !cfg.voiceId) {
    return { audioBase64: '', format: 'mp3', error: '未配置 MiniMax API Key / 音色 ID' };
  }
  const cleanText = cleanTtsText(text);
  if (!cleanText) return { audioBase64: '', format: 'mp3', error: '文本为空' };
  try {
    const audio = await synthesizeMiniMax({
      apiKey: cfg.apiKey,
      voiceId: cfg.voiceId,
      text: cleanText,
      model: cfg.model,
      speed: cfg.speed,
      volume: cfg.volume,
    });
    return { audioBase64: audio.toString('base64'), format: 'mp3' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[TTS] 合成失败:', message);
    return { audioBase64: '', format: 'mp3', error: message };
  }
}
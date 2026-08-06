// 手机提醒推送：提醒触发时把“标题 + 内容 + 时间”推送到手机
// 通道：ntfy（推荐，安卓官方 App，支持自定义铃声/一直响）/ Bark（苹果）
// 失败只记日志，绝不影响本地闹钟
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { PhonePushConfig } from '../shared/chat-types';

let cfg: PhonePushConfig = {
  enabled: false,
  channel: 'ntfy',
  ntfyTopic: '',
  ntfyServer: 'https://ntfy.sh',
  barkUrl: '',
  sound: '',
  group: '',
};
let configPath = '';

function ensurePath(): string {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'phone-push.json');
  return configPath;
}

function loadConfig(): PhonePushConfig {
  try {
    const p = ensurePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<PhonePushConfig>;
      cfg = {
        enabled: Boolean(data.enabled),
        channel: data.channel === 'bark' ? 'bark' : 'ntfy',
        ntfyTopic: typeof data.ntfyTopic === 'string' ? data.ntfyTopic : '',
        ntfyServer: typeof data.ntfyServer === 'string' && data.ntfyServer.trim() ? data.ntfyServer.trim() : 'https://ntfy.sh',
        barkUrl: typeof data.barkUrl === 'string' ? data.barkUrl : '',
        sound: typeof data.sound === 'string' ? data.sound : '',
        group: typeof data.group === 'string' ? data.group : '',
      };
    }
  } catch {
    cfg = { enabled: false, channel: 'ntfy', ntfyTopic: '', ntfyServer: 'https://ntfy.sh', barkUrl: '', sound: '', group: '' };
  }
  return cfg;
}

function saveConfig(): void {
  try {
    const p = ensurePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {
    // 保存失败不影响主流程
  }
}

export function resolvePhonePushConfig(): PhonePushConfig {
  return loadConfig();
}

export function savePhonePushConfig(patch: unknown): PhonePushConfig {
  const obj = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  if (typeof obj.enabled === 'boolean') cfg.enabled = obj.enabled;
  if (obj.channel === 'ntfy' || obj.channel === 'bark') cfg.channel = obj.channel;
  if (typeof obj.ntfyTopic === 'string') cfg.ntfyTopic = obj.ntfyTopic.trim();
  if (typeof obj.ntfyServer === 'string') cfg.ntfyServer = obj.ntfyServer.trim() || 'https://ntfy.sh';
  if (typeof obj.barkUrl === 'string') cfg.barkUrl = obj.barkUrl.trim();
  if (typeof obj.sound === 'string') cfg.sound = obj.sound.trim();
  if (typeof obj.group === 'string') cfg.group = obj.group.trim();
  saveConfig();
  return { ...cfg };
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 归一化服务器地址：补 https:// 前缀、去掉结尾 / */
function normalizeServer(raw: string): string {
  let u = (raw ?? '').trim();
  if (!u) return 'https://ntfy.sh';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

/** 归一化 Bark 地址：https://api.day.app/KEY → 带结尾 / 的 base */
function normalizeBarkUrl(raw: string): string {
  let u = (raw ?? '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  return u + '/';
}

async function postNtfy(title: string, body: string, c: PhonePushConfig): Promise<{ ok: boolean; reason?: string }> {
  const topic = (c.ntfyTopic ?? '').trim();
  if (!topic) return { ok: false, reason: '未填写 ntfy 主题名' };
  const server = normalizeServer(c.ntfyServer ?? 'https://ntfy.sh');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // ★ 标题/内容含中文与表情，必须走 JSON 正文（HTTP 头只允许 ASCII，否则 fetch 会直接报错）
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        title,
        message: body,
        tags: ['bell'],
        priority: 5,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function postBark(title: string, body: string, c: PhonePushConfig): Promise<{ ok: boolean; reason?: string }> {
  const base = normalizeBarkUrl(c.barkUrl ?? '');
  if (!base) return { ok: false, reason: '未配置 Bark 推送地址' };
  const params = new URLSearchParams();
  if (c.sound) params.set('sound', c.sound);
  if (c.group) params.set('group', c.group);
  const url = `${base}${encodeURIComponent(title)}/${encodeURIComponent(body)}${params.toString() ? '?' + params.toString() : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function postByChannel(title: string, body: string, c: PhonePushConfig): Promise<{ ok: boolean; reason?: string }> {
  return c.channel === 'bark' ? postBark(title, body, c) : postNtfy(title, body, c);
}

/** 提醒触发时推送到手机（失败只记日志，不影响本地闹钟） */
export async function sendPhonePush(text: string, dueAt: number): Promise<{ ok: boolean; reason?: string }> {
  const c = loadConfig();
  if (!c.enabled) {
    console.log('[PhonePush] 未启用，跳过手机推送');
    return { ok: false, reason: '未启用' };
  }
  if (c.channel === 'bark' && !c.barkUrl) {
    console.log('[PhonePush] Bark 通道未配置地址，跳过');
    return { ok: false, reason: '未配置' };
  }
  if (c.channel === 'ntfy' && !c.ntfyTopic) {
    console.log('[PhonePush] ntfy 通道未配置主题，跳过');
    return { ok: false, reason: '未配置' };
  }
  const result = await postByChannel('⏰ 时间到啦！', `${text}（${fmtTime(dueAt)}）`, c);
  console.log(`[PhonePush] ${result.ok ? '推送成功' : '推送失败: ' + (result.reason ?? '')}（通道: ${c.channel}）`);
  return result;
}

/** 设置界面的“发送测试” */
export async function testPhonePush(): Promise<{ ok: boolean; reason?: string }> {
  const c = loadConfig();
  if (!c.enabled) return { ok: false, reason: '请先启用手机提醒' };
  if (c.channel === 'bark' && !c.barkUrl) return { ok: false, reason: '请先填写 Bark 推送地址' };
  if (c.channel === 'ntfy' && !c.ntfyTopic) return { ok: false, reason: '请先填写 ntfy 主题名' };
  return postByChannel('芙宁娜测试', `这是一条测试提醒，手机收到就说明配置成功了～（${fmtTime(Date.now())}）`, c);
}
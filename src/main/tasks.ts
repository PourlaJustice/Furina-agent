// 待办 + 提醒：数据保存在 userData/tasks.json，提醒到点弹系统通知
import { app, BrowserWindow, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface TodoItem {
  id: string;
  text: string;
  createdAt: number;
  done: boolean;
}

export interface ReminderItem {
  id: string;
  text: string;
  dueAt: number;
  createdAt: number;
  fired: boolean;
}

interface TaskStore {
  todos: TodoItem[];
  reminders: ReminderItem[];
}

const MAX_TIMEOUT = 2147483647; // setTimeout 单次上限（约 24.8 天）
const PRUNE_MS = 7 * 24 * 3600 * 1000; // 已触发提醒保留 7 天后清理

/** 提醒触发回调（主进程注入：用于把提醒同步推送到聊天窗口，双重提醒） */
let reminderListener: ((text: string, dueAt: number) => void) | null = null;
export function onReminderFired(cb: (text: string, dueAt: number) => void): void {
  reminderListener = cb;
}

let store: TaskStore = { todos: [], reminders: [] };
let storePath = '';
const timers = new Map<string, NodeJS.Timeout>();

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function ensureStorePath(): string {
  if (!storePath) storePath = path.join(app.getPath('userData'), 'tasks.json');
  return storePath;
}

function loadStore(): void {
  try {
    const p = ensureStorePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<TaskStore>;
      store = {
        todos: Array.isArray(data.todos) ? data.todos : [],
        reminders: Array.isArray(data.reminders) ? data.reminders : [],
      };
    }
  } catch {
    store = { todos: [], reminders: [] };
  }
}

function saveStore(): void {
  try {
    const p = ensureStorePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // 保存失败不影响对话
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function nowIso(): string {
  return fmtTime(Date.now());
}

// ---------- 时间解析 ----------
function parseDueTime(input: string): number | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const now = new Date();

  // 相对时间：N秒/分钟/小时/天后
  const rel = s.match(/^(\d+)\s*(秒|分钟|小时|天)后$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === '秒' ? 1000 : unit === '分钟' ? 60_000 : unit === '小时' ? 3_600_000 : 86_400_000;
    return now.getTime() + n * ms;
  }

  // 完整日期时间：2026-08-04 15:30 或 2026-08-04T15:30:00
  const dt = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (dt) {
    const d = new Date(Number(dt[1]), Number(dt[2]) - 1, Number(dt[3]), Number(dt[4]), Number(dt[5]), Number(dt[6] ?? 0));
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  // 明天/后天/今晚 + HH:mm
  const day = s.match(/^(明天|后天|今晚)\s*(\d{1,2}):(\d{1,2})$/);
  if (day) {
    const d = new Date(now);
    if (day[1] === '明天') d.setDate(d.getDate() + 1);
    if (day[1] === '后天') d.setDate(d.getDate() + 2);
    d.setHours(Number(day[2]), Number(day[3]), 0, 0);
    if (day[1] === '今晚' && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // 今天 HH:mm 或 HH:mm（已过则算明天）
  const hm = s.match(/^(\d{1,2}):(\d{1,2})$/);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // 中文时段：明天下午3点 / 下午3点 / 3点 / 晚上8点半 / 3点30分
  const cn = s.match(/^(明天|后天|今晚)?\s*(凌晨|上午|中午|下午|晚上)?\s*(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?|半)?$/);
  if (cn) {
    const d = new Date(now);
    if (cn[1] === '明天') d.setDate(d.getDate() + 1);
    if (cn[1] === '后天') d.setDate(d.getDate() + 2);
    let hour = Number(cn[3]);
    const minute = cn[4] !== undefined ? Number(cn[4]) : s.includes('半') ? 30 : 0;
    const period = cn[2];
    if (period === '下午' || period === '晚上') {
      if (hour < 12) hour += 12;
    } else if (period === '凌晨') {
      if (hour === 12) hour = 0;
    } else if (period === '中午') {
      if (hour < 12) hour += 12;
    }
    if (hour === 24) hour = 0;
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  return null;
}

// ---------- 提醒调度 ----------
function clearTimer(id: string): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

function fireReminder(rem: ReminderItem): void {
  clearTimer(rem.id);
  rem.fired = true;
  saveStore();
  let toast = false;
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '芙宁娜提醒你',
        body: `⏰ ${rem.text}\n（${fmtTime(rem.dueAt)}）`,
      });
      // 点击通知 → 聚焦桌宠窗口
      n.on('click', () => {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible());
        w?.show();
        w?.focus();
      });
      n.show();
      toast = true;
    }
  } catch {
    // 通知失败就只写日志
  }
  console.log(`[Tasks] 提醒触发: ${rem.text} (${fmtTime(rem.dueAt)})${toast ? '' : '（系统通知未显示，已推送到聊天窗）'}`);
  // ★ 双保险：无论系统通知是否成功，都推送到聊天窗口
  try {
    reminderListener?.(rem.text, rem.dueAt);
  } catch {
    // 忽略
  }
}

function scheduleReminder(rem: ReminderItem): void {
  clearTimer(rem.id);
  if (rem.fired) return;
  const delay = rem.dueAt - Date.now();
  if (delay <= 0) {
    fireReminder(rem);
    return;
  }
  const t = setTimeout(() => {
    timers.delete(rem.id);
    scheduleReminder(rem); // 到期后再次检查（支持超长提醒分段计时）
  }, Math.min(delay, MAX_TIMEOUT));
  timers.set(rem.id, t);
}

/** 启动时调用：载入持久化数据并恢复未触发的提醒 */
export function initTasks(): void {
  loadStore();
  // 已过期但未触发的提醒直接标记为已触发（避免补弹一堆通知）
  const now = Date.now();
  for (const r of store.reminders) {
    if (!r.fired && r.dueAt <= now) r.fired = true;
  }
  // 清理 7 天前的已触发提醒，防止 tasks.json 无限膨胀
  store.reminders = store.reminders.filter((r) => !r.fired || now - r.dueAt < PRUNE_MS);
  saveStore();
  for (const r of store.reminders) scheduleReminder(r);
  console.log(`[Tasks] 已载入 ${store.todos.length} 条待办、${store.reminders.filter((r) => !r.fired).length} 个待触发提醒`);
}

// ---------- 待办 ----------
export function addTodo(text: string): string {
  const t = text.trim();
  if (!t) return '待办内容不能为空';
  store.todos.unshift({ id: genId(), text: t, createdAt: Date.now(), done: false });
  saveStore();
  return `已记下待办：${t}`;
}

export function listTodos(): string {
  if (store.todos.length === 0) return '当前没有待办事项';
  const lines = store.todos.map((t, i) => {
    const status = t.done ? '[已完成]' : '[未完成]';
    return `${i + 1}. ${status} ${t.text}（id: ${t.id}）`;
  });
  return `待办列表（共 ${store.todos.length} 条）：\n${lines.join('\n')}`;
}

export function completeTodo(id: string): string {
  const item = store.todos.find((t) => t.id === id.trim());
  if (!item) return `找不到 id 为 ${id} 的待办，可先用 list_todos 查看`;
  item.done = true;
  saveStore();
  return `已完成：${item.text}`;
}

export function deleteTodo(id: string): string {
  const idx = store.todos.findIndex((t) => t.id === id.trim());
  if (idx < 0) return `找不到 id 为 ${id} 的待办`;
  const [removed] = store.todos.splice(idx, 1);
  saveStore();
  return `已删除待办：${removed.text}`;
}

// ---------- 提醒 ----------
export function addReminder(text: string, time: string): string {
  const t = text.trim();
  if (!t) return '提醒内容不能为空';
  const due = parseDueTime(time);
  if (due === null) {
    return `无法解析时间：${time}。当前时间是 ${nowIso()}。支持的格式：\n- 15:30（今天，已过则明天）\n- 2026-08-04 15:30\n- 明天 9:00 / 后天 18:00\n- 5分钟后 / 2小时后`;
  }
  const rem: ReminderItem = { id: genId(), text: t, dueAt: due, createdAt: Date.now(), fired: false };
  store.reminders.push(rem);
  saveStore();
  scheduleReminder(rem);
  return `已设置提醒：${t}（${fmtTime(due)}）`;
}

export function listReminders(): string {
  const pending = store.reminders.filter((r) => !r.fired);
  if (pending.length === 0) return '当前没有待触发的提醒';
  const lines = pending.map((r, i) => `${i + 1}. ${fmtTime(r.dueAt)} ${r.text}（id: ${r.id}）`);
  return `提醒列表（共 ${pending.length} 个）：\n${lines.join('\n')}`;
}

export function cancelReminder(id: string): string {
  const idx = store.reminders.findIndex((r) => r.id === id.trim());
  if (idx < 0) return `找不到 id 为 ${id} 的提醒`;
  const [removed] = store.reminders.splice(idx, 1);
  clearTimer(removed.id);
  saveStore();
  return `已取消提醒：${removed.text}`;
}

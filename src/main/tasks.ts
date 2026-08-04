// 待办 + 提醒：数据保存在 userData/tasks.json，提醒到点弹系统通知
import { app, Notification } from 'electron';
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
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '芙宁娜提醒你',
        body: `⏰ ${rem.text}\n（${fmtTime(rem.dueAt)}）`,
      });
      n.show();
    }
  } catch {
    // 通知失败就只写日志
  }
  console.log(`[Tasks] 提醒触发: ${rem.text} (${fmtTime(rem.dueAt)})`);
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

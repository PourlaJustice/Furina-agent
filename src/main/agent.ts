// Agent 编排 + 工具调用（Function Calling）
// 两阶段：用户消息含工具意图时 → LLM 分析 → 调用工具（危险操作弹窗确认）→ 循环直到给出最终回答。

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { completeDeepSeek } from './deepseek';
import { parseFileText } from './doc-parsers';
import { addReminder, addTodo, cancelReminder, completeTodo, deleteTodo, listReminders, listTodos } from './tasks';
import { getWeather } from './weather';
import { mcpManager } from './ai/mcp';
import { screenshotTool } from './screenshot';
import { isToolTrusted, trustTool } from './trust-store';

// ---------- 工具定义 ----------

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  dangerous?: boolean;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

const MAX_ITERATIONS = 6;
const MAX_TOOL_OUTPUT = 4000;

/** 把工具转成 DeepSeek tools 参数格式 */
function toSchema(t: ToolDef): Record<string, unknown> {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

/** 危险操作弹窗确认 */
interface PendingConfirm {
  toolName: string;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

const pendingConfirms = new Map<string, PendingConfirm>();

/** 渲染进程返回确认结果：once=仅本次 / always=以后默认通过 / deny=拒绝 */
ipcMain.handle('danger:confirm:respond', (_event, payload: { id?: unknown; choice?: unknown }) => {
  const id = typeof payload?.id === 'string' ? payload.id : '';
  const pending = pendingConfirms.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingConfirms.delete(id);
  const choice = typeof payload?.choice === 'string' ? payload.choice : '';
  if (choice === 'once') pending.resolve(true);
  else if (choice === 'always') {
    trustTool(pending.toolName);
    pending.resolve(true);
  } else {
    pending.resolve(false);
  }
  return true;
});

/** 危险操作确认：优先使用聊天同款主题弹窗，界面不可用时回退系统对话框 */
export async function confirmGate(toolName: string, args: Record<string, unknown>): Promise<boolean> {
  // 已信任的操作类型直接放行，不再弹窗
  if (isToolTrusted(toolName)) return true;

  const detail = Object.entries(args)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n');
  const win =
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isFocused()) ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible()) ??
    undefined;
  if (win && !win.webContents.isDestroyed()) {
    const id = `danger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingConfirms.delete(id);
        resolve(false);
      }, 120_000);
      pendingConfirms.set(id, { toolName, resolve, timer });
      win.webContents.send('danger:confirm', { id, toolName, detail });
    });
  }

  // 回退：系统原生对话框
  const options = {
    type: 'warning' as const,
    title: '高危操作确认',
    message: `芙宁娜想要执行：${toolName}`,
    detail: `${detail}\n\n如何选择？\n· 仅允许本次：只放行这一次，下次同类操作仍会询问\n· 本次及以后默认通过：以后同类操作不再询问\n· 拒绝：阻止这次操作`,
    buttons: ['仅允许本次', '本次及以后默认通过', '拒绝'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  };
  const result = await dialog.showMessageBox(options);
  if (result.response === 0) return true;
  if (result.response === 1) {
    trustTool(toolName);
    return true;
  }
  return false;
}

/** 执行单个工具；危险工具先弹窗确认 */
async function executeTool(tool: ToolDef, args: Record<string, unknown>): Promise<string> {
  try {
    if (tool.dangerous) {
      const ok = await confirmGate(tool.name, args);
      if (!ok) return '用户拒绝了该操作';
    }
    const raw = await tool.execute(args);
    const out = String(raw ?? '');
    return out.length > MAX_TOOL_OUTPUT ? out.slice(0, MAX_TOOL_OUTPUT) + '\n…（内容过长已截断）' : out;
  } catch (err) {
    return `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------- 内置工具 ----------

function fmtDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getFullYear()}年${p(d.getMonth() + 1)}月${p(d.getDate())}日 星期${week} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function homeDesktop(): string {
  return path.join(app.getPath('home'), 'Desktop');
}

/** 给耗时操作加超时（文件解析等），超时抛错 */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

/** Bing 网页搜索（国内可用，失败时返回提示） */
async function bingSearch(query: string, max = 5): Promise<string> {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans&mkt=zh-CN`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      signal: AbortSignal.timeout(15_000), // 搜索不挂死：15 秒超时
    });
    const html = await resp.text();
    const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
    if (blocks.length === 0) return '未搜索到结果';
    const lines: string[] = [];
    for (const b of blocks.slice(0, max)) {
      const a = b.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const strip = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim();
      if (a) {
        lines.push(`- ${strip(a[2])}\n  链接：${a[1]}${p ? `\n  摘要：${strip(p[1]).slice(0, 180)}` : ''}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : '未搜索到结果';
  } catch (err) {
    return `搜索失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: 'get_time',
    description: '获取当前的日期、星期和时间',
    parameters: { type: 'object', properties: {} },
    execute: () => fmtDate(new Date()),
  },
  {
    name: 'calc',
    description: '计算数学表达式，如 23*45+12、sqrt(16)、(3+4)*5、2^10、pow(2,10)。支持四则运算、括号、幂（^）、取模（%）与常用数学函数（sqrt/abs/pow/floor/ceil/round/min/max/log/exp/sin/cos/tan）',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '要计算的数学表达式' },
      },
      required: ['expression'],
    },
    execute: (args) => {
      const expr = String(args.expression ?? '').trim();
      if (!expr || expr.length > 100) return '表达式不合法';
      // 安全计算器：只允许数字/运算符/括号 + 白名单数学函数（不允许任意字母，防注入）
      const SAFE_FUNCS: Record<string, string> = {
        sqrt: 'Math.sqrt', abs: 'Math.abs', pow: 'Math.pow', floor: 'Math.floor',
        ceil: 'Math.ceil', round: 'Math.round', min: 'Math.min', max: 'Math.max',
        log: 'Math.log', exp: 'Math.exp', sin: 'Math.sin', cos: 'Math.cos',
        tan: 'Math.tan', PI: 'Math.PI', E: 'Math.E',
      };
      const tokens = expr.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|[\s+\-*/(),.%^]+/g) ?? [];
      if (tokens.join('') !== expr) return '表达式不合法';
      for (const t of tokens) {
        if (/^[A-Za-z_]/.test(t) && !(t in SAFE_FUNCS)) return '表达式不合法';
      }
      let mapped = expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (w) => SAFE_FUNCS[w] ?? '');
      // 幂：把 a^b 转成 Math.pow(a, b)（JS 原生 ^ 是位异或，不符合“幂”语义）
      mapped = mapped.replace(/(\d+(?:\.\d+)?)\s*\^\s*(\d+(?:\.\d+)?)/g, 'Math.pow($1,$2)');
      try {
        const result = Function(`"use strict"; return (${mapped});`)();
        return `${expr} = ${result}`;
      } catch {
        return '表达式计算失败';
      }
    },
  },
  {
    name: 'list_dir',
    description: '列出指定文件夹中的文件和子文件夹（不传路径时默认桌面）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件夹路径，默认桌面' } },
    },
    execute: (args) => {
      const dir = String(args.path ?? homeDesktop());
      if (!fs.existsSync(dir)) return `路径不存在：${dir}`;
      if (!fs.statSync(dir).isDirectory()) return `不是文件夹：${dir}`;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const lines = entries.slice(0, 100).map((e) => {
        if (e.isDirectory()) return `[文件夹] ${e.name}`;
        let size = '';
        try {
          const st = fs.statSync(path.join(dir, e.name));
          size = st.size >= 1024 * 1024 ? ` (${(st.size / 1024 / 1024).toFixed(1)}MB)` : ` (${Math.round(st.size / 1024)}KB)`;
        } catch { /* ignore */ }
        return `[文件] ${e.name}${size}`;
      });
      return `文件夹 ${dir} 共 ${entries.length} 项：\n${lines.join('\n')}`;
    },
  },
  {
    name: 'read_file',
    description: '读取文件内容（支持 txt/md/json/csv/pdf/docx/xlsx/pptx）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件完整路径' },
        max_chars: { type: 'number', description: '最多返回字符数，默认 3000' },
      },
      required: ['path'],
    },
    execute: async (args) => {
      const file = String(args.path ?? '');
      if (!file || !fs.existsSync(file)) return `文件不存在：${file}`;
      if (fs.statSync(file).isDirectory()) return `这是文件夹，请用 list_dir 查看：${file}`;
      const size = fs.statSync(file).size;
      if (size > 50 * 1024 * 1024) {
        return `文件过大（${(size / 1024 / 1024).toFixed(1)}MB），已拒绝读取（上限 50MB）`;
      }
      const text = await withTimeout(parseFileText(file), 30_000, '文件解析超时（30 秒），可能文件过大或损坏');
      if (!text || text.trim().length === 0) return '未能从该文件提取到文字（可能是扫描版/空文件）';
      const max = Math.max(500, Number(args.max_chars) || 3000);
      return text.slice(0, max) + (text.length > max ? '\n…（已截断）' : '');
    },
  },
  {
    name: 'write_file',
    description: '把文本内容写入文件；文件已存在时覆盖前需要用户确认',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件完整路径' },
        content: { type: 'string', description: '要写入的文本内容' },
      },
      required: ['path', 'content'],
    },
    execute: async (args) => {
      const file = String(args.path ?? '');
      const content = String(args.content ?? '');
      if (!file) return '缺少文件路径';
      // 覆盖已有文件需要确认
      if (fs.existsSync(file)) {
        const ok = await confirmGate('write_file（覆盖已有文件）', { path: file });
        if (!ok) return '用户拒绝了覆盖';
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf-8');
      return `已写入 ${file}（${content.length} 字符）`;
    },
  },
  {
    name: 'delete_file',
    description: '删除文件或文件夹（危险操作，需用户确认）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '要删除的文件或文件夹路径' } },
      required: ['path'],
    },
    dangerous: true,
    execute: (args) => {
      const file = String(args.path ?? '');
      if (!file || !fs.existsSync(file)) return `路径不存在：${file}`;
      fs.rmSync(file, { recursive: true, force: true });
      return `已删除：${file}`;
    },
  },
  {
    name: 'move_file',
    description: '移动或重命名文件/文件夹（危险操作，需用户确认）',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '源路径' },
        target: { type: 'string', description: '目标路径' },
      },
      required: ['source', 'target'],
    },
    dangerous: true,
    execute: (args) => {
      const source = String(args.source ?? '');
      const target = String(args.target ?? '');
      if (!source || !target || !fs.existsSync(source)) return `源路径无效：${source}`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
      return `已移动：${source} → ${target}`;
    },
  },
  {
    name: 'open_path',
    description: '用系统默认程序打开文件或文件夹',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件或文件夹路径' } },
      required: ['path'],
    },
    execute: async (args) => {
      const target = String(args.path ?? '');
      if (!target || !fs.existsSync(target)) return `路径不存在：${target}`;
      const err = await shell.openPath(target);
      return err ? `打开失败：${err}` : `已打开：${target}`;
    },
  },
  {
    name: 'web_search',
    description: '搜索互联网获取最新信息（如新闻、分数线、天气等）',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        max_results: { type: 'number', description: '返回结果条数，默认 5' },
      },
      required: ['query'],
    },
    execute: (args) => bingSearch(String(args.query ?? ''), Math.min(8, Number(args.max_results) || 5)),
  },
  {
    name: 'add_todo',
    description: '新增一条待办事项（用户要记下要做的事时使用）',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '待办内容，例如：完成开题报告' } },
      required: ['text'],
    },
    execute: (args) => addTodo(String(args.text ?? '')),
  },
  {
    name: 'list_todos',
    description: '查看当前所有待办事项（含未完成与已完成）',
    parameters: { type: 'object', properties: {} },
    execute: () => listTodos(),
  },
  {
    name: 'complete_todo',
    description: '把某条待办标记为已完成，参数 id 来自 list_todos 的返回',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '待办 id' } },
      required: ['id'],
    },
    execute: (args) => completeTodo(String(args.id ?? '')),
  },
  {
    name: 'delete_todo',
    description: '删除某条待办，参数 id 来自 list_todos 的返回',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '待办 id' } },
      required: ['id'],
    },
    execute: (args) => deleteTodo(String(args.id ?? '')),
  },
  {
    name: 'add_reminder',
    description: '设置一个定时提醒，到点弹系统通知。time 支持格式：HH:mm（如 15:30，已过则明天）、YYYY-MM-DD HH:mm、明天/后天 HH:mm、N分钟后/小时后',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容，例如：吃药、开会' },
        time: { type: 'string', description: '提醒时间，例如 15:30 或 2026-08-04 15:30 或 10分钟后' },
      },
      required: ['text', 'time'],
    },
    execute: (args) => addReminder(String(args.text ?? ''), String(args.time ?? '')),
  },
  {
    name: 'list_reminders',
    description: '查看当前所有未触发的提醒',
    parameters: { type: 'object', properties: {} },
    execute: () => listReminders(),
  },
  {
    name: 'cancel_reminder',
    description: '取消某条提醒，参数 id 来自 list_reminders 的返回',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '提醒 id' } },
      required: ['id'],
    },
    execute: (args) => cancelReminder(String(args.id ?? '')),
  },
  {
    name: 'get_weather',
    description: '查询指定城市的天气（今天/明天，Open-Meteo 离线兜底）。需要 15 天预报、空气质量、生活指数、天气预警等详细数据时，改用和风天气工具（qweather__get-weather-forecast / qweather__get-air-quality / qweather__get-weather-indices / qweather__get-weather-warning 等）',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，例如：北京、上海、广州' },
        when: { type: 'string', description: '可选：今天 / 明天，默认今天' },
      },
      required: ['city'],
    },
    execute: async (args) => getWeather(String(args.city ?? ''), String(args.when ?? '')),
  },
  {
    name: 'screen_shot',
    description: '截取屏幕指定区域或指定窗口，保存为 PNG 图片并返回保存路径。region 与 window_title 二选一，都不给则截整个主屏幕',
    parameters: {
      type: 'object',
      properties: {
        region: {
          type: 'object',
          description: '可选：{x, y, w, h} 屏幕坐标区域',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
        },
        window_title: { type: 'string', description: '可选：要截取的窗口标题（如 记事本）' },
        save_path: { type: 'string', description: '可选：保存路径，默认保存到桌面 furina-screenshots 文件夹' },
      },
    },
    dangerous: true,
    execute: async (args) => screenshotTool(String(args.window_title ?? ''), args.region, String(args.save_path ?? '')),
  },
];

// ---------- 工具意图检测（保留普通聊天的流式体验） ----------

const TOOL_KEYWORDS = [
  '搜索', '搜一下', '查一下', '查查', '查询', '查一查', '看看', '打开', '读取', '读一下',
  '文件', '文件夹', '目录', '桌面', '保存', '写入', '写一个', '创建', '删除', '移动',
  '重命名', '整理', '时间', '日期', '几点', '天气', '网页', '网址', '下载', '找一下', '找找',
  '邮件', '浏览', '帮我弄', '帮我做', '帮忙', '计算', '算一下', '帮我算',
  '提醒', '待办', '日程', '备忘', '闹钟', '记一下', '事项', '别忘了',
  '气温', '预报', '下雨', '刮风', '台风',
  '空气质量', '污染', 'AQI', '穿衣', '紫外线', '湿度', '体感',
  '数据库', '聊天记录', '统计',
  '识别', '图片', '看图', 'OCR',
  '定位', '位置', '我在哪',
  '截图', '屏幕', '截屏', '看看画面',
  '播放', '听歌', '放歌', '点歌', '音乐', '歌曲', '歌单', '歌词', '切歌', '暂停', '继续播放', '停止播放', '音量', '播放器', '放一首', '来一首', '听一首',
];

export function isToolIntent(text: string): boolean {
  return TOOL_KEYWORDS.some((k) => text.includes(k));
}

// ---------- Agent 循环 ----------

interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 两阶段 Agent 循环：
 * 调用 DeepSeek（带工具）→ 若返回工具调用则执行（危险操作弹窗确认）→ 结果回填 → 继续，
 * 直到模型直接给出最终回答或达到最大轮数。
 */
export async function runAgent(
  messages: Array<Record<string, unknown>>,
  onTool: (name: string, status: 'start' | 'done' | 'blocked' | 'error', summary: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const allTools = [...AGENT_TOOLS, ...mcpManager.toToolDefs()];
  const toolMap = new Map(allTools.map((t) => [t.name, t]));
  const msgs: Array<Record<string, unknown>> = [...messages];

  for (let round = 0; round < MAX_ITERATIONS; round++) {
    const res = await completeDeepSeek(msgs, allTools.map(toSchema), signal);
    const assistantMsg: Record<string, unknown> = { role: 'assistant', content: res.content };
    if (res.toolCalls.length > 0) {
      assistantMsg.tool_calls = res.toolCalls.map((tc: AgentToolCall) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    msgs.push(assistantMsg);

    if (res.toolCalls.length === 0) {
      return res.content.trim() || '（没有想好说什么）';
    }

    for (const tc of res.toolCalls) {
      const tool = toolMap.get(tc.name);
      if (!tool) {
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: `未知工具：${tc.name}` });
        onTool(tc.name, 'error', `未知工具：${tc.name}`);
        continue;
      }
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments || '{}');
      } catch {
        args = {};
      }
      onTool(tool.name, 'start', `正在${toolDesc(tool.name)}…`);
      const out = await executeTool(tool, args);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: out });
      onTool(tool.name, 'done', out.startsWith('用户拒绝') ? '操作被用户拒绝' : '完成');
    }
  }
  return '任务步骤较多，已达到上限，请告诉我下一步做什么。';
}

export function toolDesc(name: string): string {
  const map: Record<string, string> = {
    get_time: '查看时间',
    list_dir: '浏览文件夹',
    calc: '计算',
    read_file: '读取文件',
    write_file: '写入文件',
    delete_file: '删除文件',
    move_file: '移动文件',
    open_path: '打开文件',
    web_search: '搜索网页',
    add_todo: '添加待办',
    list_todos: '查看待办',
    complete_todo: '完成待办',
    delete_todo: '删除待办',
    add_reminder: '设置提醒',
    list_reminders: '查看提醒',
    cancel_reminder: '取消提醒',
    get_weather: '查询天气',
    screen_shot: '屏幕截图',
  };
  return map[name] ?? name;
}
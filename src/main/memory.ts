// 三层记忆系统
//
// L0 核心画像：只有用户明确说出的事实才写入（名字/年龄/职业/喜好/雷区）
// L1 近期动态：最近聊过的话题、目标（每次对话自动更新）
// L2 长期记忆：值得记住的事实/偏好/事件，带时间、访问次数、冲突标记
// 附加：实体关系图谱（人物/物品/地点关系）、冲突检测、提示词注入
//
// 数据持久化于 userData/memory.json；对话结束后后台异步提取，不阻塞聊天。

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { streamDeepSeek } from './deepseek';

// ---------- 类型定义 ----------

export interface L0Profile {
  name?: string;
  age?: string;
  occupation?: string;
  interests: string[];
  dislikes: string[];
  pinned: boolean;
}

export interface L1Snapshot {
  recentTopics: string[];
  recentGoals: string[];
  sessionCount: number;
  lastSeenAt: number;
  lastConversationAt: number;
}

export type MemoryCategory = 'fact' | 'preference' | 'event' | 'relationship';

export interface L2Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  conflictWith: string[];
  source: 'user' | 'inferred';
  pinned: boolean;
}

export interface EntityNode {
  id: string;
  name: string;
  type: 'person' | 'place' | 'item' | 'concept';
}

export interface RelationEdge {
  from: string;
  to: string;
  relation: string;
  createdAt: number;
}

export interface ConflictLog {
  a: string;
  b: string;
  reason: string;
  at: number;
}

export interface MemoryData {
  l0: L0Profile;
  l1: L1Snapshot;
  l2: L2Memory[];
  entities: EntityNode[];
  relations: RelationEdge[];
  conflicts: ConflictLog[];
}

// ---------- 持久化 ----------

function memoryPath(): string {
  return path.join(app.getPath('userData'), 'memory.json');
}

function defaultMemory(): MemoryData {
  const now = Date.now();
  return {
    l0: { interests: [], dislikes: [], pinned: false },
    l1: { recentTopics: [], recentGoals: [], sessionCount: 0, lastSeenAt: now, lastConversationAt: now },
    l2: [],
    entities: [],
    relations: [],
    conflicts: [],
  };
}

let memoryCache: MemoryData | null = null;

export function loadMemory(): MemoryData {
  if (memoryCache) return memoryCache;
  try {
    const raw = fs.readFileSync(memoryPath(), 'utf-8');
    const parsed = JSON.parse(raw) as MemoryData;
    memoryCache = { ...defaultMemory(), ...parsed, l0: { ...defaultMemory().l0, ...parsed.l0 } };
  } catch {
    memoryCache = defaultMemory();
  }
  return memoryCache;
}

function saveMemory(): void {
  if (!memoryCache) return;
  try {
    fs.mkdirSync(path.dirname(memoryPath()), { recursive: true });
    fs.writeFileSync(memoryPath(), JSON.stringify(memoryCache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Memory] failed to save:', err);
  }
}

export function clearMemory(): void {
  memoryCache = defaultMemory();
  saveMemory();
}

// ---------- 工具 ----------

function uid(): string {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function stripPolarity(text: string): string {
  return text
    .replace(/非常|特别|超级|最|很|有点|有点儿|不太|越来越/g, '')
    .replace(/不喜欢|讨厌|害怕|抗拒|厌恶|反感|受不了|喜欢|热爱|中意|想要|希望|期待|感兴趣|爱/g, '')
    .trim();
}

function polarity(text: string): number {
  if (/不喜欢|讨厌|害怕|抗拒|厌恶|反感|受不了|恨|烦/.test(text)) return -1;
  if (/喜欢|爱|想要|热爱|中意|希望|期待|感兴趣/.test(text)) return 1;
  return 0;
}

/** 检查两段文本是否有重叠的 2 字中文片段（用于判断是否在说同一件事） */
function sharesBigram(a: string, b: string): boolean {
  const x = stripPolarity(a);
  const y = stripPolarity(b);
  if (!x || !y) return false;
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    if (/[\u4e00-\u9fa5]{2}/.test(g) && y.includes(g)) return true;
  }
  return false;
}

function pushUnique(list: string[], item: string, max = 20): void {
  const v = item.trim();
  if (!v || v.length < 2) return;
  if (list.some((x) => x === v || x.includes(v) || v.includes(x))) return;
  list.push(v);
  if (list.length > max) list.splice(0, list.length - max);
}

// ---------- 启发式提取（不依赖 LLM，保证离线也能记） ----------

function heuristicExtract(userText: string): { l0: Partial<L0Profile>; l2: L2Memory[]; goals: string[]; relations: RelationEdge[] } {
  const l0: Partial<L0Profile> = {};
  const l2: L2Memory[] = [];
  const goals: string[] = [];
  const relations: RelationEdge[] = [];
  const now = Date.now();

  // L0：名字
  const nameM = userText.match(/我(?:的名字(?:叫|是)|叫|名字叫|名唤)\s*([\u4e00-\u9fa5A-Za-z·]{1,12})/);
  if (nameM && !/^我|你|他|她|它|芙宁娜/.test(nameM[1])) l0.name = nameM[1].trim();

  // L0：年龄
  const ageM = userText.match(/(?:今年|已经|现在)?\s*(\d{1,2})\s*岁/);
  if (ageM) l0.age = ageM[1] + '岁';

  // L0：职业
  const occM = userText.match(/我(?:是一名|是个|是一位|的职业是|从事)\s*([\u4e00-\u9fa5A-Za-z]{2,12})/);
  if (occM) l0.occupation = occM[1].trim();

  // 喜好（L0 interests + L2 preference）
  const likeRe = /(?:我最喜欢|我(?:本人)?(?:很|非常|特别|超)?喜欢|我爱(?:好|吃|喝|看|玩|听)?)\s*([^，。！？；、\s]{1,24})/g;
  let lm: RegExpExecArray | null;
  while ((lm = likeRe.exec(userText)) !== null) {
    const item = lm[1].replace(/和|还有|以及$/, '').trim();
    if (item && item.length >= 2 && !/不过|但是|其实/.test(item)) {
      l2.push({ id: uid(), content: `用户喜欢${item}`, category: 'preference', createdAt: now, lastAccessedAt: now, accessCount: 0, conflictWith: [], source: 'user', pinned: false });
    }
  }

  // 雷区（L0 dislikes + L2 preference）
  const dislikeRe = /(?:我最?不喜欢|我不?喜欢|我讨厌|我(?:很|非常)?讨厌|最讨厌)\s*([^，。！？；、\s]{1,24})/g;
  let dm: RegExpExecArray | null;
  while ((dm = dislikeRe.exec(userText)) !== null) {
    const item = dm[1].trim();
    if (item && item.length >= 2) {
      l2.push({ id: uid(), content: `用户不喜欢${item}`, category: 'preference', createdAt: now, lastAccessedAt: now, accessCount: 0, conflictWith: [], source: 'user', pinned: false });
    }
  }

  // 目标/计划（L1 goals）
  const goalRe = /我(?:想|打算|准备|计划|要)(去|做|学|买|考|成为|减肥|坚持|攒钱)?\s*([^，。！？；、\s]{2,24})/g;
  let gm: RegExpExecArray | null;
  while ((gm = goalRe.exec(userText)) !== null) {
    const g = ((gm[1] ?? '') + gm[2]).trim();
    if (g && g.length >= 2) goals.push(g);
  }

  // 关系（实体图谱）：我的同学/朋友/家人等
  const relRe = /我的(爸爸|妈妈|父亲|母亲|弟弟|妹妹|哥哥|姐姐|爷爷|奶奶|外公|外婆|同学|朋友|室友|同事|老师|老板|上司|闺蜜|兄弟|男朋友|女朋友|对象|宠物|猫|狗|弟弟妹妹)(?:名字?)?(?:叫|是|有|养了|养着)?\s*([\u4e00-\u9fa5A-Za-z]{1,8})/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(userText)) !== null) {
    const who = rm[2]?.trim();
    if (who && who.length >= 1 && !/^我|你|他|她|它|吗|呢/.test(who)) {
      relations.push({ from: '用户', to: who, relation: rm[1], createdAt: now });
    }
  }
  // 宠物
  const petM = userText.match(/我(?:养|有)(?:了|只|条|一只|一条|只小|条小)?\s*(猫|狗|兔子|仓鼠|鸟|鱼|乌龟|宠物)/);
  if (petM) relations.push({ from: '用户', to: petM[1], relation: '饲养', createdAt: now });

  return { l0, l2, goals, relations };
}

// ---------- LLM 提取（后台尽力而为，失败回退启发式） ----------

interface LlmExtractResult {
  memories: Array<{ content: string; category: string }>;
  relations: Array<{ from: string; relation: string; to: string }>;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function llmExtract(userText: string, assistantText: string): Promise<LlmExtractResult | null> {
  const system = [
    '你是芙宁娜桌宠的记忆整理助手。',
    '从用户发言中提取值得长期记住的信息，只输出 JSON，不要任何多余文字。',
    'memories 中每条用第三人称陈述（如“用户喜欢喝咖啡”）。',
    'relations 表示用户与其他人/物的关系（如 from=用户 relation=同学 to=小明）。',
  ].join('\n');
  const user = [
    `用户说：${userText.slice(0, 400)}`,
    `芙宁娜回应：${assistantText.slice(0, 400)}`,
    '输出 JSON：{"memories":[{"content":"...","category":"fact|preference|event|relationship"}],"relations":[{"from":"...","relation":"...","to":"..."}]}',
    '没有值得记的就给空数组。',
  ].join('\n');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const raw = await streamDeepSeek(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        () => { /* 只要完整输出 */ },
        controller.signal,
      );
      const obj = extractJson(raw) as LlmExtractResult | null;
      if (!obj || !Array.isArray(obj.memories)) return null;
      return {
        memories: obj.memories
          .filter((m: unknown) => m && typeof (m as { content?: unknown }).content === 'string')
          .slice(0, 6) as Array<{ content: string; category: string }>,
        relations: Array.isArray(obj.relations) ? (obj.relations as Array<{ from: string; relation: string; to: string }>).slice(0, 10) : [],
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error('[Memory] LLM 提取失败（回退启发式）:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ---------- 冲突检测 ----------

function detectConflict(existing: L2Memory[], fresh: L2Memory): string[] {
  const conflicts: string[] = [];
  const p = polarity(fresh.content);
  if (p === 0) return conflicts;
  for (const old of existing) {
    if (old.id === fresh.id) continue;
    const op = polarity(old.content);
    if (op !== 0 && op !== p && sharesBigram(old.content, fresh.content)) {
      conflicts.push(old.id);
    }
  }
  return conflicts;
}

// ---------- 写入 ----------

function mergeL0(patch: Partial<L0Profile>): void {
  const data = loadMemory();
  if (patch.name && !data.l0.name) data.l0.name = patch.name;
  if (patch.age && !data.l0.age) data.l0.age = patch.age;
  if (patch.occupation && !data.l0.occupation) data.l0.occupation = patch.occupation;
}

function mergeL2(candidates: L2Memory[]): void {
  const data = loadMemory();
  for (const c of candidates) {
    const content = c.content.trim();
    if (!content || content.length < 4) continue;
    if (data.l2.some((m) => m.content === content)) continue;
    // 冲突检测
    const conflicts = detectConflict(data.l2, { ...c, content });
    if (conflicts.length > 0) {
      c.conflictWith = conflicts;
      for (const id of conflicts) {
        data.conflicts.push({ a: content, b: data.l2.find((m) => m.id === id)?.content ?? '?', reason: '新旧信息矛盾（喜好/态度变化）', at: Date.now() });
      }
    }
    data.l2.push(c);
  }
  // 裁剪：最多保留 100 条长期记忆
  if (data.l2.length > 100) data.l2 = data.l2.slice(-100);
}

function mergeRelations(relations: RelationEdge[]): void {
  const data = loadMemory();
  const node = (name: string, type: EntityNode['type']): void => {
    if (!name || name === '用户') return;
    if (!data.entities.some((e) => e.name === name)) {
      data.entities.push({ id: uid(), name, type });
    }
  };
  for (const r of relations) {
    if (!r.from || !r.to || !r.relation) continue;
    node(r.from, 'person');
    node(r.to, 'person');
    if (!data.relations.some((e) => e.from === r.from && e.to === r.to && e.relation === r.relation)) {
      data.relations.push({ ...r, createdAt: Date.now() });
    }
  }
}

/** 对话每轮结束后调用：异步提取并写入记忆（内部不抛错） */
export async function rememberFromTurn(userText: string, assistantText: string): Promise<void> {
  try {
    const text = (userText ?? '').trim();
    if (!text) return;

    const data = loadMemory();
    data.l1.sessionCount += 1;
    data.l1.lastConversationAt = Date.now();
    pushUnique(data.l1.recentTopics, text.slice(0, 50), 8);

    // 1) 启发式（离线可用）
    const heuristic = heuristicExtract(text);

    // 2) LLM 增强（有 API Key 时后台跑）
    const llm = await llmExtract(text, assistantText ?? '');

    // L0
    const l0Patch = { ...heuristic.l0 };
    if (l0Patch.name || l0Patch.age || l0Patch.occupation) mergeL0(l0Patch);
    // 喜好/雷区进 L0（合并到列表）
    for (const m of heuristic.l2) {
      if (m.content.startsWith('用户喜欢')) pushUnique(data.l0.interests, m.content.replace('用户喜欢', ''), 12);
      if (m.content.startsWith('用户不喜欢')) pushUnique(data.l0.dislikes, m.content.replace('用户不喜欢', ''), 12);
    }

    // L2：启发式 + LLM
    const candidates: L2Memory[] = [...heuristic.l2];
    if (llm) {
      for (const m of llm.memories) {
        const cat = (['fact', 'preference', 'event', 'relationship'] as const).includes(m.category as MemoryCategory)
          ? (m.category as MemoryCategory)
          : 'fact';
        candidates.push({
          id: uid(),
          content: m.content,
          category: cat,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          accessCount: 0,
          conflictWith: [],
          source: 'inferred',
          pinned: false,
        });
      }
    }
    mergeL2(candidates);

    // 关系图谱：启发式 + LLM
    const relations: RelationEdge[] = [...heuristic.relations];
    if (llm) {
      for (const r of llm.relations) {
        if (r.from && r.to && r.relation) relations.push({ from: r.from, to: r.to, relation: r.relation, createdAt: Date.now() });
      }
    }
    mergeRelations(relations);

    // L1 目标
    for (const g of heuristic.goals) pushUnique(data.l1.recentGoals, g, 6);

    saveMemory();
    console.log(`[Memory] 已记忆：L2=${data.l2.length} 实体=${data.entities.length} 关系=${data.relations.length} 冲突=${data.conflicts.length}`);
  } catch (err) {
    console.error('[Memory] 记忆写入失败:', err);
  }
}

// ---------- 提示词注入 ----------

/** 把记忆整理成系统提示词片段（空记忆返回空串） */
export function buildMemoryContext(): string {
  const data = loadMemory();
  const sections: string[] = [];

  const l0 = data.l0;
  const core: string[] = [];
  if (l0.name) core.push(`名字：${l0.name}`);
  if (l0.age) core.push(`年龄：${l0.age}`);
  if (l0.occupation) core.push(`职业：${l0.occupation}`);
  if (l0.interests.length > 0) core.push(`喜好：${l0.interests.slice(0, 8).join('、')}`);
  if (l0.dislikes.length > 0) core.push(`雷区：${l0.dislikes.slice(0, 8).join('、')}`);
  if (core.length > 0) sections.push(`【核心画像】${core.join('；')}`);

  if (data.l1.recentTopics.length > 0) {
    sections.push(`【近期动态】最近聊过：${data.l1.recentTopics.slice(-4).join('、')}`);
  }
  if (data.l1.recentGoals.length > 0) {
    sections.push(`【近期目标】${data.l1.recentGoals.slice(-4).join('、')}`);
  }

  // 取最相关的长期记忆（近期访问优先），并累计访问次数
  const ranked = [...data.l2].sort((a, b) => {
    const sa = a.lastAccessedAt + a.createdAt * 0.2;
    const sb = b.lastAccessedAt + b.createdAt * 0.2;
    return sb - sa;
  });
  const top = ranked.slice(0, 5);
  for (const m of top) {
    m.accessCount += 1;
    m.lastAccessedAt = Date.now();
  }
  if (top.length > 0) {
    sections.push(`【长期记忆】\n${top.map((m) => `- ${m.content}`).join('\n')}`);
  }
  if (data.relations.length > 0) {
    sections.push(`【人物关系】${data.relations.slice(-6).map((r) => `${r.from}·${r.relation}·${r.to}`).join('；')}`);
  }
  if (sections.length === 0) return '';
  return `## 关于用户的记忆（来自记忆系统，融入言行即可，不要复述清单）\n${sections.join('\n')}`;
}

// ---------- 对外信息（设置界面展示） ----------

export interface MemoryInfo {
  name?: string;
  age?: string;
  occupation?: string;
  interests: string[];
  dislikes: string[];
  topics: string[];
  goals: string[];
  l2Count: number;
  relationCount: number;
  recentL2: Array<{ content: string; category: string; createdAt: number }>;
}

export function getMemoryInfo(): MemoryInfo {
  const data = loadMemory();
  return {
    name: data.l0.name,
    age: data.l0.age,
    occupation: data.l0.occupation,
    interests: data.l0.interests.slice(0, 12),
    dislikes: data.l0.dislikes.slice(0, 12),
    topics: data.l1.recentTopics.slice(-6),
    goals: data.l1.recentGoals.slice(-6),
    l2Count: data.l2.length,
    relationCount: data.relations.length,
    recentL2: [...data.l2]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8)
      .map((m) => ({ content: m.content, category: m.category, createdAt: m.createdAt })),
  };
}
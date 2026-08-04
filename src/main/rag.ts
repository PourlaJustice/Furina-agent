// RAG 知识库检索管线
//
// 文档导入 → 自动分块 → 本地向量化（BGE-small-zh，失败自动降级纯关键词）→
// 混合检索（语义向量 + BM25 关键词）→ RRF 融合 + 轻量重排 →
// Worldbook 动态知识激活（永久/关键词/语义）→ 供系统提示词注入。
//
// 数据持久化：userData/knowledge-index.json（chunks + embeddings）
// 知识文件：项目根目录 knowledge/ 下的 txt/md/json/csv，启动时自动索引。

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { loadTtsConfig } from './tts';
import { parseFileText, SUPPORTED_EXT } from './doc-parsers';
const CHUNK_SIZE = 500;      // 每块约 500 字符
const CHUNK_OVERLAP = 50;    // 相邻块重叠 50 字符，避免跨段断义
const EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5';
const K1 = 1.5;
const B = 0.75;

// ---------- 类型 ----------

export interface KnowledgeChunk {
  id: string;
  file: string;
  text: string;
}

export interface IndexedFile {
  path: string;
  name: string;
  size: number;
  chunkCount: number;
  indexedAt: number;
}

export type WorldbookMode = 'permanent' | 'cascade' | 'contextual';

export interface WorldbookEntry {
  id: string;
  mode: WorldbookMode;
  keywords?: string[];
  content: string;
}

export interface RagResult {
  chunks: KnowledgeChunk[];
  worldbook: WorldbookEntry[];
}

interface IndexState {
  files: IndexedFile[];
  chunks: KnowledgeChunk[];
  embeddings: number[][] | null;
  ready: boolean;
}

// ---------- 状态与持久化 ----------

let state: IndexState = { files: [], chunks: [], embeddings: null, ready: false };
let bm25Index: { perDoc: string[][]; df: Map<string, number>; dl: number[]; N: number; avgdl: number } | null = null;
let worldbook: WorldbookEntry[] = [];

function indexPath(): string {
  return path.join(app.getPath('userData'), 'knowledge-index.json');
}

function loadState(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(), 'utf-8')) as IndexState;
    state = {
      files: raw.files ?? [],
      chunks: raw.chunks ?? [],
      embeddings: Array.isArray(raw.embeddings) ? raw.embeddings : null,
      ready: Boolean(raw.ready),
    };
  } catch {
    state = { files: [], chunks: [], embeddings: null, ready: false };
  }
  rebuildBm25();
}

function saveState(): void {
  try {
    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify({ files: state.files, chunks: state.chunks, embeddings: state.embeddings, ready: state.ready }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[RAG] 保存索引失败:', err);
  }
}

// ---------- 文本处理 ----------

function chunkText(text: string, file: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length < 5) return chunks;
  const step = CHUNK_SIZE - CHUNK_OVERLAP;
  let i = 0;
  while (i < clean.length) {
    const end = Math.min(i + CHUNK_SIZE, clean.length);
    const piece = clean.slice(i, end).trim();
    if (piece.length >= 5) {
      chunks.push({ id: `${file}#${i}`, file: path.basename(file), text: piece });
    }
    if (end >= clean.length) break;
    i += step;
  }
  return chunks;
}

/** 中文按相邻双字 + 英文/数字按单词切分（无需外部分词依赖） */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const norm = text.toLowerCase();
  const ascii = norm.match(/[a-z0-9_]+/g);
  if (ascii) tokens.push(...ascii);
  const han = norm.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < han.length - 1; i++) tokens.push(han.slice(i, i + 2));
  return tokens;
}

// ---------- BM25 关键词检索 ----------

function rebuildBm25(): void {
  const chunks = state.chunks;
  const perDoc: string[][] = [];
  const dl: number[] = [];
  const df = new Map<string, number>();
  for (const c of chunks) {
    const toks = tokenize(c.text);
    perDoc.push(toks);
    dl.push(toks.length);
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = chunks.length;
  const avgdl = N > 0 ? dl.reduce((a, b) => a + b, 0) / N : 0;
  bm25Index = { perDoc, df, dl, N, avgdl };
}

function bm25Score(query: string, chunkIdx: number): number {
  const idx = bm25Index;
  if (!idx || idx.N === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of idx.perDoc[chunkIdx]) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const t of tokenize(query)) {
    const n = tf.get(t) ?? 0;
    if (n === 0) continue;
    const idf = Math.log(1 + (idx.N - (idx.df.get(t) ?? 0) + 0.5) / ((idx.df.get(t) ?? 0) + 0.5));
    score += (idf * n * (K1 + 1)) / (n + K1 * (1 - B + (B * idx.dl[chunkIdx]) / Math.max(1, idx.avgdl)));
  }
  return score;
}

// ---------- 向量化（BGE-small-zh，失败自动降级） ----------

let extractor: unknown = null;
let embeddingState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let semanticProvider: 'local' | 'minimax' | 'none' = 'none';

/** MiniMax API Key：复用语音配置，或环境变量 MINIMAX_API_KEY */
function getMiniMaxKey(): string {
  return loadTtsConfig().apiKey || process.env.MINIMAX_API_KEY || '';
}

/** MiniMax 向量接口（本地模型不可用时的语义检索兜底） */
async function embedMiniMax(texts: string[], type: 'db' | 'query' = 'db'): Promise<number[][]> {
  const key = getMiniMaxKey();
  if (!key) return [];
  try {
    const resp = await fetch('https://api.minimaxi.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'embo-01', texts, type }),
    });
    const data = (await resp.json()) as { vectors?: number[][] };
    const vectors = data.vectors ?? [];
    if (vectors.length > 0 && semanticProvider === 'none') {
      semanticProvider = 'minimax';
      embeddingState = 'ready';
      console.log('[RAG] 语义检索使用 MiniMax 向量接口');
    }
    return vectors;
  } catch (err) {
    console.error('[RAG] MiniMax 向量化失败:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function getExtractor(): Promise<unknown | null> {
  if (extractor) return extractor;
  if (embeddingState === 'failed') return null;
  if (embeddingState === 'loading') return null; // 加载中，先跳过
  embeddingState = 'loading';
  try {
    const mod = (await import('@xenova/transformers')) as {
      env: { remoteHost?: string; remotePathTemplate?: string; cacheDir?: string };
      pipeline: (task: string, model: string) => Promise<unknown>;
    };
    // ★ 从 ModelScope（阿里，国内直连）下载模型，避免 HuggingFace 被墙
    mod.env.remoteHost = 'https://modelscope.cn/';
    mod.env.remotePathTemplate = 'models/{model}/resolve/{revision}/';
    mod.env.cacheDir = path.join(app.getPath('userData'), 'models');
    extractor = await mod.pipeline('feature-extraction', EMBEDDING_MODEL);
    embeddingState = 'ready';
    semanticProvider = 'local';
    console.log('[RAG] 向量模型已就绪:', EMBEDDING_MODEL);
    // 本地模型就绪后，检查存量向量是否与当前模型维度一致，不一致则重新向量化
    void ensureEmbeddingConsistency();
    return extractor;
  } catch (err) {
    embeddingState = 'failed';
    console.error('[RAG] 向量模型加载失败，降级为纯关键词检索:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function embedTexts(texts: string[], type: 'db' | 'query' = 'db'): Promise<number[][]> {
  if (texts.length === 0) return [];
  // 1) 本地模型（HF 模型，下载成功时使用）
  const ex = await getExtractor();
  if (ex) {
    try {
      const out = (await (ex as (t: string[], o: unknown) => Promise<{ data: Float32Array; dims: number[] }>)(
        texts,
        { pooling: 'mean', normalize: true },
      )) as { data: Float32Array; dims: number[] };
      const dims = out.dims;
      const dim = dims[dims.length - 1] ?? 0;
      if (dim > 0) {
        const n = Math.min(texts.length, Math.floor(out.data.length / dim));
        const vectors: number[][] = [];
        for (let i = 0; i < n; i++) {
          vectors.push(Array.from(out.data.slice(i * dim, (i + 1) * dim)));
        }
        if (vectors.length > 0) return vectors;
      }
    } catch {
      // 本地模型失败 → 走 MiniMax
    }
  }
  // 2) MiniMax API 兜底
  return embedMiniMax(texts, type);
}

/** 本地模型维度（bge-small-zh 为 512 维） */
const LOCAL_EMBED_DIM = 512;

/**
 * 检查存量向量是否与当前模型一致；不一致（例如之前用 MiniMax 接口生成）时，
 * 用本地模型重新向量化全部分块，保证语义检索维度统一。
 */
async function ensureEmbeddingConsistency(): Promise<void> {
  if (state.chunks.length === 0) return;
  const needRebuild =
    !state.embeddings ||
    state.embeddings.length !== state.chunks.length ||
    state.embeddings.some((v) => !v || v.length !== LOCAL_EMBED_DIM);
  if (!needRebuild) return;
  console.log(`[RAG] 检测到向量维度不一致，用本地模型重新向量化 ${state.chunks.length} 个分块…`);
  const vectors = await embedTexts(state.chunks.map((c) => c.text), 'db');
  if (vectors.length === state.chunks.length) {
    state.embeddings = vectors;
    state.ready = true;
    saveState();
    console.log('[RAG] 向量重建完成');
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 文档导入与索引 ----------

function collectFiles(target: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(target)) return out;
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(target);
  return out;
}

/** 给指定分块补向量并保存（后台执行，不阻塞） */
async function embedChunks(chunks: KnowledgeChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const vectors = await embedTexts(chunks.map((c) => c.text));
  if (vectors.length === 0) return;
  if (!state.embeddings) state.embeddings = [];
  // 按分块顺序对齐追加（幂等：按 chunks 数量）
  while (state.embeddings.length < state.chunks.length) {
    state.embeddings.push(new Array(vectors[0].length).fill(0));
  }
  const offset = state.chunks.length - chunks.length;
  for (let i = 0; i < vectors.length; i++) {
    state.embeddings[offset + i] = vectors[i];
  }
  saveState();
  console.log(`[RAG] 已向量化 ${chunks.length} 个分块`);
}

/** 导入一个文件或文件夹（txt/md/json/csv） */
export async function importKnowledgePath(target: string): Promise<{ imported: number; chunks: number; skipped: string[] }> {
  if (!state.ready) loadState();
  const files = collectFiles(target);
  const skipped: string[] = [];
  const newChunks: KnowledgeChunk[] = [];
  let imported = 0;
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) {
      skipped.push(`${path.basename(f)}（不支持 ${ext}）`);
      continue;
    }
    if (state.files.some((x) => x.path === f)) {
      skipped.push(`${path.basename(f)}（已导入）`);
      continue;
    }
    try {
      const text = await parseFileText(f);
      if (!text || text.trim().length < 10) {
        skipped.push(`${path.basename(f)}（内容为空）`);
        continue;
      }
      const chunks = chunkText(text, f);
      newChunks.push(...chunks);
      state.files.push({ path: f, name: path.basename(f), size: fs.statSync(f).size, chunkCount: chunks.length, indexedAt: Date.now() });
      imported += 1;
    } catch (err) {
      skipped.push(`${path.basename(f)}（读取失败）`);
      console.error('[RAG] 导入失败:', f, err);
    }
  }
  if (newChunks.length > 0) {
    const base = state.chunks.length;
    state.chunks.push(...newChunks);
    // 为旧分块先补零占位，保证对齐；向量在后台补齐
    if (!state.embeddings) state.embeddings = [];
    while (state.embeddings.length < state.chunks.length) state.embeddings.push([]);
    rebuildBm25();
    saveState();
    void embedChunks(newChunks).then(() => {
      state.ready = true;
    }).catch(() => {
      state.ready = true;
    });
    state.ready = true;
    console.log(`[RAG] 导入 ${imported} 个文件，新增 ${newChunks.length} 个分块`);
  }
  return { imported, chunks: newChunks.length, skipped };
}

// ---------- Worldbook 动态知识激活 ----------

function loadWorldbook(): void {
  try {
    const p = path.join(app.getAppPath(), 'knowledge', 'worldbook.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { entries?: WorldbookEntry[] } | WorldbookEntry[];
    worldbook = Array.isArray(data) ? data : (data.entries ?? []);
    console.log(`[RAG] Worldbook 加载 ${worldbook.length} 条`);
  } catch {
    worldbook = [];
  }
}

async function activateWorldbook(query: string): Promise<WorldbookEntry[]> {
  const active: WorldbookEntry[] = [];
  const q = query.trim();
  for (const e of worldbook) {
    if (e.mode === 'permanent') {
      active.push(e);
      continue;
    }
    if (e.mode === 'cascade' && e.keywords?.some((k) => q.includes(k))) {
      active.push(e);
      continue;
    }
    if (e.mode === 'contextual' && q.length >= 4 && state.embeddings && state.embeddings.length > 0) {
      const qv = await embedTexts([q], 'query');
      const ev = await embedTexts([e.content], 'db');
      if (qv.length && ev.length && cosine(qv[0], ev[0]) >= 0.45) {
        active.push(e);
      }
    }
  }
  return active;
}

// ---------- 混合检索 ----------

function rrfScore(rankedLists: number[][], k = 60): Map<number, number> {
  const scores = new Map<number, number>();
  rankedLists.forEach((list) => {
    list.forEach((idx, rank) => {
      scores.set(idx, (scores.get(idx) ?? 0) + 1 / (k + rank + 1));
    });
  });
  return scores;
}

/**
 * 混合检索：BM25 关键词（同步）+ 语义向量（异步，超时降级）→ RRF 融合 → 轻量重排。
 */
export async function retrieveKnowledge(query: string, topK = 5, timeoutMs = 2500): Promise<RagResult> {
  if (!state.ready) loadState();
  const chunks = state.chunks;
  const result: RagResult = { chunks: [], worldbook: [] };
  if (chunks.length === 0) {
    result.worldbook = await activateWorldbook(query);
    return result;
  }

  // 1) BM25（同步）
  const bmScores: Array<{ idx: number; s: number }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const s = bm25Score(query, i);
    if (s > 0) bmScores.push({ idx: i, s });
  }
  bmScores.sort((a, b) => b.s - a.s);
  const bmTop = bmScores.slice(0, Math.min(12, bmScores.length)).map((x) => x.idx);

  // 2) 语义向量（异步，超时降级）
  let semTop: number[] = [];
  if (state.embeddings && state.embeddings.length === chunks.length) {
    try {
      const qv = await Promise.race([embedTexts([query], 'query'), sleep(timeoutMs).then(() => [] as number[][])]);
      if (qv.length === 1 && qv[0].length > 0) {
        const sims: Array<{ idx: number; s: number }> = [];
        for (let i = 0; i < chunks.length; i++) {
          const ev = state.embeddings[i];
          if (ev && ev.length > 0) sims.push({ idx: i, s: cosine(qv[0], ev) });
        }
        sims.sort((a, b) => b.s - a.s);
        semTop = sims.slice(0, Math.min(12, sims.length)).map((x) => x.idx);
      }
    } catch {
      // 向量失败不影响关键词检索
    }
  }

  // 3) RRF 融合
  const lists: number[][] = [];
  if (bmTop.length > 0) lists.push(bmTop);
  if (semTop.length > 0) lists.push(semTop);
  const fused = rrfScore(lists);

  // 4) 轻量重排：RRF 为主，辅以原始分数归一化
  const bmMax = bmScores.length > 0 ? bmScores[0].s : 1;
  const scored: Array<{ idx: number; score: number }> = [];
  for (const [idx, r] of fused) {
    const bmRaw = bmScores.find((x) => x.idx === idx)?.s ?? 0;
    scored.push({ idx, score: r * 0.6 + (bmRaw / bmMax) * 0.4 });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, Math.max(1, topK)).map((x) => x.idx);
  result.chunks = picked.map((i) => chunks[i]);

  // ★ 个人资料文件（简历等）始终优先注入，确保芙宁娜认识用户本人
  const personalNames = state.files
    .filter((f) => /简历|resume|cv|个人信息|自我介绍|个人简介/i.test(f.name))
    .map((f) => f.name);
  if (personalNames.length > 0) {
    const allPersonal = state.chunks.filter((c) => personalNames.includes(c.file));
    const seen = new Set(result.chunks.map((c) => c.id));
    const added = allPersonal.filter((c) => !seen.has(c.id)).slice(0, 4);
    result.chunks = [...added, ...result.chunks].slice(0, Math.max(topK, 6));
  }

  // 5) Worldbook 激活
  result.worldbook = await activateWorldbook(query);
  return result;
}

// ---------- 状态与清空 ----------

export interface KnowledgeStatus {
  files: Array<{ name: string; chunkCount: number }>;
  chunkCount: number;
  embedding: string;
  provider: 'local' | 'minimax' | 'none';
  worldbookCount: number;
}

export function getKnowledgeStatus(): KnowledgeStatus {
  if (!state.ready) loadState();
  return {
    files: state.files.map((f) => ({ name: f.name, chunkCount: f.chunkCount })),
    chunkCount: state.chunks.length,
    embedding: embeddingState,
    provider: semanticProvider,
    worldbookCount: worldbook.length,
  };
}

export function clearKnowledge(): KnowledgeStatus {
  state = { files: [], chunks: [], embeddings: null, ready: true };
  bm25Index = null;
  saveState();
  return getKnowledgeStatus();
}

/** 启动时自动索引 knowledge/ 目录并加载 Worldbook */
export async function initKnowledgeBase(): Promise<void> {
  loadState();
  loadWorldbook();
  try {
    const knowledgeDir = path.join(app.getAppPath(), 'knowledge');
    if (fs.existsSync(knowledgeDir)) {
      const r = await importKnowledgePath(knowledgeDir);
      console.log(`[RAG] 启动索引完成：导入 ${r.imported} 个文件（跳过 ${r.skipped.length}），共 ${state.chunks.length} 个分块`);
    }
  } catch (err) {
    console.error('[RAG] 启动索引失败:', err);
  }
  // 自检：跑一个示例查询验证管线
  setTimeout(() => {
    void retrieveKnowledge('甜点 歌剧', 3).then((res) => {
      console.log('[RAG] 自检查询「甜点 歌剧」→', res.chunks.length ? `命中《${res.chunks[0].file}》` : '无命中', '| Worldbook:', res.worldbook.length);
    }).catch(() => { /* ignore */ });
  }, 4000);
}
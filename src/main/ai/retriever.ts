import { app } from 'electron';
import path from 'node:path';
import { HuggingFaceTransformersEmbeddings } from '@langchain/community/embeddings/huggingface_transformers';
import { BaseRetriever } from '@langchain/core/retrievers';
import type { PretrainedOptions } from '@huggingface/transformers';
import { Document } from '@langchain/core/documents';
import type { DocumentInterface } from '@langchain/core/documents';
import { retrieveKnowledge, setQueryEmbedder } from '../rag';

const EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5';

let embedder: HuggingFaceTransformersEmbeddings | null = null;
let embedderPromise: Promise<HuggingFaceTransformersEmbeddings | null> | null = null;

function localModelDir(): string {
  return path.join(app.getPath('userData'), 'models', 'Xenova', 'bge-small-zh-v1.5');
}

/**
 * 路线 B：LangChain 原生嵌入模型（HuggingFaceTransformersEmbeddings），
 * 直接指向本地已下载的模型目录离线加载，完全不访问 HuggingFace。
 */
export function createLangChainEmbedder(): Promise<HuggingFaceTransformersEmbeddings | null> {
  if (embedder) return Promise.resolve(embedder);
  if (embedderPromise) return embedderPromise;
  embedderPromise = (async () => {
    try {
      // 先配置 transformers.js 环境：缓存目录指向本地模型、远程源用 ModelScope 兜底
      const hf = await import('@huggingface/transformers');
      hf.env.cacheDir = path.join(app.getPath('userData'), 'models');
      hf.env.remoteHost = 'https://modelscope.cn/';
      hf.env.remotePathTemplate = 'models/{model}/resolve/{revision}/';
      const emb = new HuggingFaceTransformersEmbeddings({
        model: EMBEDDING_MODEL,
        batchSize: 32,
        pretrainedOptions: {
          local_files_only: true,
          cache_dir: path.join(app.getPath('userData'), 'models'),
          dtype: 'q8',
        } as unknown as PretrainedOptions,
      });
      // 预热：确认本地模型可离线加载，失败则返回 null 让旧路径接管
      await emb.embedQuery('预热');
      embedder = emb;
      console.log('[LangChain] 本地嵌入模型就绪（离线）:', localModelDir());
      return emb;
    } catch (err) {
      embedderPromise = null;
      console.error(
        '[LangChain] 本地嵌入模型加载失败，回退旧嵌入路径:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  })();
  return embedderPromise;
}

/** 初始化：把 LangChain 原生嵌入注册为知识库语义检索提供方 */
export async function initLangChainEmbeddings(): Promise<void> {
  const emb = await createLangChainEmbedder();
  if (!emb) return;
  setQueryEmbedder(async (texts, type) => {
    try {
      return type === 'query'
        ? [await emb.embedQuery(texts[0] ?? '')]
        : await emb.embedDocuments(texts);
    } catch (err) {
      console.error('[LangChain] 嵌入调用失败:', err instanceof Error ? err.message : String(err));
      return [];
    }
  });
}

/** 知识库 Retriever（标准 LangChain 接口），后续可自由接入链/图 */
export class RagRetriever extends BaseRetriever {
  lc_namespace = ['furina', 'rag'];
  private topK: number;

  constructor(topK = 5) {
    super({});
    this.topK = topK;
  }

  async _getRelevantDocuments(query: string): Promise<DocumentInterface[]> {
    const res = await retrieveKnowledge(query, this.topK);
    return res.chunks.map(
      (c) =>
        new Document({
          pageContent: c.text,
          metadata: { id: c.id, file: c.file, source: c.file },
        }),
    );
  }
}

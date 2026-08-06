import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { AGENT_TOOLS, confirmGate, toolDesc } from '../agent';
import { mcpManager } from './mcp';
import { retrieveKnowledge } from '../rag';

export type ToolStatusHandler = (
  name: string,
  status: 'start' | 'done' | 'blocked' | 'error',
  summary: string,
) => void;

let statusHandler: ToolStatusHandler | null = null;

/** 注册工具进度回调（LangGraph 执行期间由 index.ts 注入） */
export function setToolStatusHandler(handler: ToolStatusHandler | null): void {
  statusHandler = handler;
}

const MAX_TOOL_OUTPUT = 4000;

/** 递归转换单个属性：支持 string/number/boolean/object/array（修复 screen_shot 的 region 等嵌套参数） */
function propSchema(prop: Record<string, unknown>): z.ZodTypeAny {
  const type = prop.type;
  let field: z.ZodTypeAny;
  if (type === 'object') {
    const shape: Record<string, z.ZodTypeAny> = {};
    const props = (prop.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set<string>(Array.isArray(prop.required) ? (prop.required as string[]) : []);
    for (const [key, child] of Object.entries(props)) {
      const childSchema = propSchema(child);
      shape[key] = required.has(key) ? childSchema : childSchema.optional();
    }
    field = z.object(shape);
  } else if (type === 'array') {
    field = z.array(propSchema((prop.items ?? { type: 'string' }) as Record<string, unknown>));
  } else if (type === 'number' || type === 'integer') {
    field = z.number();
  } else if (type === 'boolean') {
    field = z.boolean();
  } else {
    field = z.string();
  }
  if (typeof prop.description === 'string') field = field.describe(prop.description);
  return field;
}

/** 把现有工具定义里的 JSON Schema 参数转换为 zod schema（LangChain 工具要求） */
function jsonSchemaToZod(params: Record<string, unknown>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const props = (params.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set<string>(Array.isArray(params.required) ? (params.required as string[]) : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const field = propSchema(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape);
}

/** 知识库检索工具：让 LangGraph Agent 在需要时主动查知识库 */
const knowledgeSearchTool = tool(
  async ({ query }: { query: string }) => {
    const res = await retrieveKnowledge(query, 5);
    if (res.chunks.length === 0) return '知识库中没有检索到相关内容';
    return res.chunks.map((c) => `- 《${c.file}》：${c.text.slice(0, 300)}`).join('\n');
  },
  {
    name: 'knowledge_search',
    description: '检索芙宁娜的知识库（原神剧情、角色资料、用户导入的文档），回答剧情/角色/用户文档相关问题时可调用',
    schema: z.object({ query: z.string().describe('要检索的关键词或问题') }),
  },
);

/** 构建 LangChain 工具列表：现有 9 个工具 + 知识库检索 */
export function buildLangChainTools(): StructuredTool[] {
  const allTools = [...AGENT_TOOLS, ...mcpManager.toToolDefs()];
  const converted = allTools.map((t) =>
    tool(
      async (args: Record<string, unknown>) => {
        try {
          statusHandler?.(t.name, 'start', `正在${toolDesc(t.name)}…`);
          if (t.dangerous) {
            const ok = await confirmGate(t.name, args);
            if (!ok) {
              statusHandler?.(t.name, 'blocked', '操作被用户拒绝');
              return '用户拒绝了该操作';
            }
          }
          const raw = await t.execute(args);
          const out = String(raw ?? '');
          const final = out.length > MAX_TOOL_OUTPUT ? `${out.slice(0, MAX_TOOL_OUTPUT)}\n…（内容过长已截断）` : out;
          statusHandler?.(t.name, 'done', final.startsWith('用户拒绝') ? '操作被用户拒绝' : '完成');
          return final;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          statusHandler?.(t.name, 'error', msg);
          return `工具执行失败：${msg}`;
        }
      },
      {
        name: t.name,
        description: t.description,
        schema: jsonSchemaToZod(t.parameters),
      },
    ),
  );
  return [...converted, knowledgeSearchTool];
}

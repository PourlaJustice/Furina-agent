import { ChatDeepSeek } from '@langchain/deepseek';
import { createReactAgent } from '@langchain/langgraph/prebuilt';

import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { resolveChatConfig } from '../deepseek';
import { buildLangChainTools, setToolStatusHandler } from './tools';
import type { ToolStatusHandler } from './tools';

type AgentGraph = ReturnType<typeof createReactAgent>;

let graphPromise: Promise<AgentGraph> | null = null;

/** 把项目现有的 {role, content} 消息转成 LangChain 消息 */
function toLangChainMessages(messages: Array<Record<string, unknown>>) {
  return messages.map((m) => {
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'system') return new SystemMessage(content);
    if (m.role === 'assistant') return new AIMessage(content);
    return new HumanMessage(content);
  });
}

/** 构建（或复用）LangGraph ReAct Agent 图：agent 决策 → 工具执行 → 回答 */
export function getAgentGraph(): Promise<AgentGraph> {
  if (!graphPromise) {
    graphPromise = (async () => {
      const cfg = resolveChatConfig();
      if (!cfg.apiKey) {
        throw new Error('未配置 DeepSeek API Key。请到设置中填写后重试。');
      }
      const llm = new ChatDeepSeek({
        model: cfg.model,
        apiKey: cfg.apiKey,
        temperature: 0.8,
        maxRetries: 2,
      });
      const tools = buildLangChainTools();
      const graph = createReactAgent({ llm, tools, version: 'v1' });
      console.log(`[LangGraph] Agent 图已构建（${tools.length} 个工具）`);
      return graph;
    })();
  }
  return graphPromise;
}

/**
 * 用 LangGraph 执行一轮对话。
 * 流式取回每一步状态，工具进度通过 onTool 回调上报，最终返回完整回答。
 */
export async function runLangGraph(
  messages: Array<Record<string, unknown>>,
  onTool: ToolStatusHandler,
  signal?: AbortSignal,
): Promise<string> {
  setToolStatusHandler(onTool);
  try {
    const graph = await getAgentGraph();
    const stream = await graph.stream(
      { messages: toLangChainMessages(messages) },
      { streamMode: ['values'], signal },
    );
    let finalText = '';
    for await (const raw of stream) {
      // LangGraph v1 values 流：每个元素是 [streamMode, 状态] 元组
      const state = (Array.isArray(raw) ? raw[1] : raw) as { messages?: Array<{ content?: unknown }> };
      const last = state.messages?.[state.messages.length - 1];
      if (last && typeof last.content === 'string' && last.content) {
        finalText = last.content;
      }
    }
    if (signal?.aborted) throw new Error('已停止生成');
    return finalText.trim() || '（没有想好说什么）';
  } finally {
    setToolStatusHandler(null);
  }
}

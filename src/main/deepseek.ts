// DeepSeek 流式聊天客户端
//
// DeepSeek 提供 OpenAI 兼容的 Chat Completions 接口，因此不需要第三方 SDK，
// 直接用 Node 24 内置的 fetch 解析 SSE（Server-Sent Events）流即可。
// 参考: https://api-docs.deepseek.com/

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ChatConfig, ChatMessage } from "../shared/chat-types";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const MAX_HISTORY = 30; // 最多保留最近 30 条历史，防止上下文超长

// ---- 配置读写（userData/chat-config.json） ----

function configPath(): string {
  return path.join(app.getPath("userData"), "chat-config.json");
}

/** 读取本地配置；没有配置文件时返回空配置（apiKey 会回退到环境变量） */
export function loadChatConfig(): ChatConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    return JSON.parse(raw) as ChatConfig;
  } catch {
    return {};
  }
}

/** 保存配置（只写入显式提供的字段） */
export function saveChatConfig(patch: ChatConfig): ChatConfig {
  const merged: ChatConfig = { ...loadChatConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), "utf-8");
  } catch (err) {
    console.error("[DeepSeek] failed to save config:", err);
  }
  return merged;
}

/** 归一化配置：填入默认值，apiKey 优先取环境变量 */
export function resolveChatConfig(): Required<ChatConfig> {
  const cfg = loadChatConfig();
  return {
    apiKey: cfg.apiKey || process.env.DEEPSEEK_API_KEY || "",
    baseUrl: (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: cfg.model || DEFAULT_MODEL,
    useLangGraph: cfg.useLangGraph ?? true,
  };
}

// ---- SSE 流式解析 ----

/**
 * 调用 DeepSeek Chat Completions 并流式返回增量文本。
 *
 * @param messages     完整消息数组（含 system prompt 与历史）
 * @param onChunk      每个增量文本片段的回调（主进程用它转发给渲染进程）
 * @param signal       AbortController 信号，用于停止生成
 */
export async function streamDeepSeek(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const cfg = resolveChatConfig();
  if (!cfg.apiKey) {
    throw new Error("未配置 DeepSeek API Key。请在聊天面板的 ⚙ 设置中填入，或设置环境变量 DEEPSEEK_API_KEY。");
  }

  const url = `${cfg.baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: 0.9,
    }),
    signal,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = (await response.json()) as { error?: { message?: string } };
      detail = errBody.error?.message || JSON.stringify(errBody);
    } catch {
      detail = await response.text().catch(() => "");
    }
    const hint =
      response.status === 401
        ? "（API Key 无效或已过期，请检查 ⚙ 设置）"
        : response.status === 429
          ? "（请求过于频繁，请稍后再试）"
          : response.status === 402
            ? "（账户余额不足，请到 DeepSeek 平台充值）"
            : "";
    throw new Error(`DeepSeek 请求失败 (HTTP ${response.status}) ${hint}\n${detail}`);
  }

  if (!response.body) throw new Error("DeepSeek 返回了空响应体");

  // SSE 逐行解析：每行形如 `data: {...}`，流结束为 `data: [DONE]`
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let full = "";

  for await (const chunk of response.body) {
    if (signal?.aborted) break;
    buffer += decoder.decode(chunk as Buffer, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;

      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onChunk(delta);
        }
      } catch {
        // 忽略无法解析的行（可能是网络中间层的注释行等）
      }
    }
  }

  if (signal?.aborted) throw new Error("已停止生成");
  return full;
}

/** 非流式调用 DeepSeek（Agent 工具循环用），支持 tools 与中断信号 */
export async function completeDeepSeek(
  messages: Array<Record<string, unknown>>,
  tools?: Array<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
  const cfg = resolveChatConfig();
  if (!cfg.apiKey) {
    throw new Error('未配置 DeepSeek API Key。请在聊天面板的 ⚙ 设置中填入，或设置环境变量 DEEPSEEK_API_KEY。');
  }
  const url = `${cfg.baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools,
      temperature: 0.8,
    }),
    signal,
  });
  if (!response.ok) {
    let detail = '';
    try {
      const errBody = (await response.json()) as { error?: { message?: string } };
      detail = errBody.error?.message || JSON.stringify(errBody);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(`DeepSeek 请求失败 (HTTP ${response.status})\n${detail}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> } }>;
  };
  const msg = data.choices?.[0]?.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function?.name ?? '',
    arguments: tc.function?.arguments ?? '',
  }));
  return { content: typeof msg.content === 'string' ? msg.content : '', toolCalls };
}

/** 裁剪历史：保留 system prompt + 最近 MAX_HISTORY 条消息 */
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  return [...system, ...rest.slice(-MAX_HISTORY)];
}

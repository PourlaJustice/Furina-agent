// 聊天共享类型 — 主进程与渲染进程共用

/** 对话消息角色 */
export type ChatRole = "system" | "user" | "assistant";

/** 单条对话消息（与 DeepSeek Chat Completions 格式对齐） */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** DeepSeek 配置（保存于 userData/chat-config.json） */
export interface ChatConfig {
  /** DeepSeek API Key，留空时回退到环境变量 DEEPSEEK_API_KEY */
  apiKey?: string;
  /** API 地址，默认 https://api.deepseek.com */
  baseUrl?: string;
  /** 模型名，默认 deepseek-chat */
  model?: string;
  /** 是否使用 LangGraph Agent 工具管理（默认开启；关闭则走旧式 runAgent 循环） */
  useLangGraph?: boolean;
}

/** 主进程 → 渲染进程 流式事件负载 */
export interface ChatChunkEvent {
  /** 增量文本（一个 token 片段） */
  text: string;
}

/** 主进程 → 渲染进程 完成事件负载 */
export interface ChatDoneEvent {
  /** 最终完整回复 */
  text: string;
}

/** 主进程 → 渲染进程 错误事件负载 */
export interface ChatErrorEvent {
  message: string;
}

/** MiniMax TTS 配置（保存于 userData/tts-config.json） */
export interface TtsConfig {
  /** 是否启用语音朗读 */
  enabled: boolean;
  /** MiniMax API Key，留空时回退到环境变量 MINIMAX_API_KEY */
  apiKey?: string;
  /** 克隆好的音色 ID（如 furina） */
  voiceId?: string;
  /** 合成模型：speech-2.8-hd（高保真）| speech-2.8-turbo（极速） */
  model?: "speech-2.8-hd" | "speech-2.8-turbo";
  /** 语速 0.5~2，默认 1 */
  speed?: number;
  /** 音量 0~2，默认 1 */
  volume?: number;
}

/** 主进程 → 渲染进程 语音合成结果 */
export interface TtsSpeakResult {
  /** 音频 base64；为空表示本次未合成（未配置/失败） */
  audioBase64: string;
  /** 音频格式 */
  format: "mp3" | "wav";
  /** 可选错误信息（不阻塞文字回复） */
  error?: string;
}

/** 阿里云百炼实时语音识别配置（保存于 userData/asr-config.json） */
export interface AsrConfig {
  /** 阿里云百炼 API Key，留空时回退到环境变量 DASHSCOPE_API_KEY */
  apiKey?: string;
  /** 识别模型：qwen-audio-3.0-asr-flash-streaming（推荐，更准）| paraformer-realtime-v2 */
  model?: 'qwen-audio-3.0-asr-flash-streaming' | 'paraformer-realtime-v2';
  /** 热词（逗号分隔），提升人名/专有名词识别准确率 */
  hotWords?: string;
}

/** 记忆信息（设置界面展示用） */
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

/** 知识库状态（设置界面展示用） */
export interface KnowledgeStatus {
  files: Array<{ name: string; chunkCount: number }>;
  chunkCount: number;
  embedding: "idle" | "loading" | "ready" | "failed";
  provider: "local" | "minimax" | "langchain" | "none";
  worldbookCount: number;
}
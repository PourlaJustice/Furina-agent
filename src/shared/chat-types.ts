// 聊天共享类型 — 主进程与渲染进程共用

/** 对话消息角色 */
export type ChatRole = "system" | "user" | "assistant";

/** 单条对话消息（与 DeepSeek Chat Completions 格式对齐） */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** 大模型服务商预设（均为 OpenAI 兼容接口） */
export interface LLMProviderPreset {
  /** 唯一 ID，写入 ChatConfig.provider */
  id: string;
  /** 界面显示名 */
  label: string;
  /** 默认接口地址 */
  baseUrl: string;
  /** 默认模型名 */
  model: string;
  /** 对应的环境变量名（配置未填 Key 时回退） */
  envVar: string;
}

/** 内置服务商列表：DeepSeek / 通义千问 / Kimi / 智谱 / OpenRouter / 自定义 */
export const LLM_PROVIDERS: LLMProviderPreset[] = [
  { id: "deepseek", label: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", envVar: "DEEPSEEK_API_KEY" },
  { id: "qwen", label: "通义千问（阿里云百炼）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", envVar: "DASHSCOPE_API_KEY" },
  { id: "kimi", label: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", envVar: "MOONSHOT_API_KEY" },
  { id: "glm", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", envVar: "ZHIPU_API_KEY" },
  { id: "openrouter", label: "OpenRouter（聚合平台）", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/auto", envVar: "OPENROUTER_API_KEY" },
  { id: "custom", label: "自定义（OpenAI 兼容）", baseUrl: "", model: "", envVar: "" },
];

/** 对话模型配置（保存于 userData/chat-config.json） */
export interface ChatConfig {
  /** 服务商 ID（deepseek / qwen / kimi / glm / openrouter / custom），默认 deepseek */
  provider?: string;
  /** API Key，留空时回退到对应服务商的环境变量 */
  apiKey?: string;
  /** API 地址（OpenAI 兼容），默认取服务商预设 */
  baseUrl?: string;
  /** 模型名，默认取服务商预设 */
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

/** 手机提醒推送配置（ntfy / Bark） */
export interface PhonePushConfig {
  /** 是否启用手机提醒 */
  enabled: boolean;
  /** 推送通道：ntfy（推荐，安卓）/ bark（苹果） */
  channel?: 'ntfy' | 'bark';
  /** ntfy 主题名（订阅时使用），如 furina-reminder */
  ntfyTopic?: string;
  /** ntfy 服务器地址，自建时才需要改，默认 https://ntfy.sh */
  ntfyServer?: string;
  /** Bark 推送地址，如 https://api.day.app/你的Key/ */
  barkUrl?: string;
  /** 自定义铃声名（手机 Bark 目录中的文件名，不含扩展名），留空用默认提示音 */
  sound?: string;
  /** 通知分组名（用于折叠），可留空 */
  group?: string;
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
// IPC 通道常量 — 主进程与渲染进程共享
// 随项目扩展逐步添加

export const IPC_CHANNELS = {
  APP_VERSION: 'app:version',
  WINDOW_MOVE_BY: 'window:move-by',
  WINDOW_OPEN_EXTERNAL: 'window:open-external',
  // ---- 独立全屏聊天窗口 ----
  FULL_CHAT_OPEN: 'chat:full:open',   // 桌宠 → 主进程：打开独立聊天窗口
  FULL_CHAT_CLOSE: 'chat:full:close', // 聊天窗口 → 主进程：关闭并回到桌宠
  FULL_WIN_MIN: 'full:win:min',
  FULL_WIN_MAX: 'full:win:max',
  FULL_WIN_CLOSE: 'full:win:close',
  // ---- DeepSeek 聊天 ----
  CHAT_SEND: 'chat:send',
  CHAT_STOP: 'chat:stop',
  CHAT_CLEAR: 'chat:clear',
  CHAT_CONFIG_GET: 'chat:config:get',
  CHAT_CONFIG_SET: 'chat:config:set',
  CHAT_EVENT_STARTED: 'chat:started',
  CHAT_EVENT_CHUNK: 'chat:chunk',
  CHAT_EVENT_DONE: 'chat:done',
  CHAT_EVENT_ERROR: 'chat:error',
  CHAT_EVENT_TOOL: 'chat:tool',   // Agent 工具调用进度（名称/状态/摘要）
  // ---- MiniMax 语音朗读 ----
  TTS_SPEAK: 'tts:speak',          // 渲染进程 → 主进程：合成一句语音 → 返回 base64
  TTS_CONFIG_GET: 'tts:config:get',
  TTS_CONFIG_SET: 'tts:config:set',
  // ---- 语音输入（阿里云百炼实时语音识别） ----
  ASR_START: 'asr:start',          // 渲染进程 → 主进程：开启识别会话，返回 sessionId
  ASR_AUDIO: 'asr:audio',          // 渲染进程 → 主进程：发送 16k PCM 音频块
  ASR_STOP: 'asr:stop',            // 渲染进程 → 主进程：结束识别，返回最终文本
  ASR_CANCEL: 'asr:cancel',        // 渲染进程 → 主进程：放弃识别
  ASR_CONFIG_GET: 'asr:config:get',
  ASR_CONFIG_SET: 'asr:config:set',
  ASR_EVENT_PARTIAL: 'asr:partial', // 主进程 → 渲染进程：中间结果
  ASR_EVENT_FINAL: 'asr:final',     // 主进程 → 渲染进程：句子完成
  ASR_EVENT_ERROR: 'asr:error',     // 主进程 → 渲染进程：识别出错
  // ---- 三层记忆系统 ----
  MEMORY_GET: 'memory:get',
  MEMORY_CLEAR: 'memory:clear',
  // ---- RAG 知识库 ----
  KNOWLEDGE_GET_STATUS: 'knowledge:get-status',
  KNOWLEDGE_IMPORT: 'knowledge:import',
  KNOWLEDGE_CLEAR: 'knowledge:clear',
  KNOWLEDGE_PICK_PATH: 'knowledge:pick-path',
  // ---- 危险操作信任 ----
  TOOLS_LIST_TRUSTED: 'tools:trust:list',
  TOOLS_CLEAR_TRUSTED: 'tools:trust:clear',
  // ---- 迷你点歌台 ----
  MUSIC_MINI_OPEN: 'music:mini:open',
  MUSIC_MINI_CLOSE: 'music:mini:close',
} as const;
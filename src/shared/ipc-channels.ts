// IPC 通道常量 — 主进程与渲染进程共享
// 随项目扩展逐步添加

export const IPC_CHANNELS = {
  APP_VERSION: 'app:version',
  WINDOW_MOVE_BY: 'window:move-by',
  // ---- 阶段 5：独立全屏聊天窗口 ----
  FULL_CHAT_OPEN: 'chat:full:open',   // 桌宠 → 主进程：打开独立聊天窗口
  FULL_CHAT_CLOSE: 'chat:full:close', // 聊天窗口 → 主进程：关闭并回到桌宠
  FULL_WIN_MIN: 'full:win:min',
  FULL_WIN_MAX: 'full:win:max',
  FULL_WIN_CLOSE: 'full:win:close',
  // ---- 阶段 3：DeepSeek 聊天 ----
  CHAT_SEND: 'chat:send',
  CHAT_STOP: 'chat:stop',
  CHAT_CLEAR: 'chat:clear',
  CHAT_CONFIG_GET: 'chat:config:get',
  CHAT_CONFIG_SET: 'chat:config:set',
  CHAT_EVENT_STARTED: 'chat:started',
  CHAT_EVENT_CHUNK: 'chat:chunk',
  CHAT_EVENT_DONE: 'chat:done',
  CHAT_EVENT_ERROR: 'chat:error',
  // ---- 阶段 4：MiniMax 语音朗读 ----
  TTS_SPEAK: 'tts:speak',          // 渲染进程 → 主进程：合成一句语音 → 返回 base64
  TTS_CONFIG_GET: 'tts:config:get',
  TTS_CONFIG_SET: 'tts:config:set',
} as const;
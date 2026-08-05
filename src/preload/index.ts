import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { ChatConfig, KnowledgeStatus, MemoryInfo, TtsConfig, TtsSpeakResult } from '../shared/chat-types';

// 通过 contextBridge 安全暴露 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 获取应用版本
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),

  // 监听主进程事件
  onEvent: (channel: string, callback: (...args: unknown[]) => void) => {
    const validChannels = ['live2d:action', 'chat:chunk', 'chat:done'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    hide: () => ipcRenderer.send('window:hide'),
    quit: () => ipcRenderer.send('window:quit'),
    // 拖拽窗口（桌面宠物核心交互）
    moveBy: (dx: number, dy: number) => ipcRenderer.send(IPC_CHANNELS.WINDOW_MOVE_BY, dx, dy),
    openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN_EXTERNAL, url),
    // 独立全屏聊天窗口
    openFullChat: () => ipcRenderer.invoke(IPC_CHANNELS.FULL_CHAT_OPEN),
    closeFullChat: () => ipcRenderer.invoke(IPC_CHANNELS.FULL_CHAT_CLOSE),
  },

  // DeepSeek 聊天
  chat: {
    send: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, text),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_STOP),
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLEAR),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_CONFIG_GET),
    setConfig: (patch: ChatConfig) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_CONFIG_SET, patch),
    onStarted: (cb: () => void) => subscribe(IPC_CHANNELS.CHAT_EVENT_STARTED, cb),
    onChunk: (cb: (payload: { text: string }) => void) => subscribe(IPC_CHANNELS.CHAT_EVENT_CHUNK, cb),
    onDone: (cb: (payload: { text: string }) => void) => subscribe(IPC_CHANNELS.CHAT_EVENT_DONE, cb),
    onError: (cb: (payload: { message: string }) => void) => subscribe(IPC_CHANNELS.CHAT_EVENT_ERROR, cb),
    onTool: (cb: (payload: { name: string; status: string; summary: string }) => void) => subscribe(IPC_CHANNELS.CHAT_EVENT_TOOL, cb),
  },

  // MiniMax 语音朗读
  tts: {
    speak: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.TTS_SPEAK, text) as Promise<TtsSpeakResult>,
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.TTS_CONFIG_GET) as Promise<TtsConfig>,
    setConfig: (patch: TtsConfig) => ipcRenderer.invoke(IPC_CHANNELS.TTS_CONFIG_SET, patch) as Promise<TtsConfig>,
  },

  // 三层记忆系统
  memory: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET) as Promise<MemoryInfo>,
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CLEAR),
  },

  // RAG 知识库
  knowledge: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET_STATUS) as Promise<KnowledgeStatus>,
    importPath: (target: string) => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_IMPORT, target) as Promise<{ imported: number; chunks: number; skipped: string[] }>,
    pickPath: () => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_PICK_PATH) as Promise<string | null>,
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_CLEAR) as Promise<KnowledgeStatus>,
  },

  // 独立聊天窗口顶栏控制（仅全屏窗口使用）
  // 危险操作信任管理
  tools: {
    listTrusted: () => ipcRenderer.invoke(IPC_CHANNELS.TOOLS_LIST_TRUSTED),
    clearTrusted: () => ipcRenderer.invoke(IPC_CHANNELS.TOOLS_CLEAR_TRUSTED),
  },
  // 高危操作确认（主题弹窗）
  danger: {
    onConfirm: (cb: (payload: { id: string; toolName: string; detail: string }) => void) =>
      subscribe('danger:confirm', cb),
    respond: (id: string, choice: 'once' | 'always' | 'deny') =>
      ipcRenderer.invoke('danger:confirm:respond', { id, choice }),
  },
  // 迷你点歌台
  music: {
    openMini: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC_MINI_OPEN),
    closeMini: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC_MINI_CLOSE),
  },
  fullwin: {
    min: () => ipcRenderer.invoke(IPC_CHANNELS.FULL_WIN_MIN),
    max: () => ipcRenderer.invoke(IPC_CHANNELS.FULL_WIN_MAX),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.FULL_WIN_CLOSE),
  },
});

// 订阅主进程事件，返回取消订阅函数（渲染进程可用它清理监听器）
function subscribe<T extends unknown[]>(channel: string, callback: (...args: T) => void): () => void {
  const listener = (_event: unknown, ...args: T) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}
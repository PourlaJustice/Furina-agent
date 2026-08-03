import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { ChatConfig, TtsConfig, TtsSpeakResult } from '../shared/chat-types';

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
    // 独立全屏聊天窗口
    openFullChat: () => ipcRenderer.invoke(IPC_CHANNELS.FULL_CHAT_OPEN),
    closeFullChat: () => ipcRenderer.invoke(IPC_CHANNELS.FULL_CHAT_CLOSE),
  },

  // 阶段 3：DeepSeek 聊天
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
  },

  // 阶段 4：MiniMax 语音朗读
  tts: {
    speak: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.TTS_SPEAK, text) as Promise<TtsSpeakResult>,
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.TTS_CONFIG_GET) as Promise<TtsConfig>,
    setConfig: (patch: TtsConfig) => ipcRenderer.invoke(IPC_CHANNELS.TTS_CONFIG_SET, patch) as Promise<TtsConfig>,
  },

  // 阶段 5：独立聊天窗口顶栏控制（仅全屏窗口使用）
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
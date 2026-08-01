import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';

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
  },
});

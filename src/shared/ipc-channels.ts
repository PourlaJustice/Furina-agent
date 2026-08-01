// IPC 通道常量 — 主进程与渲染进程共享
// 随项目扩展逐步添加

export const IPC_CHANNELS = {
  APP_VERSION: 'app:version',
  WINDOW_MOVE_BY: 'window:move-by',
} as const;

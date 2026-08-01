export {};

declare global {
  interface Window {
    electronAPI: {
      getVersion: () => Promise<string>;
      onEvent: (channel: string, callback: (...args: unknown[]) => void) => void;
      window: {
        minimize: () => void;
        hide: () => void;
        quit: () => void;
        moveBy: (dx: number, dy: number) => void;
      };
    };
  }
}

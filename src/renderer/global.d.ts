export {};

import type { ChatConfig } from "../shared/chat-types";

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
      chat: {
        send: (text: string) => Promise<void>;
        stop: () => Promise<void>;
        clear: () => Promise<boolean>;
        getConfig: () => Promise<ChatConfig>;
        setConfig: (patch: ChatConfig) => Promise<ChatConfig>;
        onStarted: (cb: () => void) => () => void;
        onChunk: (cb: (payload: { text: string }) => void) => () => void;
        onDone: (cb: (payload: { text: string }) => void) => () => void;
        onError: (cb: (payload: { message: string }) => void) => () => void;
      };
    };
  }
}

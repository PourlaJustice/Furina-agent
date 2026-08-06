export {};

import type { AsrConfig, ChatConfig, KnowledgeStatus, MemoryInfo, PhonePushConfig } from "../shared/chat-types";

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
        openExternal: (url: string) => Promise<boolean>;
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
        onTool: (cb: (payload: { name: string; status: string; summary: string }) => void) => () => void;
      };
      asr: {
        start: () => Promise<string>;
        sendAudio: (sessionId: string, data: ArrayBuffer) => void;
        stop: (sessionId: string) => Promise<string>;
        cancel: (sessionId: string) => Promise<boolean>;
        getConfig: () => Promise<AsrConfig>;
        setConfig: (patch: AsrConfig) => Promise<AsrConfig>;
        onPartial: (cb: (payload: { sessionId: string; text: string }) => void) => () => void;
        onFinal: (cb: (payload: { sessionId: string; text: string }) => void) => () => void;
        onError: (cb: (payload: { sessionId: string; message: string }) => void) => () => void;
      };
      memory: {
        get: () => Promise<MemoryInfo>;
        clear: () => Promise<MemoryInfo>;
      };
      tasks: {
        onReminder: (cb: (payload: { text: string; dueAt: number }) => void) => () => void;
      };
      petmenu: {
        open: (x: number, y: number) => Promise<boolean>;
        close: () => void;
        command: (payload: string) => void;
        onCommand: (cb: (payload: string) => void) => () => void;
      };
      music: {
        openMini: () => Promise<boolean>;
        closeMini: () => Promise<boolean>;
      };
      alarm: {
        open: (text: string, dueAt: number) => Promise<boolean>;
        close: () => Promise<boolean>;
        snooze: (text: string) => Promise<boolean>;
        getBgm: () => Promise<{ base64: string; format: string } | null>;
      };
      phonePush: {
        getConfig: () => Promise<PhonePushConfig>;
        setConfig: (patch: PhonePushConfig) => Promise<PhonePushConfig>;
        test: () => Promise<{ ok: boolean; reason?: string }>;
      };
      danger: {
        onConfirm: (cb: (payload: { id: string; toolName: string; detail: string }) => void) => () => void;
        respond: (id: string, choice: 'once' | 'always' | 'deny') => Promise<boolean>;
      };
      tools: {
        listTrusted: () => Promise<string[]>;
        clearTrusted: () => Promise<string[]>;
      };
      knowledge: {
        getStatus: () => Promise<KnowledgeStatus>;
        importPath: (target: string) => Promise<{ imported: number; chunks: number; skipped: string[] }>;
        pickPath: () => Promise<string | null>;
        clear: () => Promise<KnowledgeStatus>;
      };
    };
  }
}

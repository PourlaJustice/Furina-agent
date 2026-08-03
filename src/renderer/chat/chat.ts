// 阶段 3+4：聊天面板逻辑
// - 打开/关闭聊天面板（桌宠视图 prefix=""，全屏视图 prefix="full-"）
// - 发送消息给 DeepSeek，流式渲染 Markdown 回复
// - 阶段 4：每条回复带「喇叭」按钮，点击后按句子切分 → MiniMax 合成 → 排队播放 → 口型同步

import MarkdownIt from "markdown-it";
import "./chat.css";

/** 聊天状态回调：面板开关变化时通知 Live2D 切换布局 */
export interface ChatCallbacks {
  onOpenChange: (open: boolean) => void;
  onSpeakingChange: (speaking: boolean) => void;
}

export class ChatPanel {
  private panel: HTMLElement;
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private toggleBtn: HTMLButtonElement | null;
  private configView: HTMLElement;
  private apiKeyInput: HTMLInputElement;
  private baseUrlInput: HTMLInputElement;
  private modelInput: HTMLInputElement;
  // 阶段 4：语音配置输入
  private ttsEnabledInput: HTMLInputElement;
  private ttsApiKeyInput: HTMLInputElement;
  private ttsVoiceIdInput: HTMLInputElement;
  private ttsModelInput: HTMLSelectElement;

  private md: MarkdownIt;
  private visible = false;
  private busy = false;
  private assistantBuffer = "";
  private assistantBubble: HTMLElement | null = null;
  /** assistant 气泡内的内容区（喇叭按钮固定在气泡左上角，不被流式渲染覆盖） */
  private bubbleContentEl: HTMLElement | null = null;
  private unsubscribers: Array<() => void> = [];
  /** 每个 assistant 气泡对应的纯文本（喇叭按钮朗读用） */
  private bubbleTexts = new WeakMap<HTMLElement, string>();

  // ---- 阶段 4：语音朗读状态（点击喇叭触发） ----
  private ttsEnabled = false;
  private ttsChain: Promise<void> = Promise.resolve();
  private ttsCurrentAudio: HTMLAudioElement | null = null;
  private speechPending = 0;
  private speechStopped = false;
  private speechActiveState = false;
  private speakingBubble: HTMLElement | null = null;

  constructor(
    private callbacks: ChatCallbacks,
    private prefix = "",
  ) {
    const el = <T extends HTMLElement>(id: string): T =>
      document.getElementById(prefix + id) as T;
    const maybe = <T extends HTMLElement>(id: string): T | null =>
      document.getElementById(prefix + id) as T | null;

    this.panel = el("chat-panel");
    this.messagesEl = el("chat-messages");
    this.inputEl = el("chat-input");
    this.sendBtn = el("chat-send");
    this.toggleBtn = maybe("chat-toggle");
    this.configView = el("chat-config-view");
    this.apiKeyInput = el("config-apikey");
    this.baseUrlInput = el("config-baseurl");
    this.modelInput = el("config-model");
    this.ttsEnabledInput = el("config-tts-enabled");
    this.ttsApiKeyInput = el("config-tts-apikey");
    this.ttsVoiceIdInput = el("config-tts-voiceid");
    this.ttsModelInput = el("config-tts-model");

    // Markdown 渲染：关闭 html，保留链接与换行
    this.md = new MarkdownIt({ html: false, breaks: true, linkify: true });

    this.bindEvents();
    this.bindIpc();
    // 启动时读取语音配置（决定喇叭按钮是否可用）
    window.electronAPI.tts.getConfig().then((cfg) => {
      this.ttsEnabled = Boolean(cfg.enabled);
    }).catch(() => { /* 未配置时保持关闭 */ });
    this.showHint("首次使用：点击右上角 ⚙ 设置，填入 DeepSeek API Key，然后就可以和芙宁娜聊天了～");
  }

  private bindEvents(): void {
    this.toggleBtn?.addEventListener("click", () => this.toggle());

    document.getElementById(this.prefix + "chat-close")?.addEventListener("click", () => this.setVisible(false));
    document.getElementById(this.prefix + "chat-clear")?.addEventListener("click", () => this.clearChat());
    document.getElementById(this.prefix + "chat-config")?.addEventListener("click", () => this.openConfig());
    document.getElementById(this.prefix + "chat-config-back")?.addEventListener("click", () => this.closeConfig());
    document.getElementById(this.prefix + "config-close")?.addEventListener("click", () => this.closeConfig());
    document.getElementById(this.prefix + "chat-config-save")?.addEventListener("click", () => this.saveConfig());

    this.sendBtn.addEventListener("click", () => void this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    // 输入框自动增高
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 84) + "px";
    });
  }

  private bindIpc(): void {
    const api = window.electronAPI.chat;
    this.unsubscribers.push(
      api.onStarted(() => {
        this.startAssistantBubble();
      }),
      api.onChunk(({ text }) => {
        if (!this.assistantBubble) this.startAssistantBubble();
        this.assistantBuffer += text;
        this.bubbleTexts.set(this.assistantBubble, this.assistantBuffer);
        this.renderAssistant();
      }),
      api.onDone(({ text }) => {
        if (text && this.assistantBuffer !== text) {
          this.assistantBuffer = text;
          this.renderAssistant();
        }
        if (this.assistantBubble) {
          this.bubbleTexts.set(this.assistantBubble, this.assistantBuffer);
        }
        this.finishAssistant();
      }),
      api.onError(({ message }) => {
        this.finishAssistant();
        this.appendMessage(message, "error");
      }),
    );
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  setVisible(open: boolean): void {
    this.visible = open;
    this.panel.classList.toggle("hidden", !open);
    this.toggleBtn?.classList.toggle("active", open);
    if (this.toggleBtn) this.toggleBtn.textContent = open ? "✕" : "聊";
    this.callbacks.onOpenChange(open);
    if (open) {
      this.inputEl.focus();
      this.scrollToBottom();
    }
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.busy) return;

    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.appendMessage(text, "user");
    this.busy = true;
    this.sendBtn.disabled = true;

    try {
      await window.electronAPI.chat.send(text);
    } catch (err) {
      this.appendMessage(err instanceof Error ? err.message : String(err), "error");
      this.finishAssistant();
    } finally {
      this.busy = false;
      this.sendBtn.disabled = false;
      this.inputEl.focus();
    }
  }

  /** 创建 assistant 气泡（“开始生成”事件到达时调用），并附带喇叭按钮 */
  private startAssistantBubble(): void {
    if (this.assistantBubble) return;
    this.assistantBuffer = "";
    const bubble = this.appendMessage("", "assistant");
    bubble.classList.add("typing");
    const contentEl = document.createElement("div");
    contentEl.className = "msg-content";
    bubble.appendChild(contentEl);
    this.assistantBubble = bubble;
    this.bubbleContentEl = contentEl;
    this.bubbleTexts.set(bubble, "");

    const speakBtn = document.createElement("button");
    speakBtn.type = "button";
    speakBtn.className = "msg-speak-btn";
    speakBtn.textContent = "🔊";
    speakBtn.title = "朗读这条回复";
    speakBtn.addEventListener("click", () => {
      const text = (this.bubbleTexts.get(bubble) ?? "").trim();
      if (!text) return;
      if (!this.ttsEnabled) {
        this.showHint("语音未启用：请到 ⚙ 设置中勾选「启用语音朗读」并填写 MiniMax 音色。");
        return;
      }
      if (this.speechActiveState && this.speakingBubble === bubble) {
        this.stopSpeech();
        return;
      }
      this.speakText(bubble, text, speakBtn);
    });
    bubble.prepend(speakBtn);
  }

  /** 流式渲染：把累计文本通过 markdown-it 重绘到内容区（不覆盖喇叭按钮） */
  private renderAssistant(): void {
    if (!this.assistantBubble || !this.bubbleContentEl) return;
    const html = this.assistantBuffer.trim()
      ? this.md.render(this.assistantBuffer)
      : "";
    this.bubbleContentEl.innerHTML = html;
    this.scrollToBottom();
  }

  /** 结束生成：移除打字光标 */
  private finishAssistant(): void {
    if (this.assistantBubble) {
      this.assistantBubble.classList.remove("typing");
      this.assistantBubble = null;
    }
    this.bubbleContentEl = null;
    this.assistantBuffer = "";
    this.scrollToBottom();
  }

  // ================= 阶段 4：点击喇叭朗读 =================

  private speakText(bubble: HTMLElement, text: string, speakBtn: HTMLButtonElement): void {
    this.stopSpeech();
    this.speechStopped = false;
    this.speakingBubble = bubble;
    speakBtn.classList.add("playing");
    const sentences = this.splitSentences(text);
    if (sentences.length === 0) return;
    for (const s of sentences) this.enqueueSpeech(s);
  }

  /** 把整段文本切成句子列表 */
  private splitSentences(text: string): string[] {
    const result: string[] = [];
    let buffer = "";
    const isBoundary = (ch: string): boolean => "。！？…；;\n".includes(ch);
    for (const ch of text) {
      buffer += ch;
      if (isBoundary(ch)) {
        if (buffer.trim()) result.push(buffer.trim());
        buffer = "";
      } else if (buffer.length >= 80) {
        if (buffer.trim()) result.push(buffer.trim());
        buffer = "";
      }
    }
    if (buffer.trim()) result.push(buffer.trim());
    return result;
  }

  /** 入队一句语音：合成 + 播放串行执行 */
  private enqueueSpeech(text: string): void {
    this.speechPending += 1;
    this.setSpeechActive(true);
    this.ttsChain = this.ttsChain.then(async () => {
      try {
        if (this.speechStopped) return;
        const result = await window.electronAPI.tts.speak(text);
        if (this.speechStopped || !result?.audioBase64) return;
        await this.playAudio(result.audioBase64);
      } catch {
        // 语音失败不阻塞聊天，静默跳过
      } finally {
        this.speechPending = Math.max(0, this.speechPending - 1);
        if (this.speechPending === 0) {
          this.setSpeechActive(false);
          if (this.speakingBubble) {
            const btn = this.speakingBubble.querySelector(".msg-speak-btn");
            btn?.classList.remove("playing");
          }
          this.speakingBubble = null;
        }
      }
    });
  }

  /** 播放一段音频（结束/出错都会 resolve） */
  private playAudio(base64: string): Promise<void> {
    return new Promise((resolve) => {
      const audio = new Audio("data:audio/mp3;base64," + base64);
      this.ttsCurrentAudio = audio;
      audio.onended = () => {
        if (this.ttsCurrentAudio === audio) this.ttsCurrentAudio = null;
        resolve();
      };
      audio.onerror = () => {
        if (this.ttsCurrentAudio === audio) this.ttsCurrentAudio = null;
        resolve();
      };
      audio.play().catch(() => {
        if (this.ttsCurrentAudio === audio) this.ttsCurrentAudio = null;
        resolve();
      });
    });
  }

  /** 口型同步状态（有变化时才通知 Live2D） */
  private setSpeechActive(active: boolean): void {
    if (this.speechActiveState === active) return;
    this.speechActiveState = active;
    this.callbacks.onSpeakingChange(active);
  }

  /** 停止当前朗读并清空队列 */
  private stopSpeech(): void {
    this.speechStopped = true;
    if (this.ttsCurrentAudio) {
      try { this.ttsCurrentAudio.pause(); } catch { /* ignore */ }
      this.ttsCurrentAudio = null;
    }
    this.speechPending = 0;
    this.ttsChain = Promise.resolve();
    if (this.speakingBubble) {
      const btn = this.speakingBubble.querySelector(".msg-speak-btn");
      btn?.classList.remove("playing");
    }
    this.speakingBubble = null;
    this.speechActiveState = false;
    this.callbacks.onSpeakingChange(false);
  }

  private appendMessage(text: string, kind: "user" | "assistant" | "error" | "system-hint"): HTMLElement {
    const el = document.createElement("div");
    el.className = `chat-msg ${kind}`;
    if (kind === "user") {
      el.textContent = text;
    } else if (kind !== "assistant") {
      el.textContent = text;
    }
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private showHint(text: string): void {
    this.appendMessage(text, "system-hint");
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async clearChat(): Promise<void> {
    this.stopSpeech();
    await window.electronAPI.chat.clear();
    this.messagesEl.innerHTML = "";
    this.showHint("对话已清空，芙宁娜会忘记之前说过的话～");
  }

  private async openConfig(): Promise<void> {
    const cfg = await window.electronAPI.chat.getConfig();
    this.apiKeyInput.value = cfg.apiKey ?? "";
    this.baseUrlInput.value = cfg.baseUrl ?? "https://api.deepseek.com";
    this.modelInput.value = cfg.model ?? "deepseek-chat";
    const tts = await window.electronAPI.tts.getConfig();
    this.ttsEnabledInput.checked = Boolean(tts.enabled);
    this.ttsApiKeyInput.value = tts.apiKey ?? "";
    this.ttsVoiceIdInput.value = tts.voiceId ?? "";
    this.ttsModelInput.value = tts.model ?? "speech-2.8-hd";
    this.configView.classList.remove("hidden");
    this.configView.scrollTop = 0;
  }

  private closeConfig(): void {
    this.configView.classList.add("hidden");
  }

  private async saveConfig(): Promise<void> {
    await window.electronAPI.chat.setConfig({
      apiKey: this.apiKeyInput.value.trim(),
      baseUrl: this.baseUrlInput.value.trim() || "https://api.deepseek.com",
      model: this.modelInput.value.trim() || "deepseek-chat",
    });
    this.ttsEnabled = this.ttsEnabledInput.checked;
    await window.electronAPI.tts.setConfig({
      enabled: this.ttsEnabled,
      apiKey: this.ttsApiKeyInput.value.trim(),
      voiceId: this.ttsVoiceIdInput.value.trim(),
      model: this.ttsModelInput.value === "speech-2.8-turbo" ? "speech-2.8-turbo" : "speech-2.8-hd",
    });
    this.closeConfig();
    this.showHint(
      this.ttsEnabled
        ? "设置已保存 ✓ 点消息上的 🔊 按钮即可让芙宁娜开口朗读"
        : "设置已保存 ✓ 现在可以和芙宁娜聊天了。",
    );
  }

  destroy(): void {
    this.stopSpeech();
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];
  }
}
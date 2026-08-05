// 聊天面板逻辑
// - 打开/关闭聊天面板（桌宠视图 prefix=""，全屏视图 prefix="full-"）
// - 发送消息给 DeepSeek，流式渲染 Markdown 回复
// - 每条回复带「喇叭」按钮，点击后按句子切分 → MiniMax 合成 → 排队播放 → 口型同步

import MarkdownIt from "markdown-it";
import "./chat.css";
import { extractActionSegments, parseConversationAction } from "../live2d/actions";
import type { ConversationAction } from "../live2d/actions";
import type { KnowledgeStatus, MemoryInfo } from "../../shared/chat-types";

/** 聊天状态回调：面板开关变化时通知 Live2D 切换布局 */
export interface ChatCallbacks {
  onOpenChange: (open: boolean) => void;
  onSpeakingChange: (speaking: boolean) => void;
  /** 对话动作回调：回复中出现（生气）（摊手）等描述时触发，由 Live2D 匹配动作/表情 */
  onAction?: (action: ConversationAction | null) => void;
  /** 重新播放语音时清空待播放动作（让动作从头开始同步） */
  onActionReset?: () => void;
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
  // 语音配置输入
  private ttsEnabledInput: HTMLInputElement;
  private ttsApiKeyInput: HTMLInputElement;
  private ttsVoiceIdInput: HTMLInputElement;
  private ttsModelInput: HTMLSelectElement;
  // 记忆展示
  private memoryBox: HTMLElement;
  private memoryClearBtn: HTMLButtonElement;
  // 知识库
  private kbStatusEl: HTMLElement;
  private kbPathInput: HTMLInputElement;
  private kbImportBtn: HTMLButtonElement;
  private kbClearBtn: HTMLButtonElement;
  private kbBrowseBtn: HTMLButtonElement;
  // 危险操作信任
  private trustListEl: HTMLElement;
  private trustClearBtn: HTMLButtonElement;
  private musicBtn: HTMLButtonElement | null;

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

  // ---- 语音朗读状态（点击喇叭触发） ----
  private ttsEnabled = false;
  private ttsChain: Promise<void> = Promise.resolve();
  private ttsCurrentAudio: HTMLAudioElement | null = null;
  private speechPending = 0;
  private speechStopped = false;
  private speechActiveState = false;
  private speakingBubble: HTMLElement | null = null;
  /** 流式渲染时已触发动作的文本位置（防止同一动作重复触发） */
  private streamActionUntil = 0;

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
    this.memoryBox = el("chat-memory-box");
    this.memoryClearBtn = el("chat-memory-clear");
    this.kbStatusEl = el("chat-kb-status");
    this.kbPathInput = el("chat-kb-path");
    this.kbImportBtn = el("chat-kb-import");
    this.kbClearBtn = el("chat-kb-clear");
    this.kbBrowseBtn = el("chat-kb-browse");
    this.trustListEl = el("chat-trust-list");
    this.trustClearBtn = el("chat-trust-clear");
    this.musicBtn = maybe("chat-music");

    // Markdown 渲染：关闭 html，保留链接与换行
    this.md = new MarkdownIt({ html: false, breaks: true, linkify: true });

    this.bindEvents();
    this.bindConfigTabs();
    this.bindIpc();
    // 启动时读取语音配置（决定喇叭按钮是否可用）
    window.electronAPI.tts.getConfig().then((cfg) => {
      this.ttsEnabled = Boolean(cfg.enabled);
    }).catch(() => { /* 未配置时保持关闭 */ });
    this.showHint("首次使用：点击右上角 ⚙ 设置，填入 DeepSeek API Key，然后就可以和芙宁娜聊天了～");
  }

  /** 设置面板标签页切换（事件委托，绑定更可靠） */
  private bindConfigTabs(): void {
    this.configView.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const tab = target.closest<HTMLButtonElement>(".config-tab");
      if (!tab) return;
      const name = tab.dataset.configTab ?? "";
      console.log("[Furina] settings tab clicked:", name);
      this.configView.querySelectorAll(".config-tab").forEach((t) => t.classList.toggle("active", t === tab));
      this.configView.querySelectorAll(".config-tab-page").forEach((pg) => pg.classList.toggle("hidden", pg.dataset.configPage !== name));
      this.configView.scrollTop = 0;
    });
    console.log("[Furina] settings tabs:", this.configView.querySelectorAll(".config-tab").length);
  }

  private bindEvents(): void {
    this.toggleBtn?.addEventListener("click", () => this.toggle());

    document.getElementById(this.prefix + "chat-close")?.addEventListener("click", () => this.setVisible(false));
    document.getElementById(this.prefix + "chat-clear")?.addEventListener("click", () => this.clearChat());
    document.getElementById(this.prefix + "chat-config")?.addEventListener("click", () => this.openConfig());
    document.getElementById(this.prefix + "chat-config-back")?.addEventListener("click", () => this.closeConfig());
    document.getElementById(this.prefix + "config-close")?.addEventListener("click", () => this.closeConfig());
    document.getElementById(this.prefix + "chat-config-save")?.addEventListener("click", () => this.saveConfig());
    this.memoryClearBtn.addEventListener("click", () => void this.clearMemory());
    this.kbImportBtn.addEventListener("click", () => void this.importKnowledge());
    this.kbClearBtn.addEventListener("click", () => void this.clearKnowledge());
    this.kbBrowseBtn.addEventListener("click", () => void this.browseKnowledge());
    this.trustClearBtn.addEventListener("click", () => void this.clearTrustedTools());
    this.musicBtn?.addEventListener("click", () => void window.electronAPI.music.openMini());

    this.sendBtn.addEventListener("click", () => void this.send());
    // 点击消息里的链接 → 系统浏览器打开，不让窗口跳走
    this.messagesEl.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) void window.electronAPI.window.openExternal(href);
    });
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
        this.scanStreamActions();
      }),
      api.onDone(({ text }) => {
        if (text && this.assistantBuffer !== text) {
          this.assistantBuffer = text;
          this.renderAssistant();
        }
        if (this.assistantBubble) {
          this.bubbleTexts.set(this.assistantBubble, this.assistantBuffer);
        }
        this.scanStreamActions();
        this.finishAssistant();
      }),
      api.onError(({ message }) => {
        this.finishAssistant();
        this.appendMessage(message, "error");
      }),
      // ★ 工具调用进度提示（如“正在搜索网页…”）
      api.onTool(({ name, status, summary }) => {
        if (status === "start" || status === "blocked") {
          this.showHint("🔧 " + summary);
        }
        if (status === "done" && name && /^netease-music__(play_song|play_track|next_song|replay_track)/.test(name)) {
          void window.electronAPI.music.openMini();
        }
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
    this.streamActionUntil = 0;
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


  /**
   * 流式扫描：回复文字逐字出现时，括号里的动作描述一出现就触发一次，
   * 由 Live2D 的动作队列串行播放（做一步、复位、再做下一步）。
   */
  private scanStreamActions(): void {
    if (!this.assistantBuffer) return;
    const segments = extractActionSegments(this.assistantBuffer);
    let cursor = this.streamActionUntil;
    for (const seg of segments) {
      const idx = this.assistantBuffer.indexOf(seg, cursor);
      if (idx < 0) continue;
      const end = idx + seg.length;
      if (end > this.streamActionUntil) {
        this.streamActionUntil = end;
        this.callbacks.onAction?.(parseConversationAction(seg));
      }
      cursor = end;
    }
  }

  // ================= 点击喇叭朗读 =================

  private speakText(bubble: HTMLElement, text: string, speakBtn: HTMLButtonElement): void {
    this.stopSpeech();
    // 重新播放：清空还没播的动作，让动作与新的语音从头开始同步
    this.callbacks.onActionReset?.();
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
        // 朗读本句前触发句中的动作描述，让动作与语音同步；
        // 一句里多个动作时依次间隔触发，避免瞬间连做
        const segs = extractActionSegments(text);
        segs.forEach((seg, i) => {
          const fire = (): void => {
            if (!this.speechStopped) this.callbacks.onAction?.(parseConversationAction(seg));
          };
          if (i === 0) {
            fire();
          } else {
            setTimeout(fire, i * 900);
          }
        });
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
    void this.refreshMemory();
    void this.refreshKnowledge();
    void this.refreshTrustedTools();
  }

  private closeConfig(): void {
    this.configView.classList.add("hidden");
  }

  // ================= 记忆查看与清空 =================

  // ================= 危险操作信任 =================

  private async refreshTrustedTools(): Promise<void> {
    try {
      const list = await window.electronAPI.tools.listTrusted();
      this.trustListEl.innerHTML = "";
      if (list.length === 0) {
        const d = document.createElement("div");
        d.className = "memory-empty";
        d.textContent = "还没有信任任何操作，所有危险操作都会先询问你。";
        this.trustListEl.appendChild(d);
        return;
      }
      for (const name of list) {
        const d = document.createElement("div");
        d.className = "trust-item";
        const label = name.endsWith("__") ? name.slice(0, -2) + "（该服务的全部操作）" : name;
    d.textContent = "✓ " + label;
        this.trustListEl.appendChild(d);
      }
    } catch {
      /* 忽略加载失败 */
    }
  }

  private async clearTrustedTools(): Promise<void> {
    await window.electronAPI.tools.clearTrusted();
    await this.refreshTrustedTools();
    this.showHint("已恢复：以后每个危险操作都会先询问你。");
  }
  private async refreshMemory(): Promise<void> {
    try {
      const info = await window.electronAPI.memory.get();
      this.renderMemory(info);
    } catch {
      this.renderMemory(null);
    }
  }

  private renderMemory(info: MemoryInfo | null): void {
    this.memoryBox.innerHTML = "";
    const isEmpty = !info || (!info.name && !info.age && !info.occupation && info.interests.length === 0 && info.recentL2.length === 0);
    if (isEmpty) {
      const d = document.createElement("div");
      d.className = "memory-empty";
      d.textContent = "还没有记忆，和芙宁娜聊聊天试试～";
      this.memoryBox.appendChild(d);
      return;
    }
    const line = (label: string, value: string | undefined): void => {
      if (!value) return;
      const d = document.createElement("div");
      d.className = "memory-item";
      d.textContent = `${label}：${value}`;
      this.memoryBox.appendChild(d);
    };
    line("名字", info!.name);
    line("年龄", info!.age);
    line("职业", info!.occupation);
    if (info!.interests.length > 0) line("喜好", info!.interests.join("、"));
    if (info!.dislikes.length > 0) line("雷区", info!.dislikes.join("、"));
    if (info!.topics.length > 0) line("最近聊到", info!.topics.slice(-3).join("｜"));
    for (const m of info!.recentL2.slice(0, 5)) {
      const d = document.createElement("div");
      d.className = "memory-item memory-l2";
      d.textContent = "· " + m.content;
      this.memoryBox.appendChild(d);
    }
    if (info!.relationCount > 0) {
      const d = document.createElement("div");
      d.className = "memory-item memory-rel";
      d.textContent = `已记住 ${info!.relationCount} 条人物关系`;
      this.memoryBox.appendChild(d);
    }
  }

  private async clearMemory(): Promise<void> {
    await window.electronAPI.memory.clear();
    await this.refreshMemory();
    this.showHint("记忆已清空，芙宁娜会重新开始认识你～");
  }

  // ================= 知识库 =================

  private async refreshKnowledge(): Promise<void> {
    try {
      const status = await window.electronAPI.knowledge.getStatus();
      this.renderKnowledge(status);
    } catch {
      this.kbStatusEl.textContent = "知识库不可用";
    }
  }

  private renderKnowledge(status: KnowledgeStatus): void {
    const providerText =
      status.provider === "minimax" ? "（MiniMax 向量接口）" :
      status.provider === "local" ? "（本地模型）" : "";
    const embedText =
      status.embedding === "ready" ? `语义检索已就绪 ${providerText}` :
      status.embedding === "loading" ? "语义模型加载中…" :
      status.embedding === "failed" ? "语义模型不可用（已降级为关键词检索）" :
      "语义模型待加载";
    const fileLines = status.files.slice(0, 6).map((f) => `${f.name}（${f.chunkCount} 块）`).join("<br/>");
    this.kbStatusEl.innerHTML =
      `已索引 ${status.chunkCount} 个分块，${status.files.length} 个文件，${status.worldbookCount} 条世界设定<br/>` +
      `${embedText}<br/>` +
      (fileLines ? `<span class="memory-l2">${fileLines}</span>` : "");
  }

  /** 弹出系统文件/文件夹选择框，选完后自动导入 */
  private async browseKnowledge(): Promise<void> {
    try {
      const picked = await window.electronAPI.knowledge.pickPath();
      if (!picked) return; // 用户取消了选择
      this.kbPathInput.value = picked;
      await this.importKnowledge();
    } catch (err) {
      this.showHint(err instanceof Error ? err.message : String(err));
    }
  }

  private async importKnowledge(): Promise<void> {
    const target = this.kbPathInput.value.trim();
    if (!target) {
      this.showHint("请先输入要导入的文件或文件夹路径。");
      return;
    }
    this.kbImportBtn.disabled = true;
    this.kbImportBtn.textContent = "导入中…";
    try {
      const r = await window.electronAPI.knowledge.importPath(target);
      await this.refreshKnowledge();
      const skip = r.skipped.length > 0 ? `；跳过：${r.skipped.slice(0, 3).join("、")}` : "";
      this.showHint(`导入 ${r.imported} 个文件，新增 ${r.chunks} 个分块${skip}`);
    } catch (err) {
      this.showHint(err instanceof Error ? err.message : String(err));
    } finally {
      this.kbImportBtn.disabled = false;
      this.kbImportBtn.textContent = "导入";
    }
  }

  private async clearKnowledge(): Promise<void> {
    await window.electronAPI.knowledge.clear();
    await this.refreshKnowledge();
    this.showHint("知识库已清空。");
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
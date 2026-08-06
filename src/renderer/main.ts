// Furina Agent — 渲染进程入口
// - 桌宠模式（默认）：透明小窗 + Live2D 模型 + 小聊天面板
// - 全屏聊天模式（?mode=full）：独立深色星空聊天窗口，模型固定在右侧卡片

import { Live2DManager } from "./live2d/manager";
import { ChatPanel } from "./chat/chat";

declare global {
  interface Window {
    furinaChat?: ChatPanel;
    furinaLive2d?: Live2DManager;
  }
}

const fullMode = new URLSearchParams(location.search).get("mode") === "full";
const modelPath = "/models/furina/" + encodeURIComponent("芙宁娜.model3.json");

async function initManager(canvas: HTMLCanvasElement, width: number, height: number, petInteractions = true): Promise<Live2DManager> {
  const manager = new Live2DManager(canvas, width, height, petInteractions);
  try {
    await manager.init(modelPath);
  } catch (err) {
    console.error("[Furina] Failed to load Live2D model:", err);
  }
  window.furinaLive2d = manager;
  return manager;
}

// ================= 全屏聊天模式 =================
async function initFullMode(): Promise<void> {
  document.body.classList.add("mode-full"); // ★ 激活全屏样式
  const app = document.getElementById("full-app") as HTMLElement;
  app.classList.remove("hidden"); // 先显示，再初始化画布（避免 0 尺寸）
  const modelEl = document.getElementById("full-model") as HTMLElement;
  const canvas = document.getElementById("full-canvas") as HTMLCanvasElement;
  // 模型铺满左侧区域：初始用容器尺寸（模型放大，看得更清）
  const initW = Math.max(modelEl.clientWidth, 400);
  const initH = Math.max(modelEl.clientHeight, 500);
  // ★ 聊天模式：关闭宠物互动（无点击/悬停/随机动作/右键），专注对话与 Agent 服务
  const manager = await initManager(canvas, initW, initH, false);
  manager.setShoePeek(); // 脚部微露：鞋子露出一部分

  const chatPanel = new ChatPanel(
    {
      // 全屏模式模型与聊天分栏显示，无需避让
      onOpenChange: () => { /* noop */ },
      onSpeakingChange: (speaking) => manager.setSpeaking(speaking),
      onAction: (action) => manager.playConversationAction(action),
      onActionReset: () => manager.clearActionQueue(),
    },
    "full-",
  );
  window.furinaChat = chatPanel;
  chatPanel.setVisible(true);

  // 窗口/布局变化时，画布跟随模型区尺寸
  const syncModelSize = (): void => {
    if (modelEl.clientWidth > 0 && modelEl.clientHeight > 0) {
      manager.resize(modelEl.clientWidth, modelEl.clientHeight);
      manager.setShoePeek();
    }
  };
  window.addEventListener("resize", syncModelSize);
  setTimeout(syncModelSize, 300); // 布局稳定后校准一次

  // 自绘顶栏控制
  document.getElementById("full-min")!.addEventListener("click", () => window.electronAPI.fullwin.min());
  document.getElementById("full-max")!.addEventListener("click", () => window.electronAPI.fullwin.max());
  document.getElementById("full-close")!.addEventListener("click", () => window.electronAPI.fullwin.close());

  // 诊断
  setInterval(() => {
    console.log(`[diag] full scale=${manager.getScale()?.toFixed(4)} win=${window.innerWidth}x${window.innerHeight} canvas=${canvas.width}x${canvas.height}`);
  }, 5000);
}

// ================= 桌宠模式 =================
async function initPetMode(): Promise<void> {
  const canvas = document.getElementById("live2d-canvas") as HTMLCanvasElement;
  if (!canvas) throw new Error("Canvas #live2d-canvas not found");

  const manager = await initManager(canvas, window.innerWidth, window.innerHeight);
  // ★ 桌宠窗口默认布局：从鞋子一半开始向上显示
  manager.enableHalfShoeMode();
  // 诊断：模型 scale 与窗口尺寸
  setInterval(() => {
    console.log(
      `[diag] scale=${manager.getScale()?.toFixed(4)} win=${window.innerWidth}x${window.innerHeight} canvas=${canvas.width}x${canvas.height} dpr=${window.devicePixelRatio}`
    );
    manager.dumpAbnormalParams();
  }, 2000);
  setTimeout(() => manager.dumpMotionDefs(), 6000);

  // 聊天面板
  const chatPanel = new ChatPanel({
    onOpenChange: (open) => manager.setChatMode(open),
    onSpeakingChange: (speaking) => manager.setSpeaking(speaking),
    onAction: (action) => manager.playConversationAction(action),
    onActionReset: () => manager.clearActionQueue(),
  });
  window.furinaChat = chatPanel;

  // ⛶ 打开独立全屏聊天窗口
  document.getElementById("chat-fullscreen")!.addEventListener("click", () => {
    void window.electronAPI.window.openFullChat();
  });

  // ★ 桌宠模式专属：右键打开独立互动菜单窗（可在桌面任意位置打开/拖动）
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void window.electronAPI.petmenu.open(e.screenX, e.screenY);
  });
  // 菜单窗命令：表情/动作 → Live2D 执行；聊天/设置/音乐 → 打开对应面板
  window.electronAPI.petmenu.onCommand((cmd) => {
    // ★ 表情/动作走串行队列：一次只做一个，做完复位再做下一个，避免叠加（三只手）
    if (cmd.startsWith("expr:")) window.furinaLive2d?.playMenuExpression(cmd.slice(5));
    else if (cmd.startsWith("motion:")) window.furinaLive2d?.playMenuMotion(cmd.slice(7));
    else if (cmd === "chat") window.furinaChat?.setVisible(true);
    else if (cmd === "settings") void window.furinaChat?.openSettings();
    else if (cmd === "music") void window.electronAPI.music.openMini();
  });

  // 拖拽窗口：按住角色拖动整个窗口
  let dragging = false;
  let lastMoveX = 0;
  let lastMoveY = 0;
  let lastMoveSentAt = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastMoveX = e.screenX;
    lastMoveY = e.screenY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const now = performance.now();
    if (now - lastMoveSentAt < 16) return;
    lastMoveSentAt = now;
    window.electronAPI.window.moveBy(e.screenX - lastMoveX, e.screenY - lastMoveY);
    lastMoveX = e.screenX;
    lastMoveY = e.screenY;
  });
  canvas.addEventListener("pointerup", () => {
    dragging = false;
    lastMoveX = 0;
    lastMoveY = 0;
  });
}

// ================= 高危操作确认弹窗 =================
function initDangerOverlay(): void {
  const overlay = document.getElementById("danger-overlay") as HTMLElement;
  const toolEl = document.getElementById("danger-tool-name") as HTMLElement;
  const detailEl = document.getElementById("danger-detail") as HTMLElement;
  const onceBtn = document.getElementById("danger-once") as HTMLButtonElement;
  const alwaysBtn = document.getElementById("danger-always") as HTMLButtonElement;
  const denyBtn = document.getElementById("danger-deny") as HTMLButtonElement;
  const closeBtn = document.getElementById("danger-close") as HTMLButtonElement;
  let currentId = "";
  let showing = false;
  const queue: Array<{ id: string; toolName: string; detail: string }> = [];

  const hide = (): void => overlay.classList.add("hidden");
  const showNext = (): void => {
    if (queue.length === 0) {
      showing = false;
      hide();
      return;
    }
    const req = queue.shift()!;
    currentId = req.id;
    toolEl.textContent = req.toolName;
    detailEl.textContent = req.detail || "（无参数）";
    overlay.classList.remove("hidden");
    showing = true;
  };

  const respond = (choice: "once" | "always" | "deny"): void => {
    if (!currentId) return;
    void window.electronAPI.danger.respond(currentId, choice);
    currentId = "";
    hide();
    showNext();
  };

  window.electronAPI.danger.onConfirm((payload) => {
    queue.push(payload);
    if (!showing) showNext();
  });

  onceBtn.addEventListener("click", () => respond("once"));
  alwaysBtn.addEventListener("click", () => respond("always"));
  denyBtn.addEventListener("click", () => respond("deny"));
  closeBtn.addEventListener("click", () => respond("deny"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") respond("deny");
  });
}

initDangerOverlay();

// 提醒触发：在聊天窗显示（无论面板是否打开，消息会保留到打开时可见）
window.electronAPI.tasks.onReminder(({ text }) => {
  window.furinaChat?.showReminder(text);
});
if (fullMode) {
  void initFullMode();
} else {
  void initPetMode();
}
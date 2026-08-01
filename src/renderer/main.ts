// Furina Agent — 渲染进程入口（阶段 2：Live2D 渲染）
import { Live2DManager } from "./live2d/manager";

const canvas = document.getElementById("live2d-canvas") as HTMLCanvasElement;
if (!canvas) throw new Error("Canvas #live2d-canvas not found");

const manager = new Live2DManager(canvas, window.innerWidth, window.innerHeight);

async function main() {
  // 模型在 public/models/furina/ 下，中文文件名需要 URL 编码
  const modelPath = "/models/furina/" + encodeURIComponent("芙宁娜.model3.json");

  try {
    await manager.init(modelPath);
  } catch (err) {
    console.error("[Furina] Failed to load Live2D model:", err);
  }
}

main();

// ===== 诊断：监控模型 scale 和窗口尺寸（排查"拖动后变大"问题） =====
setInterval(() => {
  console.log(
    `[diag] scale=${manager.getScale()?.toFixed(4)} win=${window.innerWidth}x${window.innerHeight} canvas=${canvas.width}x${canvas.height} dpr=${window.devicePixelRatio}`
  );
  manager.dumpAbnormalParams();
}, 2000);

// 启动后延迟检查动画注册
setTimeout(() => manager.dumpMotionDefs(), 6000);

// 监控窗口尺寸变化（排查"无限变大"）
window.addEventListener("resize", () => {
  console.log(`[diag] RESIZE: win=${window.innerWidth}x${window.innerHeight} canvas=${canvas.width}x${canvas.height}`);
});

// ===== 拖拽窗口：按住角色拖动整个窗口 =====
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let lastMoveX = 0;
let lastMoveY = 0;
let lastMoveSentAt = 0;

canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  lastMoveX = e.screenX;
  lastMoveY = e.screenY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  // 节流：每 16ms 最多移动一次，减少 Windows DWM 干扰
  const now = performance.now();
  if (now - lastMoveSentAt < 16) return;
  lastMoveSentAt = now;
  // 增量移动：只发送本帧位移，主进程按 delta 移动窗口
  window.electronAPI.window.moveBy(e.screenX - lastMoveX, e.screenY - lastMoveY);
  lastMoveX = e.screenX;
  lastMoveY = e.screenY;
});

canvas.addEventListener("pointerup", () => {
  dragging = false;
  lastMoveX = 0;
  lastMoveY = 0;
});

// 暴露给调试控制台使用，后续阶段的口型同步也会用到
declare global {
  interface Window {
    furinaLive2d?: Live2DManager;
  }
}
window.furinaLive2d = manager;

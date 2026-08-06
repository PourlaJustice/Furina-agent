// 桌宠右键菜单 · 独立悬浮窗逻辑
// - 表情/动作 → 发送命令给主进程，由桌宠窗口的 Live2D 执行
// - 功能入口 → 聊天/设置/点歌台/退出
// - 标题栏由 CSS -webkit-app-region: drag 原生拖动（可在桌面任意位置移动）

import { EXPRESSION_NAMES, MOTION_NAMES } from "./live2d/names";

function buildGrid(elId: string, items: readonly string[], prefix: string): void {
  const grid = document.getElementById(elId) as HTMLElement;
  for (const name of items) {
    const btn = document.createElement("button");
    btn.className = "pet-menu-item";
    btn.textContent = name;
    btn.dataset.payload = `${prefix}:${name}`;
    grid.appendChild(btn);
  }
}

buildGrid("expr-grid", EXPRESSION_NAMES, "expr");
buildGrid("motion-grid", MOTION_NAMES, "motion");

document.getElementById("menu-close")!.addEventListener("click", () => {
  window.electronAPI.petmenu.close();
});

document.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd], [data-payload]");
  if (!target) return;
  const payload = target.dataset.payload ?? "";
  const cmd = target.dataset.cmd ?? "";
  if (payload) {
    // 表情/动作：执行演出，但保持菜单打开，方便连续尝试
    window.electronAPI.petmenu.command(payload);
  } else if (cmd) {
    // 功能入口：聊天/设置/点歌台/退出 → 执行并关闭菜单
    window.electronAPI.petmenu.command(cmd);
    window.electronAPI.petmenu.close();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.electronAPI.petmenu.close();
});

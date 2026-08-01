# Furina-Agent

基于 Electron + TypeScript + PixiJS 的芙宁娜 Live2D 桌面宠物。

## 功能

- Live2D 芙宁娜桌面宠物（透明无边框置顶窗口）
- 待机动画循环 + 程序化眨眼 + 呼吸效果
- 鼠标跟随（眼珠与头部转向）
- 单击随机动作 / 双击随机表情 / 拖动窗口
- 高 DPI 渲染 + 特写模式 + 遮罩分块修复

## 技术栈

- Electron 43 + TypeScript 5 + Vite 5
- PixiJS 7 + pixi-live2d-display 0.5.0-beta + Cubism Core

## 快速开始

### 1. 准备模型（必需）

芙宁娜模型版权归 miHoYo（原神），作者禁止二次配布，无法随仓库分发。
请从模型作者处自行下载（B 站：BV1D94y1G7Cq），然后：

```text
把模型文件放到:
src/renderer/public/models/furina/
├── 芙宁娜.model3.json
├── 芙宁娜.moc3
├── 芙宁娜.physics3.json
├── 芙宁娜.cdi3.json
├── 芙宁娜.8192/texture_00.png
├── motions/     (4 个动作)
└── expressions/ (17 个表情)
```

### 2. 准备 Cubism Core（必需）

Live2D 官方 SDK（专有许可），从 Cyrene-Agent 仓库或 Live2D 官网获取
`live2dcubismcore.min.js`，放入：

```text
src/renderer/public/live2dcubismcore.min.js
```

### 3. 安装与运行

```bash
npm install
npm run dev
```

## 说明

- 模型文件与 Cubism Core 因版权/许可原因不随仓库分发
- 仅供学习使用，请遵守模型作者的使用条款（禁止商用、禁止二次配布）

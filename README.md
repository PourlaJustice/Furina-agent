# Furina-Agent

基于 Electron + TypeScript + PixiJS 的芙宁娜 Live2D 桌面宠物。

## 功能

- Live2D 芙宁娜桌面宠物（透明无边框置顶窗口）
- 待机动画循环 + 程序化眨眼 + 呼吸效果
- 鼠标跟随（眼珠与头部转向）
- 单击随机动作 / 双击随机表情 / 拖动窗口
- 高 DPI 渲染 + 特写模式 + 遮罩分块修复
- 语音朗读（MiniMax TTS）：
  - 回复按句子切分，边生成边朗读，与文字显示同步
  - 朗读期间 Live2D 口型同步
  - 支持 MiniMax 音色克隆（voice/minimax-furina-voice.mjs）
- DeepSeek AI 聊天：
  - 点击右上角“聊”按钮打开聊天面板
  - 流式回复实时渲染 Markdown（代码块 / 列表 / 表格）
  - 回复时芙宁娜嘴型同步，说话时开口型变化
  - 对话历史保持（最多 30 轮），可清空

## 技术栈

- Electron 43 + TypeScript 5 + Vite 5
- PixiJS 7 + pixi-live2d-display 0.5.0-beta + Cubism Core
- markdown-it（流式 Markdown 渲染）
- DeepSeek Chat Completions（OpenAI 兼容接口，Node 内置 fetch + SSE 解析）

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

Live2D 官方 SDK（专有许可），从 Live2D 官网获取
`live2dcubismcore.min.js`，放入：

```text
src/renderer/public/live2dcubismcore.min.js
```

### 3. 安装与运行

```bash
npm install
npm run dev
```

### 4. 配置 DeepSeek（聊天必需）

方式一（推荐）：启动后在聊天面板点右上角 `⚙ 设置`，填入 API Key，保存即可。

方式二：设置环境变量后重启：

```powershell
$env:DEEPSEEK_API_KEY = "sk-你的密钥"
npm run dev
```

API Key 获取：<https://platform.deepseek.com>（注册后创建）。配置仅保存在本机
`%APPDATA%/furina-agent/chat-config.json`，不会上传。

可选配置项：

| 配置 | 默认值 | 说明 |
| ---- | ------ | ---- |
| API Key | 环境变量 `DEEPSEEK_API_KEY` | 必填 |
| 接口地址 | `https://api.deepseek.com` | 一般不用改 |
| 模型 | `deepseek-chat` | 可换 `deepseek-reasoner` |

## 聊天架构

```
渲染进程 (chat.ts)               主进程 (deepseek.ts)
──────────────                  ─────────────────
用户输入
  → electronAPI.chat.send()   → ipcMain chat:send
                               → fetch DeepSeek (stream: true)
                               → 解析 SSE 增量文本
  ← chat:chunk 事件            ← 逐 chunk 转发
  ← markdown-it 流式渲染
  ← chat:done / chat:error
```

## 世界知识库

LLM 训练数据有截止日期，2025-2026 年的新剧情/新角色模型并不认识。
项目通过 `knowledge/genshin-updates.md` 给芙宁娜注入「近期见闻」——
目前已收录芙宁娜全部主线剧情（4.0-4.2）、传说任务、版本活动、
伙伴奇遇、游戏内「角色故事」全文、官方语音范本、角色关联语音精选，
以及 2025-2026 近况（含桑多涅），每次对话都会随系统提示词一起发给模型。
人设 Prompt（`src/main/index.ts` 中的 `FURINA_SYSTEM_PROMPT`）也已融合
官方语音的语言风格。想让她了解什么新内容，直接编辑该文件即可，无需改代码。

## 说明

- 模型文件与 Cubism Core 因版权/许可原因不随仓库分发
- 仅供学习使用，请遵守模型作者的使用条款（禁止商用、禁止二次配布）

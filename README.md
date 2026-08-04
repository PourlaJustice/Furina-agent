# Furina-Agent 芙宁娜桌面 AI 桌宠

基于 **Electron + TypeScript + Vite + PixiJS** 的芙宁娜（原神）Live2D 桌面宠物。
已完成 9 阶段学习路线：从桌面宠物骨架，到 AI 对话、语音、记忆、知识库、Agent 工具、
LangChain/LangGraph 编排、MCP 外部服务，再到 Rust 原生截图模块。

> 本项目为学习项目，芙宁娜模型版权归 miHoYo（原神），禁止商用、禁止二次配布。

## ✨ 功能总览

| 模块 | 功能 |
| ---- | ---- |
| 🖼️ 桌宠本体 | 透明无边框置顶窗口、待机动画、程序化眨眼/呼吸、鼠标跟随（眼珠+头部）、单击动作 / 双击表情 / 拖动窗口、高 DPI 渲染 |
| 💬 AI 聊天 | DeepSeek 流式对话、Markdown 实时渲染、完整芙宁娜人设提示词、独立全屏聊天窗口（模型+聊天同屏）、对话历史保留/清空 |
| 🎙️ 语音 | MiniMax TTS 逐句合成朗读、朗读时口型同步、支持音色克隆脚本 |
| 🎭 动作表情 | 回复中的（动作/表情）描述自动匹配 Live2D 动作表情，与语音进度同步，重听从头播放 |
| 🧠 记忆系统 | 三层记忆：自动提取用户名字/喜好/近况/目标，长期记住，设置页可查看/清空 |
| 📚 知识库 RAG | 导入 txt / md / json / csv / pdf / docx / xlsx / pptx，本地离线语义检索 + 关键词检索，内置世界书设定 |
| 🛠️ Agent 工具 | 18 个内置工具：时间、计算、网页搜索、文件读写删移、打开路径、待办、提醒、天气、屏幕截图；危险操作弹窗确认 |
| 🔗 LangChain + LangGraph | ReAct Agent 编排（模型决策→调用工具→回填→回答），失败自动回退旧循环 |
| 🔌 MCP 外部服务 | 通过 MCP 协议连接外部工具服务器（stdio / SSE），配置文件即插即用，默认启用文件系统服务器 |
| 🦀 Rust 原生模块 | DXGI + GDI 双通道截图助手，NDJSON IPC 通信，编译成 exe 供 Node 调用 |

## 🛠️ 技术栈

- **框架**：Electron 43 + TypeScript 5 + Vite 5 + Node 24
- **渲染**：PixiJS 7 + pixi-live2d-display 0.5.0-beta + Cubism Core
- **LLM**：DeepSeek Chat Completions（SSE 流式）+ LangChain 1.x + LangGraph 1.x
- **语音**：MiniMax Speech（语音合成 + 音色克隆）
- **MCP**：@modelcontextprotocol/sdk（stdio / SSE 双传输）
- **文档解析**：mammoth（docx）、unpdf（pdf）、xlsx（excel）、jszip、markdown-it
- **原生模块**：Rust 1.97 + windows crate（DXGI / GDI / WIC）

## 📁 目录结构

```text
src/
├── main/                    # 主进程
│   ├── index.ts             # 入口：窗口、IPC、聊天路由、启动初始化
│   ├── agent.ts             # Agent 工具定义与工具循环（18 个内置工具）
│   ├── deepseek.ts          # DeepSeek 流式调用与配置
│   ├── tts.ts               # MiniMax 语音合成
│   ├── memory.ts            # 三层记忆系统
│   ├── rag.ts               # 知识库检索（语义 + 关键词 + 世界书）
│   ├── tasks.ts             # 待办 / 提醒（持久化 + 到点通知）
│   ├── weather.ts           # 天气查询（Open-Meteo）
│   ├── screenshot.ts        # Rust 截图助手客户端（NDJSON）
│   └── ai/
│       ├── graph.ts         # LangGraph ReAct Agent
│       ├── retriever.ts     # LangChain 本地嵌入
│       ├── tools.ts         # LangChain 工具适配
│       └── mcp.ts           # MCP 管理器（stdio / SSE）
├── preload/                 # contextBridge 安全桥接
├── renderer/                # Live2D 渲染 + 聊天 UI
└── shared/                  # IPC 通道常量与共享类型
native/furina-screenshot/    # Rust 截图助手源码（13 个文件）
scripts/                     # 截图助手构建/验证脚本
knowledge/genshin-updates.md # 世界观与近期见闻（注入提示词）
mcp-servers.json             # MCP 服务器配置
```

## 🚀 快速开始

### 1. 准备模型（必需）

芙宁娜模型版权归 miHoYo，无法随仓库分发。请从模型作者处自行下载
（B 站：BV1D94y1G7Cq），放到：

```text
src/renderer/public/models/furina/
├── 芙宁娜.model3.json
├── 芙宁娜.moc3
├── 芙宁娜.physics3.json
├── 芙宁娜.cdi3.json
├── 芙宁娜.8192/texture_00.png
├── motions/     (动作)
└── expressions/ (表情)
```

### 2. 准备 Cubism Core（必需）

从 Live2D 官网获取 `live2dcubismcore.min.js`（专有许可），放到：

```text
src/renderer/public/live2dcubismcore.min.js
```

### 3. 安装与运行

```bash
npm install
npm run dev
```

也可以一键启停：

```powershell
.\start-furina.ps1   # 后台启动
.\stop-furina.ps1    # 关闭
```

### 4. 配置 DeepSeek（聊天必需）

启动后在设置里填入 API Key（推荐），或设置环境变量：

```powershell
$env:DEEPSEEK_API_KEY = "sk-你的密钥"
npm run dev
```

配置仅保存在本机 `%APPDATA%/furina-agent/chat-config.json`，不会上传。

### 5. 可选配置

- **语音（MiniMax）**：设置里填入 API Key、音色 ID，勾选启用；音色克隆见
  `voice/minimax-furina-voice.mjs`
- **知识库**：设置页导入文件/文件夹即可
- **MCP**：编辑 `mcp-servers.json`，按需启用服务器
- **屏幕截图**：首次使用前运行 `npm run build:screenshot-helper` 编译 Rust 助手
  （构建产物在 `resources/bin/`，已加入 .gitignore）

## 🧰 Agent 工具列表

| 分类 | 工具 | 说明 |
| ---- | ---- | ---- |
| 基础 | `get_time` | 当前日期时间 |
| 基础 | `calc` | 安全数学表达式计算 |
| 基础 | `web_search` | Bing 网页搜索 |
| 文件 | `list_dir` / `read_file` | 浏览/读取（支持多格式文档） |
| 文件 | `write_file` / `delete_file` / `move_file` / `open_path` | 写入/删除/移动/打开（危险操作确认） |
| 待办 | `add_todo` / `list_todos` / `complete_todo` / `delete_todo` | 待办增删查改 |
| 提醒 | `add_reminder` / `list_reminders` / `cancel_reminder` | 定时提醒，到点弹系统通知 |
| 天气 | `get_weather` | 今天/明天天气（Open-Meteo） |
| 截图 | `screen_shot` | Rust 原生截图，保存 PNG（隐私操作确认） |

另有 LangGraph 专属 `knowledge_search`（知识库检索）与 MCP 外部工具（自动注册）。

## 🗺️ 学习路线（9 阶段已完成）

| 阶段 | 内容 | 关键产出 |
| ---- | ---- | ---- |
| 0-1 | 环境 + Electron + TS 骨架 | 三进程模型、IPC、Vite 构建 |
| 2 | Live2D 渲染 | PixiJS + Cubism 桌宠窗口 |
| 3 | LLM 聊天 | DeepSeek 流式 + Markdown |
| 4 | TTS 语音 | MiniMax 合成 + 口型同步 |
| 5 | 动作表情 | 对话动作/表情自动触发 |
| 6 | 记忆 + 知识库 | 三层记忆 + RAG 多格式导入 |
| 7 | Agent 编排 | 工具系统 + LangChain/LangGraph |
| 8 | MCP 集成 | 外部工具服务器（stdio/SSE） |
| 9 | Rust 原生模块 | DXGI/GDI 截图助手 + NDJSON IPC |

## 📝 说明

- 模型文件与 Cubism Core 因版权/许可原因不随仓库分发
- API Key 均只保存在本机，不上传
- 仅供学习交流，请遵守模型作者的使用条款

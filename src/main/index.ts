import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { IPC_CHANNELS } from '../shared/ipc-channels';

// Windows 透明窗口开关
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// ---- 诊断信息 ----
console.log('[Furina] Platform:', process.platform);
console.log('[Furina] Electron:', process.versions.electron);
console.log('[Furina] Chromium:', process.versions.chrome);

let mainWindow: BrowserWindow | null = null;
// 固定窗口尺寸（防 Windows 透明窗口移动时 DWM 尺寸漂移）
const FIXED_WIDTH = 305;
const FIXED_HEIGHT = 505;
let correctingSize = false;

// 编译后 __dirname = dist/main/main/ → ../.. = dist/
const ROOT = path.join(__dirname, '../..');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 300,
    height: 500,
    x: 50,
    y: 50,
    frame: false,
    transparent: true,
    hasShadow: false, // ★ 透明窗口必须有：否则 Windows DWM 移动时尺寸漂移
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 必须在窗口创建后调用
  mainWindow.setBackgroundColor('#00000000');

  // 诊断：监控窗口尺寸变化
  mainWindow.on('resize', () => {
    if (!mainWindow || correctingSize) return;
    const [w, h] = mainWindow.getSize();
    if (w !== FIXED_WIDTH || h !== FIXED_HEIGHT) {
      console.log(`[Furina] drift detected ${w}x${h}, correcting to ${FIXED_WIDTH}x${FIXED_HEIGHT}`);
      correctingSize = true;
      mainWindow.setSize(FIXED_WIDTH, FIXED_HEIGHT);
      correctingSize = false;
    }
  });
  mainWindow.on('move', () => {
    // 只在移动时打印一次初始位置
  });

  // 调试：把渲染进程 console 输出写入日志，便于验证 Live2D 加载
  const logPath = path.join(__dirname, '../../../renderer-log.txt');
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    try {
      fs.appendFileSync(logPath, `[renderer] ${new Date().toISOString()} ${message}\n`);
    } catch {
      // 忽略日志写入失败
    }
  });

  // 诊断：打印窗口当前的背景色设置
  console.log('[Furina] Window transparent:', mainWindow.isVisible());

  if (process.env.VITE_DEV) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(ROOT, 'renderer/index.html'));
  }

  // 加载完成后打印窗口信息
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Furina] Window loaded, bounds:', mainWindow?.getBounds());

    // 阶段2 验证：模型加载后截图保存，用于确认渲染结果
    setTimeout(async () => {
      try {
        const image = await mainWindow?.webContents.capturePage();
        if (image) {
          const shotPath = path.join(__dirname, '../../../furina-window.png');
          fs.writeFileSync(shotPath, image.toPNG());
          console.log('[Furina] Screenshot saved:', shotPath);
        }
      } catch (err) {
        console.error('[Furina] Screenshot failed:', err);
      }
    }, 15000);

    // 诊断：检查 CSS 背景是否正确应用
    mainWindow?.webContents.executeJavaScript(
      `JSON.stringify({
        htmlBg: getComputedStyle(document.documentElement).background,
        bodyBg: getComputedStyle(document.body).background,
      })`
    ).then((result: string) => {
      console.log('[Furina] CSS check:', result);
    });
  });
}

ipcMain.handle(IPC_CHANNELS.APP_VERSION, () => '0.1.0');

// 拖拽窗口：渲染进程按住角色拖动时，主进程按位移移动窗口
ipcMain.on(IPC_CHANNELS.WINDOW_MOVE_BY, (event, dx: number, dy: number) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const [x, y] = win.getPosition();
  // ★ 始终使用固定宽高，防止 Windows 移动透明窗口时尺寸漂移
  win.setBounds({ x: x + Math.round(dx), y: y + Math.round(dy), width: FIXED_WIDTH, height: FIXED_HEIGHT });
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

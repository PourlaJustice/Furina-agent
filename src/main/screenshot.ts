// 阶段 9：Rust 截图助手客户端（NDJSON over stdin/stdout）
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface CaptureRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Pending {
  resolve: (msg: any) => void;
  timer: NodeJS.Timeout;
}

class ScreenshotHelper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private buffer = '';

  private resolveExe(): string | null {
    const candidates = [
      path.join(app.getAppPath(), 'resources', 'bin', 'furina-screenshot.exe'),
      path.join(app.getAppPath(), 'native', 'furina-screenshot', 'target', 'release', 'furina-screenshot.exe'),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }

  isAvailable(): boolean {
    return this.resolveExe() !== null;
  }

  private ensureStarted(): boolean {
    if (this.proc) return true;
    const exe = this.resolveExe();
    if (!exe) return false;
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: string };
          const id = msg?.id ?? '';
          const p = id ? this.pending.get(id) : undefined;
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.resolve(msg);
          }
        } catch {
          // 忽略无法解析的行
        }
      }
    });
    this.proc.on('exit', () => {
      this.proc = null;
    });
    return true;
  }

  private request(req: Record<string, unknown>): Promise<any> {
    if (!this.ensureStarted()) {
      return Promise.reject(new Error('截图助手未找到，请先运行 npm run build:screenshot-helper'));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('截图请求超时'));
      }, 20_000);
      this.pending.set(id, { resolve, timer });
      this.proc!.stdin.write(JSON.stringify({ ...req, id }) + '\n');
    });
  }

  async captureRegion(region: CaptureRegion): Promise<{ data: string; width: number; height: number }> {
    const msg = await this.request({ type: 'capture', region });
    if (!msg.ok) throw new Error(msg.error || '截图失败');
    return { data: msg.data as string, width: msg.width as number, height: msg.height as number };
  }

  async captureWindow(title: string): Promise<{ data: string; width: number; height: number }> {
    const msg = await this.request({ type: 'capture_window', title });
    if (!msg.ok) throw new Error(msg.error || '窗口截图失败');
    return { data: msg.data as string, width: msg.width as number, height: msg.height as number };
  }

  stop(): void {
    try {
      this.proc?.stdin.write(JSON.stringify({ type: 'exit', id: 'stop' }) + '\n');
    } catch {
      // ignore
    }
  }
}

export const screenshotHelper = new ScreenshotHelper();

/** 保存截图并返回描述文本（供 Agent 工具调用） */
export async function screenshotTool(
  windowTitle: string,
  regionRaw: unknown,
  savePath: string,
): Promise<string> {
  let shot: { data: string; width: number; height: number };
  if (windowTitle.trim()) {
    shot = await screenshotHelper.captureWindow(windowTitle.trim());
  } else {
    const region = regionRaw as CaptureRegion | undefined;
    // w/h 为 0 时 Rust 端会按整个主屏幕处理
    shot = await screenshotHelper.captureRegion(region ?? { x: 0, y: 0, w: 0, h: 0 });
  }
  const dir = savePath.trim()
    ? path.dirname(savePath.trim())
    : path.join(app.getPath('desktop'), 'furina-screenshots');
  const file = savePath.trim() || path.join(dir, `furina-${Date.now()}.png`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const sizeKB = Math.round(fs.statSync(file).size / 1024);
  return `已截图并保存：${file}（${shot.width}x${shot.height}，${sizeKB}KB）。需要的话可以打开它或继续分析。`;
}

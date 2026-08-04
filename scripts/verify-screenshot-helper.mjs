// 验证截图助手 exe：版本 + 自检
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'resources', 'bin', 'furina-screenshot.exe');

if (!fs.existsSync(exe)) {
  console.error('未找到 exe，请先运行 npm run build:screenshot-helper');
  process.exit(1);
}
const v = spawnSync(exe, ['--version'], { encoding: 'utf8' });
if (v.status !== 0 || !v.stdout.includes('0.1.0')) {
  console.error('版本校验失败:', v.stderr || v.stdout);
  process.exit(1);
}
const t = spawnSync(exe, ['--test'], { encoding: 'utf8' });
if (t.status !== 0) {
  console.error('自检失败:', t.stderr || t.stdout);
  process.exit(1);
}
console.log('OK:', v.stdout.trim(), '|', t.stdout.trim());

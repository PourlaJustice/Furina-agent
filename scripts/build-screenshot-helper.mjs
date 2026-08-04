// 编译 Rust 截图助手（cargo build --release）并复制到 resources/bin
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(root, 'native', 'furina-screenshot');
const manifest = path.join(nativeDir, 'Cargo.toml');
const cargo = path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe');
const mingwBin = 'C:\\tools\\w64devkit-dist\\w64devkit\\bin';
const rustLld = path.join(
  os.homedir(),
  '.rustup',
  'toolchains',
  'stable-x86_64-pc-windows-gnu',
  'lib',
  'rustlib',
  'x86_64-pc-windows-gnu',
  'bin',
  'rust-lld.exe',
);

const env = { ...process.env };
if (fs.existsSync(mingwBin)) env.PATH = mingwBin + path.delimiter + env.PATH;
env.RUSTFLAGS = `-C linker=${rustLld} -C link-self-contained=yes`;

console.log('Building Rust screenshot helper (cargo build --release)...');
const r = spawnSync(cargo, ['build', '--release', '--manifest-path', manifest], {
  stdio: 'inherit',
  env,
});
if (r.status !== 0) process.exit(r.status ?? 1);

const exe = path.join(nativeDir, 'target', 'release', 'furina-screenshot.exe');
const destDir = path.join(root, 'resources', 'bin');
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(exe, path.join(destDir, 'furina-screenshot.exe'));
console.log('OK ->', path.join(destDir, 'furina-screenshot.exe'));

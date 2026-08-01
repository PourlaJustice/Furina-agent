const fs = require('fs');
const zlib = require('zlib');

const buf = fs.readFileSync('E:/Desktop/Furina-agent/furina-window.png');
let off = 8;
let width = 0;
let height = 0;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  const data = buf.slice(off + 8, off + 8 + len);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
  } else if (type === 'IDAT') {
    idat.push(data);
  }
  off += 12 + len;
}

const raw = zlib.inflateSync(Buffer.concat(idat));
const bpp = 4;
const stride = width * bpp;
const pixels = Buffer.alloc(stride * height);
let pos = 0;
for (let y = 0; y < height; y++) {
  const filter = raw[pos++];
  const rs = y * stride;
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? pixels[rs + x - bpp] : 0;
    const b = y > 0 ? pixels[rs - stride + x] : 0;
    const c = y > 0 && x >= bpp ? pixels[rs - stride + x - bpp] : 0;
    const cur = raw[pos++];
    let val;
    switch (filter) {
      case 0: val = cur; break;
      case 1: val = cur + a; break;
      case 2: val = cur + b; break;
      case 3: val = cur + Math.floor((a + b) / 2); break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        val = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        break;
      }
      default: val = cur;
    }
    pixels[rs + x] = val & 0xff;
  }
}

console.log(`Window shot ${width}x${height}`);
// 文字特征：亮像素（白字）或暗像素（黑字）在局部形成笔画。扫描所有 16px 块。
const BS = 16;
const blocks = [];
for (let by = 0; by < height / BS; by++) {
  for (let bx = 0; bx < width / BS; bx++) {
    let bright = 0, dark = 0, total = 0;
    for (let y = by * BS; y < Math.min((by + 1) * BS, height); y++) {
      for (let x = bx * BS; x < Math.min((bx + 1) * BS, width); x++) {
        const i = (y * width + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
        if (a < 60) continue;
        total++;
        if (r > 190 && g > 190 && b > 190) bright++;
        else if (r < 80 && g < 80 && b < 80) dark++;
      }
    }
    const dp = dark / Math.max(1, total);
    const bp = bright / Math.max(1, total);
    // 文字块：暗或亮占 15-85%，且不是纯色
    if ((dp > 0.15 && dp < 0.85) || (bp > 0.15 && bp < 0.85)) {
      blocks.push({ bx, by, dp, bp, total });
    }
  }
}

// 找连续行带
const rows = new Map();
for (const b of blocks) {
  if (!rows.has(b.by)) rows.set(b.by, []);
  rows.get(b.by).push(b);
}
const bands = [];
let cur = [];
for (let by = 0; by < height / BS; by++) {
  if (rows.has(by) && rows.get(by).length >= 4) cur.push(by);
  else {
    if (cur.length >= 2) bands.push(cur);
    cur = [];
  }
}
if (cur.length >= 2) bands.push(cur);

console.log('Row bands with text-like blocks:');
for (const band of bands) {
  const xs = [];
  for (const by of band) for (const b of rows.get(by)) xs.push(b.bx * BS);
  console.log(`  y=${Math.min(...band) * BS}-${(Math.max(...band) + 1) * BS}, x=${Math.min(...xs)}-${Math.max(...xs) + BS}`);
}

// 打印整个窗口的块图（. 空 / d 暗 / b 亮 / m 混合）
console.log('\nBlock map (whole window):');
for (let by = 0; by < height / BS; by++) {
  let line = '';
  for (let bx = 0; bx < width / BS; bx++) {
    const b = blocks.find((v) => v.bx === bx && v.by === by);
    if (!b) line += ' ';
    else if (b.dp > 0.15 && b.bp > 0.15) line += 'm';
    else if (b.dp > 0.15) line += 'd';
    else line += 'b';
  }
  console.log(line.replace(/\s+$/, ''));
}

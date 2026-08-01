const fs = require('fs');
const zlib = require('zlib');

const base = 'E:/Desktop/Furina-agent/src/renderer/public/models/furina';
const dir = fs.readdirSync(base).find((d) => d.includes('8192'));
const buf = fs.readFileSync(base + '/' + dir + '/texture_00.png');

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

// 检查 6 个候选区域（3 个 drawable x 2 种 V 方向），找文字
const regions = [
  ['A13 v-down', 28, 7033, 187, 149],
  ['A13 v-up', 28, 1010, 187, 149],
  ['A14 v-down', 1088, 4620, 526, 354],
  ['A14 v-up', 1088, 3391, 526, 354],
  ['A15 v-down', 5250, 6547, 522, 345],
  ['A15 v-up', 5250, 1300, 522, 345],
];
for (const [label, rx, ry, rw, rh] of [
  ['A13 uv', 28, 1010, 187, 149],
  ['A14 uv', 1088, 3391, 526, 354],
  ['A15 uv', 5250, 1300, 522, 345],
]) {
  console.log(`\n===== ${label} (${rx},${ry},${rw}x${rh}) =====`);
  // 统计 alpha 分布
  let a0 = 0, aLow = 0, aHigh = 0, total = 0;
  for (let y = ry; y < ry + rh; y += 2) {
    for (let x = rx; x < rx + rw; x += 2) {
      const a = pixels[(y * width + x) * 4 + 3];
      total++;
      if (a === 0) a0++;
      else if (a < 200) aLow++;
      else aHigh++;
    }
  }
  console.log(`  alpha: transparent=${a0} (${((a0/total)*100).toFixed(1)}%), semi=${aLow} (${((aLow/total)*100).toFixed(1)}%), opaque=${aHigh} (${((aHigh/total)*100).toFixed(1)}%)`);
  const BS = 16;
  const cx0 = rx, cy0 = ry, cw = rw, ch = rh;
const blockAvgs = [];
for (let by = 0; by < ch / BS; by++) {
  const row = [];
  for (let bx = 0; bx < cw / BS; bx++) {
    let sum = 0, n = 0;
    for (let y = cy0 + by * BS; y < Math.min(cy0 + (by + 1) * BS, cy0 + ch); y++) {
      for (let x = cx0 + bx * BS; x < Math.min(cx0 + (bx + 1) * BS, cx0 + cw); x++) {
        const i = (y * width + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
        if (a < 20) continue;
        n++;
        sum += (r + g + b) / 3;
      }
    }
    row.push(n > 0 ? sum / n : -1);
  }
  blockAvgs.push(row);
}

// 字符画：亮度等级
for (let by = 0; by < blockAvgs.length; by++) {
  let line = '';
  for (let bx = 0; bx < blockAvgs[by].length; bx++) {
    const v = blockAvgs[by][bx];
    if (v < 0) line += ' ';
    else if (v < 60) line += '@';
    else if (v < 100) line += '#';
    else if (v < 140) line += '*';
    else if (v < 180) line += '+';
    else if (v < 215) line += '.';
    else line += ' ';
  }
  console.log(line);
}
}

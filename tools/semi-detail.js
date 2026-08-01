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

// 细看半透明区：x=0-2048, y=2500-3650，32px 块字符画（alpha 30-230 密度）
const BS = 32;
const cx0 = 0, cy0 = 2500, cw = 2048, ch = 1150;
console.log('Semi-alpha density map (x=0-2048, y=2500-3650):');
for (let by = 0; by < ch / BS; by++) {
  let line = '';
  for (let bx = 0; bx < cw / BS; bx++) {
    let semi = 0, total = 0;
    for (let y = cy0 + by * BS; y < cy0 + (by + 1) * BS; y += 2) {
      for (let x = cx0 + bx * BS; x < cx0 + (bx + 1) * BS; x += 2) {
        const i = (y * width + x) * 4;
        const a = pixels[i + 3];
        total++;
        if (a > 30 && a < 230) semi++;
      }
    }
    const p = semi / total;
    line += p > 0.7 ? '#' : p > 0.4 ? '*' : p > 0.15 ? '+' : p > 0.05 ? '.' : ' ';
  }
  console.log(line);
}

// 统计该区域半透明像素的平均颜色
let rSum = 0, gSum = 0, bSum = 0, aSum = 0, n = 0;
for (let y = cy0; y < cy0 + ch; y += 2) {
  for (let x = cx0; x < cx0 + cw; x += 2) {
    const i = (y * width + x) * 4;
    const a = pixels[i + 3];
    if (a > 30 && a < 230) {
      rSum += pixels[i]; gSum += pixels[i + 1]; bSum += pixels[i + 2]; aSum += a;
      n++;
    }
  }
}
if (n > 0) {
  console.log(`\nSemi pixels: ${n}, avg RGBA = (${Math.round(rSum / n)},${Math.round(gSum / n)},${Math.round(bSum / n)},${Math.round(aSum / n)})`);
}

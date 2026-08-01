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

// C 块：x=0-2048, y=2048-4096。按 32px 块计算边缘密度（与邻域均值差异）
const BS = 32;
const cx0 = 0, cy0 = 2048, cw = 2048, ch = 2048;
const scores = [];
for (let by = 0; by < ch / BS; by++) {
  for (let bx = 0; bx < cw / BS; bx++) {
    // 先算块内平均亮度
    let lumSum = 0;
    let n = 0;
    for (let y = cy0 + by * BS; y < cy0 + (by + 1) * BS; y += 2) {
      for (let x = cx0 + bx * BS; x < cx0 + (bx + 1) * BS; x += 2) {
        const i = (y * width + x) * 4;
        const a = pixels[i + 3];
        if (a < 40) continue;
        lumSum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        n++;
      }
    }
    if (n < 16) continue;
    const avg = lumSum / n;
    // 统计与均值差异大的像素（边缘）
    let edges = 0;
    let eN = 0;
    for (let y = cy0 + by * BS; y < cy0 + (by + 1) * BS; y += 2) {
      for (let x = cx0 + bx * BS; x < cx0 + (bx + 1) * BS; x += 2) {
        const i = (y * width + x) * 4;
        const a = pixels[i + 3];
        if (a < 40) continue;
        const lum = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        if (Math.abs(lum - avg) > 45) edges++;
        eN++;
      }
    }
    const edgeRatio = edges / Math.max(1, eN);
    scores.push({ bx, by, edgeRatio, avg });
  }
}

scores.sort((p, q) => q.edgeRatio - p.edgeRatio);
console.log('Top 40 high-edge 32px blocks in C region:');
for (const s of scores.slice(0, 40)) {
  console.log(`  (${s.bx},${s.by}) -> px(${s.bx * BS},${cy0 + s.by * BS}) edgeRatio=${s.edgeRatio.toFixed(2)} avgLum=${s.avg.toFixed(0)}`);
}

// 聚合 4x4 块找密集区域
const agg = new Map();
for (const s of scores) {
  const kx = Math.floor(s.bx / 4);
  const ky = Math.floor(s.by / 4);
  const key = `${kx},${ky}`;
  if (!agg.has(key)) agg.set(key, { kx, ky, n: 0, sum: 0 });
  const a = agg.get(key);
  a.n++;
  a.sum += s.edgeRatio;
}
const aggs = [...agg.values()].sort((p, q) => q.sum - p.sum);
console.log('\nTop 20 clustered edge regions (128px cells):');
for (const a of aggs.slice(0, 20)) {
  console.log(`  cell(${a.kx},${a.ky}) -> px(${a.kx * 128},${cy0 + a.ky * 128}) blocks=${a.n} sum=${a.sum.toFixed(2)}`);
}

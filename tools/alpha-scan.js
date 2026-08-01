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

// 全图扫描 alpha 在 30-230 的"半透明"像素，按 64px 块聚簇
const BS = 64;
const counts = [];
for (let by = 0; by < height / BS; by++) {
  for (let bx = 0; bx < width / BS; bx++) {
    let semi = 0;
    for (let y = by * BS; y < (by + 1) * BS; y += 2) {
      for (let x = bx * BS; x < (bx + 1) * BS; x += 2) {
        const a = pixels[(y * width + x) * 4 + 3];
        if (a > 30 && a < 230) semi++;
      }
    }
    if (semi > 40) counts.push({ bx, by, semi });
  }
}
counts.sort((p, q) => q.semi - p.semi);
console.log('Top 40 semi-transparent 64px blocks:');
for (const c of counts.slice(0, 40)) {
  console.log(`  (${c.bx},${c.by}) -> px(${c.bx * BS},${c.by * BS}) semi=${c.semi}`);
}

// 聚合 8x8 块（512px）找密集区
const agg = new Map();
for (const c of counts) {
  const kx = Math.floor(c.bx / 8), ky = Math.floor(c.by / 8);
  const key = `${kx},${ky}`;
  if (!agg.has(key)) agg.set(key, { kx, ky, n: 0, sum: 0 });
  const a = agg.get(key);
  a.n++;
  a.sum += c.semi;
}
const aggs = [...agg.values()].sort((p, q) => q.sum - p.sum);
console.log('\nTop 20 clustered semi-transparent regions (512px):');
for (const a of aggs.slice(0, 20)) {
  console.log(`  cell(${a.kx},${a.ky}) -> px(${a.kx * 512},${a.ky * 512}) blocks=${a.n} semi=${a.sum}`);
}

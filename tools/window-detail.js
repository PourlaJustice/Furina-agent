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

// 区域：y=110-260, x=120-290，3x3 块字符画
const BS = 3;
for (let by = 0; by < 50; by++) {
  let line = '';
  for (let bx = 0; bx < 57; bx++) {
    let bright = 0, dark = 0, total = 0;
    for (let y = 110 + by * BS; y < Math.min(110 + (by + 1) * BS, 260); y++) {
      for (let x = 120 + bx * BS; x < Math.min(120 + (bx + 1) * BS, 290); x++) {
        const i = (y * width + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
        if (a < 40) continue;
        total++;
        if (r > 170 && g > 170 && b > 170) bright++;
        else if (r < 100 && g < 100 && b < 100) dark++;
      }
    }
    if (bright / Math.max(1, total) > 0.4) line += 'b';
    else if (dark / Math.max(1, total) > 0.4) line += 'd';
    else if (total > 0) line += '.';
    else line += ' ';
  }
  console.log(line);
}

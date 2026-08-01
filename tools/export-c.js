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

// 编码 PNG（RGBA8）
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const rawData = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    rawData[y * (stride + 1)] = 0;
    rgba.copy(rawData, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawData, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// C 块：x=0-2048, y=2048-4096 -> 1024x1024 (步长 2)
const thumb = 1024;
const step = 2;
const out = Buffer.alloc(thumb * thumb * 4);
for (let ty = 0; ty < thumb; ty++) {
  for (let tx = 0; tx < thumb; tx++) {
    const sx = tx * step;
    const sy = 2048 + ty * step;
    const i = (sy * width + sx) * 4;
    const o = (ty * thumb + tx) * 4;
    out[o] = pixels[i];
    out[o + 1] = pixels[i + 1];
    out[o + 2] = pixels[i + 2];
    out[o + 3] = pixels[i + 3];
  }
}
const file = 'E:/Desktop/Furina-agent/quad_C_hires.png';
fs.writeFileSync(file, encodePNG(thumb, thumb, out));
console.log('Saved', file);

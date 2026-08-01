const fs = require('fs');
const zlib = require('zlib');

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // 支持 colorType 2 (RGB) 和 6 (RGBA)
  const bpp = colorType === 6 ? 4 : 3;
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
  return { width, height, colorType, bpp, pixels };
}

function scanText(img, label) {
  const { width, height, bpp, pixels } = img;
  console.log(`\n===== ${label} (${width}x${height}) =====`);
  // 32px 块：找暗/亮文字笔画（对比度高的块）
  const BS = 32;
  const rows = new Map();
  for (let by = 0; by < Math.ceil(height / BS); by++) {
    for (let bx = 0; bx < Math.ceil(width / BS); bx++) {
      let dark = 0, bright = 0, total = 0;
      for (let y = by * BS; y < Math.min((by + 1) * BS, height); y += 2) {
        for (let x = bx * BS; x < Math.min((bx + 1) * BS, width); x += 2) {
          const i = (y * width + x) * bpp;
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          total++;
          if (r < 90 && g < 90 && b < 90) dark++;
          else if (r > 185 && g > 185 && b > 185) bright++;
        }
      }
      const dp = dark / Math.max(1, total), bp = bright / Math.max(1, total);
      // 文字：暗或亮占 15-85%（不是纯色块）
      if ((dp > 0.15 && dp < 0.85) || (bp > 0.15 && bp < 0.85)) {
        if (!rows.has(by)) rows.set(by, []);
        rows.get(by).push({ bx, dp, bp });
      }
    }
  }
  // 找连续行带
  const bands = [];
  let cur = [];
  for (let by = 0; by < Math.ceil(height / BS); by++) {
    if (rows.has(by) && rows.get(by).length >= 4) cur.push(by);
    else {
      if (cur.length >= 2) bands.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) bands.push(cur);
  for (const band of bands) {
    const xs = [];
    for (const by of band) for (const b of rows.get(by)) xs.push(b.bx * BS);
    console.log(`  text band: y=${Math.min(...band) * BS}-${(Math.max(...band) + 1) * BS}, x=${Math.min(...xs)}-${Math.max(...xs) + BS}`);
  }
  if (bands.length === 0) console.log('  (no text-like bands found)');
}

const folder = 'E:/Desktop/芙宁娜免费模型';
scanText(decodePNG(folder + '/芙宁娜杂谈背景.png'), '杂谈背景');
scanText(decodePNG(folder + '/芙宁娜直播背景.png'), '直播背景');
const prpr = folder + '/芙宁娜（prpr、直播姬）';
scanText(decodePNG(prpr + '/头像.png'), '头像');

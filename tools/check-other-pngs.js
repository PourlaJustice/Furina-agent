const fs = require('fs');

function pngInfo(file) {
  const buf = fs.readFileSync(file);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const ct = buf[25];
  return `${file.split('/').pop()}: ${w}x${h} colorType=${ct}`;
}

const folder = 'E:/Desktop/芙宁娜免费模型';
const items = fs.readdirSync(folder);
console.log('Folder items:');
for (const item of items) {
  const full = folder + '/' + item;
  if (fs.statSync(full).isFile()) {
    console.log('  ', pngInfo(full));
  } else {
    console.log('  [dir]', item);
    const sub = fs.readdirSync(full);
    for (const f of sub) {
      if (/\.png$/i.test(f)) {
        console.log('     ', pngInfo(full + '/' + f));
      }
    }
  }
}

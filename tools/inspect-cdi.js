const fs = require('fs');

const base = 'E:/Desktop/Furina-agent/src/renderer/public/models/furina';
const file = fs.readdirSync(base).find((f) => f.endsWith('.cdi3.json'));
const json = JSON.parse(fs.readFileSync(base + '/' + file, 'utf8'));

console.log('Top-level keys:', Object.keys(json));
const parts = json.Parts || [];
console.log('Total parts:', parts.length);
const params = json.Parameters || [];
console.log('Total parameters:', params.length);
const eyeParams = params.filter((p) => /Eye|EyeL|EyeR|Blink|Mouth/i.test(p.Id || p.Name || ''));
console.log('Eye/mouth related parameters:');
eyeParams.forEach((p) => console.log('  ', JSON.stringify(p).slice(0, 160)));
// 找可能的缩放参数
const scaleParams = params.filter((p) => /Scale|大小|放大|缩放/i.test(JSON.stringify(p)));
console.log('Possible scale parameters:', scaleParams.length);
scaleParams.forEach((p) => console.log('  ', JSON.stringify(p).slice(0, 160)));
// 身体/头部/呼吸相关参数
const bodyParams = params.filter((p) => /Body|Angle|呼吸|胸|身/i.test(JSON.stringify(p)));
console.log('\nBody/angle/breath parameters:');
bodyParams.forEach((p) => console.log('  ', JSON.stringify(p).slice(0, 160)));
const wmKeywords = ['水印', '版权', '娱乐', '盈利', '禁止', '仅供', 'WATER', 'COPY', 'TEXT', 'logo', 'Logo', 'wm'];
const hit = parts.filter((p) => {
  const s = JSON.stringify(p);
  return wmKeywords.some((k) => s.includes(k));
});
console.log('Parts matching watermark keywords:', hit.length);
hit.forEach((p) => console.log('  ', JSON.stringify(p).slice(0, 200)));
console.log('\nFirst 20 parts:');
parts.slice(0, 20).forEach((p, i) => console.log(`  [${i}]`, JSON.stringify(p).slice(0, 120)));
console.log('\nLast 20 parts:');
parts.slice(-20).forEach((p, i) => console.log(`  [${parts.length - 20 + i}]`, JSON.stringify(p).slice(0, 120)));
const jsonStr = JSON.stringify(json);
const keywords = ['水印', '版权', '娱乐', '盈利', '禁止', 'WATER', 'COPY', 'TEXT', 'logo', 'Logo'];
for (const k of keywords) {
  if (jsonStr.includes(k)) {
    console.log('Found keyword:', k);
    const idx = jsonStr.indexOf(k);
    console.log('  context:', jsonStr.slice(Math.max(0, idx - 80), idx + 80));
  }
}

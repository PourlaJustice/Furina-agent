// 文档解析器（纯 Node，不依赖 electron，便于单独测试）
// 支持：txt / md / json / csv / pdf / docx / xlsx / pptx

import fs from 'node:fs';
import path from 'node:path';

export const SUPPORTED_EXT = ['.txt', '.md', '.json', '.csv', '.pdf', '.docx', '.xlsx', '.pptx'];

/** 读取并解析任意支持格式的文件为纯文本；解析失败返回 null */
export async function parseFileText(file: string): Promise<string | null> {
  const ext = path.extname(file).toLowerCase();
  try {
    switch (ext) {
      case '.txt':
      case '.md':
        return fs.readFileSync(file, 'utf-8');
      case '.json':
        try {
          return JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf-8')), null, 2);
        } catch {
          return fs.readFileSync(file, 'utf-8');
        }
      case '.csv':
        return fs.readFileSync(file, 'utf-8');
      case '.pdf':
        return await parsePdf(file);
      case '.docx':
        return await parseDocx(file);
      case '.xlsx':
        return await parseXlsx(file);
      case '.pptx':
        return await parsePptx(file);
      default:
        return null;
    }
  } catch (err) {
    console.error('[RAG] 文档解析失败:', file, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** PDF：用 unpdf（基于 pdf.js）提取全部页文本 */
async function parsePdf(file: string): Promise<string | null> {
  const { extractText } = (await import('unpdf')) as { extractText: (data: Uint8Array) => Promise<{ text: string[] }> };
  const { text } = await extractText(new Uint8Array(fs.readFileSync(file)));
  return Array.isArray(text) ? text.join('\n') : String(text ?? '');
}

/** DOCX：用 mammoth 提取纯文本 */
async function parseDocx(file: string): Promise<string | null> {
  const mammoth = (await import('mammoth')) as {
    extractRawText: (input: { path: string }) => Promise<{ value: string }>;
  };
  const result = await mammoth.extractRawText({ path: file });
  return result.value;
}

/** XLSX：用 SheetJS 读取每个工作表转 CSV 文本 */
async function parseXlsx(file: string): Promise<string | null> {
  const XLSX = (await import('xlsx')) as typeof import('xlsx');
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    parts.push(`【工作表：${name}】\n${csv}`);
  }
  return parts.join('\n\n');
}

/** PPTX：解压后按页提取幻灯片里的文字 */
async function parsePptx(file: string): Promise<string | null> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/\d+/)?.[0] ?? 0);
      const nb = Number(b.match(/\d+/)?.[0] ?? 0);
      return na - nb;
    });
  const parts: string[] = [];
  let pageNo = 0;
  for (const name of slideNames) {
    const xml = await zip.files[name].async('string');
    const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
      .map((m) => m[1].trim())
      .filter(Boolean);
    if (texts.length > 0) {
      pageNo += 1;
      parts.push(`【第 ${pageNo} 页】\n${texts.join('\n')}`);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}
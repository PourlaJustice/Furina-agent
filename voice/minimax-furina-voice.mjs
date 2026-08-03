#!/usr/bin/env node
// 芙宁娜音色制作脚本（MiniMax）
// 用法：
//   1) node minimax-furina-voice.mjs prepare
//       把 voice/ref/ 里的语音片段合并成 voice/ref/furina-ref.mp3
//   2) node minimax-furina-voice.mjs clone <API_KEY> [voiceId]
//       上传参考音频并克隆音色，默认音色名 furina
//   3) node minimax-furina-voice.mjs speak <API_KEY> <voiceId> "要合成的话" [输出.mp3]
//       用克隆好的音色合成一段语音（默认输出 voice/out/试听.mp3）
//
// 依赖：Node.js 22+（自带 fetch 与 WebSocket，无需安装任何包）
// API 文档：https://platform.minimaxi.com/document

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF_DIR = path.join(__dirname, "ref");
const OUT_DIR = path.join(__dirname, "out");
const REF_FILE = path.join(REF_DIR, "furina-ref.mp3");
const BASE_URL = "https://api.minimaxi.com";
const WS_URL = "wss://api.minimaxi.com/ws/v1/t2a_v2";

// ---------- 1. 合并参考音频 ----------
function stripId3(buf) {
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size =
      ((buf[6] & 0x7f) << 21) |
      ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) |
      (buf[9] & 0x7f);
    return buf.subarray(10 + size);
  }
  return buf;
}

function prepare() {
  if (!fs.existsSync(REF_DIR)) fs.mkdirSync(REF_DIR, { recursive: true });
  const files = fs
    .readdirSync(REF_DIR)
    .filter((f) => f.endsWith(".mp3") && f !== "furina-ref.mp3")
    .sort();
  if (files.length === 0) {
    console.error("voice/ref/ 下没有音频片段，请先放入芙宁娜的语音 mp3。");
    process.exit(1);
  }
  const parts = [];
  let totalSec = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(REF_DIR, f));
    parts.push(stripId3(buf));
    totalSec += (buf.length * 8) / (64 * 1000); // 按 64kbps 估算时长
  }
  fs.writeFileSync(REF_FILE, Buffer.concat(parts));
  const sizeMB = (fs.statSync(REF_FILE).size / 1024 / 1024).toFixed(2);
  console.log(`已合并 ${files.length} 段 → ${REF_FILE}`);
  console.log(`总时长约 ${totalSec.toFixed(0)} 秒（要求 10 秒 ~ 5 分钟），大小 ${sizeMB}MB（要求 ≤20MB）`);
}

// ---------- 2. 上传音频 ----------
async function uploadFile(apiKey, filePath, purpose) {
  const fileBuffer = fs.readFileSync(filePath);
  const boundary = "----FurinaTTS" + Math.random().toString(36).slice(2);
  const fileName = path.basename(filePath);
  const parts = [];
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n`
    )
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    )
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const resp = await fetch(`${BASE_URL}/v1/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
  });
  const data = await resp.json();
  if (data.base_resp?.status_code !== 0 || !data.file) {
    throw new Error(`上传失败: ${data.base_resp?.status_msg ?? "未知错误"} (${data.base_resp?.status_code})`);
  }
  return String(data.file.file_id);
}

// ---------- 3. 克隆音色 ----------

/** MiniMax voice_id 规则校验：长度 [8,256]、字母开头、只能含字母数字-_、不能以 -/_ 结尾 */
function validateVoiceId(id) {
  if (!id || id.length < 8 || id.length > 256) return "音色 ID 长度必须在 8~256 之间（当前 " + (id?.length ?? 0) + " 个字符）";
  if (!/^[A-Za-z]/.test(id)) return "音色 ID 必须以英文字母开头";
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return "音色 ID 只能包含字母、数字、- 和 _";
  if (/[-_]$/.test(id)) return "音色 ID 不能以 - 或 _ 结尾";
  return null;
}
async function cloneVoice(apiKey, fileId, voiceId) {
  const resp = await fetch(`${BASE_URL}/v1/voice_clone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file_id: Number(fileId),
      voice_id: voiceId,
      text: "感谢你一直以来的陪伴，我会继续为你献上最精彩的演出。",
      model: "speech-2.8-hd",
    }),
  });
  const data = await resp.json();
  if (data.base_resp?.status_code !== 0) {
    throw new Error(`克隆失败: ${data.base_resp?.status_msg ?? "未知错误"} (${data.base_resp?.status_code})`);
  }
  return data;
}

// ---------- 4. WebSocket 合成 ----------
function synthesize(apiKey, voiceId, text, outFile) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error("合成超时（30 秒）"));
    }, 30000);

    ws.onopen = () => console.log("[MiniMax] WebSocket 已连接");
    ws.onerror = (e) => reject(new Error("WebSocket 错误: " + (e.message || "unknown")));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.event === "connected_success") {
        ws.send(JSON.stringify({
          event: "task_start",
          model: "speech-2.8-hd",
          voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0, english_normalization: false },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
        }));
      } else if (msg.event === "task_started") {
        ws.send(JSON.stringify({ event: "task_continue", text }));
      } else if (msg.data?.audio) {
        chunks.push(Buffer.from(msg.data.audio, "hex"));
      } else if (msg.is_final) {
        clearTimeout(timeout);
        try { ws.send(JSON.stringify({ event: "task_finish" })); } catch { /* ignore */ }
        const audio = Buffer.concat(chunks);
        if (audio.length === 0) return reject(new Error("合成结果为空"));
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, audio);
        console.log(`[MiniMax] 已保存: ${outFile} (${(audio.length / 1024).toFixed(0)}KB)`);
        resolve(outFile);
      } else if (msg.base_resp && msg.base_resp.status_code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`合成失败: ${msg.base_resp.status_msg} (${msg.base_resp.status_code})`));
      }
    };
  });
}

// ---------- 主入口 ----------
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "prepare") {
  prepare();
} else if (cmd === "clone") {
  const apiKey = args[0];
  const voiceId = args[1] || "Furina2026";
  if (!apiKey) {
    console.error("用法: node minimax-furina-voice.mjs clone <API_KEY> [voiceId]");
    process.exit(1);
  }
  const vErr = validateVoiceId(voiceId);
  if (vErr) {
    console.error("[MiniMax] 音色 ID 不合法:", vErr);
    console.error("示例: node minimax-furina-voice.mjs clone <API_KEY> Furina2026");
    process.exit(1);
  }
  if (!fs.existsSync(REF_FILE)) prepare();
  console.log("[MiniMax] 上传参考音频...");
  const fileId = await uploadFile(apiKey, REF_FILE, "voice_clone");
  console.log("[MiniMax] file_id =", fileId);
  console.log("[MiniMax] 克隆音色", voiceId, "...（通常需要几十秒）");
  const result = await cloneVoice(apiKey, fileId, voiceId);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const infoFile = path.join(OUT_DIR, "voice-info.json");
  fs.writeFileSync(infoFile, JSON.stringify({ voiceId, fileId, raw: result }, null, 2));
  console.log(`[MiniMax] 音色克隆完成！voiceId = ${voiceId}`);
  console.log(`[MiniMax] 信息已保存到 ${infoFile}`);
  if (result.data?.audio) console.log("[MiniMax] 试听地址: " + result.data.audio);
} else if (cmd === "speak") {
  const apiKey = args[0];
  const voiceId = args[1];
  const text = args[2];
  const outFile = args[3] || path.join(OUT_DIR, "试听.mp3");
  if (!apiKey || !voiceId || !text) {
    console.error('用法: node minimax-furina-voice.mjs speak <API_KEY> <voiceId> "文本" [输出.mp3]');
    process.exit(1);
  }
  console.log("[MiniMax] 开始合成...");
  await synthesize(apiKey, voiceId, text, outFile);
} else {
  console.log(`用法:
  node minimax-furina-voice.mjs prepare
  node minimax-furina-voice.mjs clone <API_KEY> [voiceId]
  node minimax-furina-voice.mjs speak <API_KEY> <voiceId> "文本" [输出.mp3]`);
}

#!/usr/bin/env node
// 聊天记录自动落库（由主进程以子进程方式调用）
// 使用 Node 24 内置 node:sqlite，避免 Electron 主进程加载原生模块的 ABI 兼容问题。
// 输入：stdin 接收 JSON { dbPath, messages: [{ role, content, createdAt }] }

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  input += d;
});
process.stdin.on("end", () => {
  try {
    const { dbPath, messages } = JSON.parse(input || "{}");
    if (!dbPath || !Array.isArray(messages) || messages.length === 0) process.exit(0);

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages (created_at);
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
    `);

    const insert = db.prepare(
      "INSERT INTO chat_messages (role, content, created_at) VALUES (?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content = typeof m.content === "string" ? m.content : String(m.content ?? "");
      if (!content.trim()) continue;
      insert.run(role, content, typeof m.createdAt === "string" ? m.createdAt : now);
    }
    db.close();
    process.exit(0);
  } catch (err) {
    console.error("[chat-logger]", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
});

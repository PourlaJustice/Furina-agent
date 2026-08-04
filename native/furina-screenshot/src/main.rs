// furina-screenshot 二进制入口：stdin 读 NDJSON 请求 → stdout 写 NDJSON 响应
mod error;
mod ipc;
mod protocol;
mod request;
mod win;

use anyhow::Result;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::io;

fn main() -> Result<()> {
    // CLI：--version / --test（验证 exe 可用）
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("furina-screenshot {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.iter().any(|a| a == "--test") {
        return win::capture::self_test();
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break; // stdin 关闭 → 退出
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<protocol::Request>(line) {
            Ok(req) => {
                let resp = request::handle(req)?;
                let out = serde_json::to_string(&resp)?;
                writeln!(writer, "{}", out)?;
                writer.flush()?;
                if matches!(resp, protocol::Response::ExitOk { .. }) {
                    break;
                }
            }
            Err(e) => {
                // 解析失败的行直接跳过，避免协议错乱
                eprintln!("[ipc] 解析失败: {}", e);
            }
        }
    }
    Ok(())
}

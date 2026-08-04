// 进程间通讯：stdin/stdout 上的 NDJSON 读写
use std::io::{BufRead, Write};

use crate::error::Result;
use crate::protocol::{Request, Response};

pub fn read_request<R: BufRead>(reader: &mut R) -> Result<Option<Request>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(line)?))
}

pub fn write_response<W: Write>(writer: &mut W, resp: &Response) -> Result<()> {
    let line = serde_json::to_string(resp)?;
    writeln!(writer, "{}", line)?;
    writer.flush()?;
    Ok(())
}

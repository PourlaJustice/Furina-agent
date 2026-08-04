// NDJSON IPC 协议定义（每行一条 JSON）
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Ping { id: String },
    Version { id: String },
    Capture { id: String, region: Option<Region> },
    CaptureGdi { id: String, region: Option<Region> },
    CaptureWindow { id: String, title: String },
    Exit { id: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Pong { id: String },
    VersionResult { id: String, version: &'static str },
    CaptureResult {
        id: String,
        ok: bool,
        data: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
        format: Option<&'static str>,
        error: Option<String>,
    },
    ExitOk { id: String },
}

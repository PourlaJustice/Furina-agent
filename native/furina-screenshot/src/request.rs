// 请求处理：把 NDJSON 请求分发到截图逻辑
use crate::error::Result;
use crate::protocol::{Request, Response};
use crate::win;

fn capture_response(id: String, result: Result<(Vec<u8>, u32, u32)>) -> Response {
    match result {
        Ok((bgra, w, h)) => match win::encoder::png_base64(&bgra, w, h) {
            Ok(data) => Response::CaptureResult {
                id,
                ok: true,
                data: Some(data),
                width: Some(w),
                height: Some(h),
                format: Some("png"),
                error: None,
            },
            Err(e) => Response::CaptureResult {
                id,
                ok: false,
                data: None,
                width: None,
                height: None,
                format: None,
                error: Some(format!("{:#}", e)),
            },
        },
        Err(e) => Response::CaptureResult {
            id,
            ok: false,
            data: None,
            width: None,
            height: None,
            format: None,
            error: Some(format!("{:#}", e)),
        },
    }
}

pub fn handle(req: Request) -> Result<Response> {
    match req {
        Request::Ping { id } => Ok(Response::Pong { id }),
        Request::Version { id } => Ok(Response::VersionResult {
            id,
            version: env!("CARGO_PKG_VERSION"),
        }),
        Request::Exit { id } => Ok(Response::ExitOk { id }),
        Request::Capture { id, region } => Ok(capture_response(id, win::capture::capture(region))),
        Request::CaptureGdi { id, region } => {
            let result = match region {
                Some(r) if r.w > 0 && r.h > 0 => win::capture_gdi::capture_region(r.x, r.y, r.w, r.h),
                _ => {
                    let (w, h) = win::display::primary_size();
                    win::capture_gdi::capture_region(0, 0, w, h)
                }
            };
            Ok(capture_response(id, result))
        }
        Request::CaptureWindow { id, title } => {
            Ok(capture_response(id, win::capture::capture_window(&title)))
        }
    }
}

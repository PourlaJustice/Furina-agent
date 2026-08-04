// 截图编排：默认整屏；DXGI 优先，失败自动回退 GDI
use anyhow::{anyhow, bail};
use windows::Win32::Foundation::RECT;
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowRect};

use crate::error::Result;
use crate::protocol::Region;
use crate::win::{capture_dxgi, capture_gdi, display, renderer};

pub fn capture(region: Option<Region>) -> Result<(Vec<u8>, u32, u32)> {
    // 未指定区域 → 主屏幕；指定区域 → 按坐标截取
    let (px, py, pw, ph) = match region {
        Some(r) if r.w > 0 && r.h > 0 => (r.x, r.y, r.w, r.h),
        _ => {
            let (w, h) = display::primary_size();
            (0, 0, w, h)
        }
    };

    match capture_dxgi::capture_virtual_screen() {
        Ok((full, vw, vh)) => {
            let vs = display::virtual_screen();
            let rx = (px - vs.x).max(0) as usize;
            let ry = (py - vs.y).max(0) as usize;
            let rw = (pw.min(vs.w - (px - vs.x))).max(0) as usize;
            let rh = (ph.min(vs.h - (py - vs.y))).max(0) as usize;
            if rw == 0 || rh == 0 {
                return Err(anyhow!("截图区域超出屏幕范围"));
            }
            let crop = renderer::crop_bgra(&full, vw as usize, vh as usize, rx, ry, rw, rh);
            // DXGI 在远程会话/部分环境会返回全空帧，检测到就回退 GDI
            if crop.iter().all(|&b| b == 0) {
                eprintln!("[dxgi] 截图内容为空，回退 GDI");
                return capture_gdi::capture_region(px, py, pw, ph);
            }
            Ok((crop, rw as u32, rh as u32))
        }
        Err(e) => {
            eprintln!("[dxgi] 截图失败，回退 GDI: {:#}", e);
            capture_gdi::capture_region(px, py, pw, ph)
        }
    }
}

pub fn capture_window(title: &str) -> Result<(Vec<u8>, u32, u32)> {
    unsafe {
        let hwnd = FindWindowW(None, &windows::core::HSTRING::from(title))?;
        if hwnd.0.is_null() {
            bail!("未找到窗口: {}", title);
        }
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect)?;
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            bail!("窗口尺寸无效");
        }
        capture_gdi::capture_region(rect.left, rect.top, w, h)
    }
}

pub fn self_test() -> Result<()> {
    match capture(Some(Region {
        x: 0,
        y: 0,
        w: 64,
        h: 64,
    })) {
        Ok((_, w, h)) => {
            println!("test capture OK: {}x{}", w, h);
            Ok(())
        }
        Err(e) => {
            eprintln!("test capture failed: {:#}", e);
            std::process::exit(1);
        }
    }
}

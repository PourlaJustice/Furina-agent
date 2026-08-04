// GDI 回退截图：BitBlt + GetDIBits（兼容老系统/远程桌面）
use std::ffi::c_void;

use anyhow::{anyhow, Context};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ,
    RGBQUAD, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

use crate::error::Result;

pub fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<(Vec<u8>, u32, u32)> {
    if w <= 0 || h <= 0 {
        return Err(anyhow!("无效区域尺寸 {}x{}", w, h));
    }
    let (w, h) = (w as usize, h as usize);
    unsafe {
        let dc = GetDC(Some(HWND::default()));
        if dc.0.is_null() {
            return Err(anyhow!("GetDC 失败"));
        }
        let mem_dc = CreateCompatibleDC(Some(dc));
        if mem_dc.0.is_null() {
            let _ = ReleaseDC(Some(HWND::default()), dc);
            return Err(anyhow!("CreateCompatibleDC 失败"));
        }
        let bmp = CreateCompatibleBitmap(dc, w as i32, h as i32);
        if bmp.0.is_null() {
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(Some(HWND::default()), dc);
            return Err(anyhow!("CreateCompatibleBitmap 失败"));
        }
        let old: HGDIOBJ = SelectObject(mem_dc, bmp.into());
        BitBlt(mem_dc, 0, 0, w as i32, h as i32, Some(dc), x, y, SRCCOPY).context("BitBlt 失败")?;

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: (w * h * 4) as u32,
                ..Default::default()
            },
            bmiColors: [RGBQUAD::default()],
        };
        let mut buffer = vec![0u8; w * h * 4];
        let n = GetDIBits(
            mem_dc,
            bmp,
            0,
            h as u32,
            Some(buffer.as_mut_ptr() as *mut c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        if n == 0 || n != h as i32 {
            let _ = SelectObject(mem_dc, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(Some(HWND::default()), dc);
            return Err(anyhow!("GetDIBits 失败 ({})", n));
        }

        let _ = SelectObject(mem_dc, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(Some(HWND::default()), dc);
        Ok((buffer, w as u32, h as u32))
    }
}

pub fn capture_window(title: &str) -> Result<(Vec<u8>, u32, u32)> {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    unsafe {
        let hwnd = FindWindowW(None, &HSTRING::from(title)).context("未找到窗口")?;
        if hwnd.0.is_null() {
            return Err(anyhow!("未找到窗口: {}", title));
        }
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).context("GetWindowRect 失败")?;
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return Err(anyhow!("窗口尺寸无效"));
        }
        capture_region(rect.left, rect.top, w, h)
    }
}

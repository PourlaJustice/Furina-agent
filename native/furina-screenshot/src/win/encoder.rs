// PNG 编码（image crate，纯 Rust）：BGRA → RGBA → PNG → base64
use std::io::Cursor;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

use crate::error::Result;

pub fn png_base64(bgra: &[u8], w: u32, h: u32) -> Result<String> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for px in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
    }
    let img = image::RgbaImage::from_raw(w, h, rgba)
        .ok_or_else(|| anyhow::anyhow!("像素缓冲尺寸不匹配: {}x{} (len {})", w, h, bgra.len()))?;
    let mut png: Vec<u8> = Vec::new();
    img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)?;
    Ok(STANDARD.encode(&png))
}

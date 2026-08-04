// 区域裁剪：从整屏 BGRA 缓冲中抠出指定区域
pub fn crop_bgra(
    full: &[u8],
    full_w: usize,
    _full_h: usize,
    rx: usize,
    ry: usize,
    rw: usize,
    rh: usize,
) -> Vec<u8> {
    let mut out = vec![0u8; rw * rh * 4];
    for y in 0..rh {
        let src = (ry + y) * full_w * 4 + rx * 4;
        let dst = y * rw * 4;
        out[dst..dst + rw * 4].copy_from_slice(&full[src..src + rw * 4]);
    }
    out
}

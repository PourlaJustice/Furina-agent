// DXGI Desktop Duplication：GPU 加速整屏截图（首选通道）
use anyhow::Context;
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_DRIVER_TYPE_HARDWARE,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, D3D11_BIND_FLAG, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_RESOURCE_MISC_FLAG,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11_SDK_VERSION, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_OUTDUPL_FRAME_INFO, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput,
    IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
};

use crate::error::Result;

pub fn capture_virtual_screen() -> Result<(Vec<u8>, u32, u32)> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().context("CreateDXGIFactory1 失败")?;
        let adapter: IDXGIAdapter1 = factory.EnumAdapters1(0).context("EnumAdapters1 失败")?;
        let output: IDXGIOutput = adapter.EnumOutputs(0).context("EnumOutputs 失败")?;
        let output1: IDXGIOutput1 = output.cast().context("IDXGIOutput1 获取失败")?;

        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let mut feature_level: D3D_FEATURE_LEVEL = D3D_FEATURE_LEVEL_11_0;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut feature_level),
            Some(&mut context),
        )
        .context("D3D11CreateDevice 失败")?;
        let device = device.context("D3D11 设备为空")?;
        let context = context.context("D3D11 上下文为空")?;

        let duplication: IDXGIOutputDuplication = output1
            .DuplicateOutput(&device)
            .context("DuplicateOutput 失败")?;

        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        duplication
            .AcquireNextFrame(1000, &mut frame_info, &mut resource)
            .context("AcquireNextFrame 失败")?;
        let texture: ID3D11Texture2D = resource
            .context("帧资源为空")?
            .cast()
            .context("ID3D11Texture2D 转换失败")?;

        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);

        let mut staging_desc = desc;
        staging_desc.Usage = D3D11_USAGE_STAGING;
        staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        staging_desc.BindFlags = D3D11_BIND_FLAG(0).0 as u32;
        staging_desc.MiscFlags = D3D11_RESOURCE_MISC_FLAG(0).0 as u32;
        staging_desc.MipLevels = 1;
        staging_desc.ArraySize = 1;
        let mut staging: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&staging_desc, None, Some(&mut staging))
            .context("CreateTexture2D 失败")?;
        let staging = staging.context("staging 纹理为空")?;

        context.CopyResource(&staging, &texture);

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .context("Map 失败")?;
        let w = staging_desc.Width;
        let h = staging_desc.Height;
        let row_pitch = mapped.RowPitch as usize;
        let mut bgra = vec![0u8; (w as usize) * (h as usize) * 4];
        let src_base = mapped.pData as *mut u8;
        for y in 0..h as usize {
            let src = src_base.add(y * row_pitch);
            let dst = &mut bgra[y * (w as usize) * 4..(y + 1) * (w as usize) * 4];
            std::ptr::copy_nonoverlapping(src, dst.as_mut_ptr(), (w as usize) * 4);
        }
        context.Unmap(&staging, 0);
        duplication.ReleaseFrame()?;

        Ok((bgra, w, h))
    }
}

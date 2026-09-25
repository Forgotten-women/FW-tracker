// Native screen capture for the live view.
//
// The live view used to shell out to PowerShell, which compiled a C# helper
// with Add-Type before it could take the first picture -- 2-6 seconds per
// session on a typical laptop, on top of PowerShell's own start-up, and a
// visible CPU spike. Capturing in-process (xcap: GDI on Windows,
// CoreGraphics on macOS) and encoding the JPEG here takes tens of
// milliseconds, so the first frame follows the request almost immediately.
//
// The PowerShell/screencapture path in main.rs stays as a fallback for the
// rare machine where native capture fails.

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, RgbaImage};
use std::hash::{Hash, Hasher};

/// Long edge of a live frame. Sharp enough to read text on a 1080p screen,
/// small enough (~60-200 KB) for a 1 fps stream through the backend.
pub const LIVE_MAX_DIM: u32 = 1280;
pub const LIVE_QUALITY: u8 = 55;
/// If a frame still encodes larger than this (a very busy screen), it is
/// re-encoded smaller rather than sent -- the backend rejects frames over
/// ~900 KB of base64.
const MAX_FRAME_BYTES: usize = 450 * 1024;

pub struct Frame {
    pub jpeg_base64: String,
    /// Cheap summary of the pixels, to skip re-sending an unchanged screen.
    pub fingerprint: u64,
}

fn primary_monitor() -> Result<xcap::Monitor, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("list monitors: {e}"))?;
    let mut first = None;
    for m in monitors {
        if m.is_primary().unwrap_or(false) {
            return Ok(m);
        }
        if first.is_none() {
            first = Some(m);
        }
    }
    first.ok_or_else(|| "no monitor found".to_string())
}

fn fit(width: u32, height: u32, max_dim: u32) -> (u32, u32) {
    if width <= max_dim && height <= max_dim {
        return (width.max(1), height.max(1));
    }
    if width >= height {
        (max_dim, ((height as u64 * max_dim as u64) / width as u64).max(1) as u32)
    } else {
        (((width as u64 * max_dim as u64) / height as u64).max(1) as u32, max_dim)
    }
}

fn fingerprint(img: &image::RgbImage) -> u64 {
    // Sampling every 97th byte is plenty to notice a cursor move, a typed
    // character or a scrolled page, at a fraction of hashing every pixel.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    img.dimensions().hash(&mut h);
    for b in img.as_raw().iter().step_by(97) {
        b.hash(&mut h);
    }
    h.finish()
}

fn encode(img: &image::RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(256 * 1024);
    JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(img)
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(out)
}

fn downscale(raw: RgbaImage, max_dim: u32) -> image::RgbImage {
    let (w, h) = raw.dimensions();
    let (tw, th) = fit(w, h, max_dim);
    let rgba = if (tw, th) == (w, h) {
        raw
    } else {
        image::imageops::resize(&raw, tw, th, FilterType::Triangle)
    };
    DynamicImage::ImageRgba8(rgba).into_rgb8()
}

#[cfg(target_os = "windows")]
pub fn capture_gdi_rgba() -> Result<RgbaImage, String> {
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    unsafe {
        let width = GetSystemMetrics(SM_CXSCREEN);
        let height = GetSystemMetrics(SM_CYSCREEN);
        if width <= 0 || height <= 0 {
            return Err("Invalid screen dimensions".to_string());
        }

        let raw_screen = GetDC(0);
        if raw_screen == 0 {
            return Err(format!("Failed to get screen DC: error {}", windows_sys::Win32::Foundation::GetLastError()));
        }

        let raw_mem = CreateCompatibleDC(raw_screen);
        if raw_mem == 0 {
            ReleaseDC(0, raw_screen);
            return Err(format!("Failed to create compatible DC: error {}", windows_sys::Win32::Foundation::GetLastError()));
        }

        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width;
        bmi.bmiHeader.biHeight = -height; // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbitmap = CreateDIBSection(
            raw_mem,
            &bmi,
            DIB_RGB_COLORS,
            &mut bits,
            0,
            0,
        );

        if hbitmap == 0 || bits.is_null() {
            DeleteDC(raw_mem);
            ReleaseDC(0, raw_screen);
            return Err(format!("CreateDIBSection failed: error {}", windows_sys::Win32::Foundation::GetLastError()));
        }

        let old_obj = SelectObject(raw_mem, hbitmap);
        let blt_res = BitBlt(raw_mem, 0, 0, width, height, raw_screen, 0, 0, SRCCOPY);
        let blt_err = windows_sys::Win32::Foundation::GetLastError();

        SelectObject(raw_mem, old_obj);
        DeleteDC(raw_mem);
        ReleaseDC(0, raw_screen);

        if blt_res == 0 {
            DeleteObject(hbitmap);
            return Err(format!("BitBlt failed: error {}", blt_err));
        }

        // Copy and convert BGRA -> RGBA
        let total_bytes = (width * height * 4) as usize;
        let slice = std::slice::from_raw_parts(bits as *const u8, total_bytes);
        let mut raw_pixels = vec![0u8; total_bytes];
        for i in (0..total_bytes).step_by(4) {
            let b = slice[i];
            let g = slice[i + 1];
            let r = slice[i + 2];
            raw_pixels[i] = r;
            raw_pixels[i + 1] = g;
            raw_pixels[i + 2] = b;
            raw_pixels[i + 3] = 255;
        }

        DeleteObject(hbitmap);

        RgbaImage::from_raw(width as u32, height as u32, raw_pixels)
            .ok_or_else(|| "Failed to construct RgbaImage from raw pixels".to_string())
    }
}

/// Captures the primary monitor as a base64 JPEG. Blocking: call it from
/// `spawn_blocking`, never directly on the async runtime.
pub fn capture_live_frame() -> Result<Frame, String> {
    let raw = match primary_monitor().and_then(|m| m.capture_image().map_err(|e| e.to_string())) {
        Ok(img) if img.width() > 0 && img.height() > 0 => img,
        Err(_err) => {
            #[cfg(target_os = "windows")]
            {
                capture_gdi_rgba()?
            }
            #[cfg(not(target_os = "windows"))]
            {
                return Err(_err);
            }
        }
        Ok(_) => {
            #[cfg(target_os = "windows")]
            {
                capture_gdi_rgba()?
            }
            #[cfg(not(target_os = "windows"))]
            {
                return Err("empty capture".to_string());
            }
        }
    };

    let mut rgb = downscale(raw, LIVE_MAX_DIM);
    let fp = fingerprint(&rgb);
    let mut jpeg = encode(&rgb, LIVE_QUALITY)?;
    if jpeg.len() > MAX_FRAME_BYTES {
        rgb = DynamicImage::ImageRgb8(rgb)
            .resize(1024, 1024, FilterType::Triangle)
            .into_rgb8();
        jpeg = encode(&rgb, 40)?;
    }

    Ok(Frame {
        jpeg_base64: base64::engine::general_purpose::STANDARD.encode(&jpeg),
        fingerprint: fp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        assert_eq!(fit(1920, 1080, 1280), (1280, 720));
        assert_eq!(fit(1080, 1920, 1280), (720, 1280));
        assert_eq!(fit(800, 600, 1280), (800, 600));
    }

    #[test]
    fn fingerprint_changes_when_pixels_change() {
        let mut a = image::RgbImage::new(64, 64);
        let fa = fingerprint(&a);
        assert_eq!(fa, fingerprint(&a.clone()));
        for p in a.pixels_mut().take(200) {
            *p = image::Rgb([255, 255, 255]);
        }
        assert_ne!(fa, fingerprint(&a));
    }

    // Needs a real display: `cargo test -- --ignored captures_the_real_screen`.
    #[test]
    #[ignore]
    fn captures_the_real_screen() {
        let started = std::time::Instant::now();
        let frame = capture_live_frame().expect("native capture works on this machine");
        let took = started.elapsed();
        assert!(frame.jpeg_base64.starts_with("/9j/"));
        assert!(frame.jpeg_base64.len() < 900 * 1024, "under the backend's frame cap");
        println!("captured {} KB of base64 in {:?}", frame.jpeg_base64.len() / 1024, took);
    }


    #[test]
    fn encodes_a_valid_jpeg() {
        let img = image::RgbImage::from_pixel(32, 32, image::Rgb([10, 120, 200]));
        let jpeg = encode(&img, LIVE_QUALITY).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "JPEG start-of-image marker");
        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        assert!(b64.starts_with("/9j/"), "what the backend's frame check expects");
    }
}

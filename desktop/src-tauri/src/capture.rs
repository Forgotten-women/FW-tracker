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

/// Captures the primary monitor as a base64 JPEG. Blocking: call it from
/// `spawn_blocking`, never directly on the async runtime.
pub fn capture_live_frame() -> Result<Frame, String> {
    let raw = primary_monitor()?
        .capture_image()
        .map_err(|e| format!("capture: {e}"))?;
    if raw.width() == 0 || raw.height() == 0 {
        return Err("empty capture".to_string());
    }

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

    #[test]
    fn encodes_a_valid_jpeg() {
        let img = image::RgbImage::from_pixel(32, 32, image::Rgb([10, 120, 200]));
        let jpeg = encode(&img, LIVE_QUALITY).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "JPEG start-of-image marker");
        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        assert!(b64.starts_with("/9j/"), "what the backend's frame check expects");
    }
}

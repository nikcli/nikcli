//! A picture of ADE's own window, for an agent that asked to see it (S35).
//!
//! The page is what ADE draws: panes, panels, dialogs, the browser frame and
//! the canvases. WebView2 renders all of it and can hand back a PNG of what it
//! rendered (`CapturePreview`), so nothing here touches the screen. A screen
//! capture would also take whatever window happens to be on top of ADE, and a
//! window the user never meant to share.
//!
//! The page says which rectangle it wants and which rectangles must not be in
//! it — the key form, a password field. The blanking happens here, on the
//! pixels, before the file exists: a capture that reached the disk whole and
//! was cropped afterwards would have been readable in between.
//!
//! Who is allowed to ask is decided in the page: the user answers the consent
//! dialog (`vision/consent.ts`, D36), and the page refuses outright outside
//! ADE Test until the reviewer has been through consent. The same refusal is
//! repeated here, because a guard that only lives in the page is one bug away
//! from not being a guard at all.

use std::io::Cursor;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// A rectangle in CSS pixels, as the page measures one.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// What the agent is told about the picture it asked for.
#[derive(Debug, Serialize)]
pub struct Shot {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// How many pictures are kept before the oldest go.
const KEEP: usize = 20;

/// A picture larger than this is refused rather than written.
const MAX_BYTES: u64 = 24 * 1024 * 1024;

fn pixels(value: f64, scale: f64, limit: u32) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    let scaled = (value * scale).round();
    if scaled >= f64::from(limit) {
        limit
    } else {
        scaled as u32
    }
}

/**
 * The picture the agent gets: the area it asked for, with the rectangles the
 * page marked sensitive painted over.
 *
 * Both are in CSS pixels and are scaled here by the page's device ratio: the
 * page measures in the units it lays out in, and the capture is in device
 * pixels, which on this machine are not the same number.
 */
pub fn crop_and_redact(png: &[u8], crop: Option<Rect>, redact: &[Rect], scale: f64) -> Result<(Vec<u8>, u32, u32), String> {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let mut image = image::load_from_memory(png).map_err(|error| format!("immagine non leggibile: {error}"))?.to_rgba8();
    let (full_w, full_h) = (image.width(), image.height());

    // Painted before the crop, so a rectangle half outside it is still covered.
    for area in redact {
        let x = pixels(area.x, scale, full_w);
        let y = pixels(area.y, scale, full_h);
        let w = pixels(area.w, scale, full_w.saturating_sub(x));
        let h = pixels(area.h, scale, full_h.saturating_sub(y));
        for row in y..y.saturating_add(h).min(full_h) {
            for column in x..x.saturating_add(w).min(full_w) {
                image.put_pixel(column, row, image::Rgba([17, 17, 17, 255]));
            }
        }
    }

    let view = match crop {
        Some(area) => {
            let x = pixels(area.x, scale, full_w.saturating_sub(1));
            let y = pixels(area.y, scale, full_h.saturating_sub(1));
            let w = pixels(area.w, scale, full_w - x).max(1);
            let h = pixels(area.h, scale, full_h - y).max(1);
            image::imageops::crop_imm(&image, x, y, w, h).to_image()
        }
        None => image,
    };

    let (width, height) = (view.width(), view.height());
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(view)
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|error| format!("PNG non scrivibile: {error}"))?;
    Ok((out, width, height))
}

/// Where the pictures live: beside the mailbox, not in the user's own folders.
fn shots_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?.join("shots");
    std::fs::create_dir_all(&dir).map_err(|error| format!("cartella delle immagini non creata: {error}"))?;
    Ok(dir)
}

/// Keeps the last `KEEP` pictures; an agent asking for many must not fill the disk.
fn prune(dir: &PathBuf) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".png"))
        .collect();
    if files.len() <= KEEP {
        return;
    }
    files.sort_by_key(|entry| entry.metadata().and_then(|data| data.modified()).ok());
    for entry in files.iter().take(files.len() - KEEP) {
        let _ = std::fs::remove_file(entry.path());
    }
}

/// Whether this build answers at all: ADE Test yes, the official app not yet.
pub(crate) fn capture_allowed(app: &AppHandle) -> Result<(), String> {
    if crate::is_test_build(app) {
        Ok(())
    } else {
        Err("vedere ADE è per ora attivo solo in ADE Test: sull'ADE ufficiale aspetta la revisione del consenso".into())
    }
}

/// What the page asks before it reads the screen at all, for `ui` as for `shot`.
#[tauri::command]
pub async fn vision_allowed(app: AppHandle) -> bool {
    capture_allowed(&app).is_ok()
}

/// A file name that says what it is and sorts by time, without a path from the page.
fn file_name(label: &str, now: u128) -> String {
    let safe: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .take(40)
        .collect();
    let safe = safe.trim_matches('-').to_ascii_lowercase();
    format!("{now}-{}.png", if safe.is_empty() { "ade".into() } else { safe })
}

#[cfg(windows)]
pub(crate) fn capture_png(window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    use std::sync::mpsc;

    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use webview2_com::CapturePreviewCompletedHandler;
    use windows::Win32::System::Com::{STATFLAG_NONAME, STREAM_SEEK_SET};
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    let (sender, receiver) = mpsc::channel::<Result<Vec<u8>, String>>();
    let scheduled = window.with_webview(move |webview| unsafe {
        let told = sender.clone();
        let say = move |result: Result<Vec<u8>, String>| {
            let _ = told.send(result);
        };
        let Ok(core) = webview.controller().CoreWebView2() else {
            say(Err("WebView2 non disponibile".into()));
            return;
        };
        // An HGLOBAL stream: the picture is read out of memory, never written by WebView2.
        let stream = match CreateStreamOnHGlobal(windows::Win32::Foundation::HGLOBAL(std::ptr::null_mut()), true) {
            Ok(stream) => stream,
            Err(error) => {
                say(Err(format!("memoria per la cattura non allocata: {error}")));
                return;
            }
        };
        let reading = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            let read = || -> Result<Vec<u8>, String> {
                result.map_err(|error| format!("cattura fallita: {error}"))?;
                let mut stat = Default::default();
                reading.Stat(&mut stat, STATFLAG_NONAME).map_err(|error| error.to_string())?;
                let size = stat.cbSize as usize;
                reading.Seek(0, STREAM_SEEK_SET, None).map_err(|error| error.to_string())?;
                let mut bytes = vec![0u8; size];
                let mut read = 0u32;
                reading.Read(bytes.as_mut_ptr().cast(), size as u32, Some(&mut read)).ok().map_err(|error| error.to_string())?;
                bytes.truncate(read as usize);
                Ok(bytes)
            };
            say(read());
            Ok(())
        }));
        if let Err(error) = core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) {
            let _ = sender.send(Err(format!("cattura non avviata: {error}")));
        }
    });
    scheduled.map_err(|error| format!("finestra non raggiungibile: {error}"))?;
    // The capture finishes on the window's own thread; this one only waits.
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "la cattura non ha risposto entro 10 secondi".to_string())?
}

#[cfg(not(windows))]
pub(crate) fn capture_png(_window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    Err("la cattura della finestra è per ora solo su Windows".into())
}

/**
 * Takes the picture and writes it, returning where it is.
 *
 * `crop` and `redact` come from the page, which is the only place that knows
 * where a pane or a sensitive field is drawn right now.
 */
#[tauri::command]
pub async fn capture_window(
    app: AppHandle,
    label: String,
    crop: Option<Rect>,
    redact: Vec<Rect>,
    scale: f64,
) -> Result<Shot, String> {
    capture_allowed(&app)?;
    let window = app.get_webview_window("main").ok_or("finestra principale non trovata")?;
    let png = capture_png(&window)?;
    let (bytes, width, height) = crop_and_redact(&png, crop, &redact, scale)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("immagine troppo grande: chiedi un pannello o un'area invece della finestra".into());
    }
    let dir = shots_dir(&app)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or_default();
    let path = dir.join(file_name(&label, now));
    std::fs::write(&path, &bytes).map_err(|error| format!("immagine non salvata: {error}"))?;
    prune(&dir);
    Ok(Shot {
        path: path.to_string_lossy().replace('\\', "/"),
        width,
        height,
        bytes: bytes.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([200, 30, 30, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(image).write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        out
    }

    fn pixel(bytes: &[u8], x: u32, y: u32) -> [u8; 4] {
        image::load_from_memory(bytes).unwrap().to_rgba8().get_pixel(x, y).0
    }

    #[test]
    fn a_crop_takes_the_area_asked_for_in_css_pixels() {
        let source = png(400, 200);
        let (cropped, width, height) = crop_and_redact(&source, Some(Rect { x: 10.0, y: 5.0, w: 100.0, h: 50.0 }), &[], 2.0).unwrap();
        assert_eq!((width, height), (200, 100));
        assert_eq!(pixel(&cropped, 0, 0), [200, 30, 30, 255]);

        // Past the edge: clamped to what there is, never an error or an empty file.
        let (_, width, height) = crop_and_redact(&source, Some(Rect { x: 380.0, y: 190.0, w: 100.0, h: 100.0 }), &[], 1.0).unwrap();
        assert_eq!((width, height), (20, 10));
        let (_, width, height) = crop_and_redact(&source, Some(Rect { x: -5.0, y: 0.0, w: 0.0, h: f64::NAN }), &[], 1.0).unwrap();
        assert_eq!((width, height), (1, 1));
    }

    #[test]
    fn a_sensitive_rectangle_is_painted_over_before_the_file_exists() {
        let source = png(200, 100);
        let secret = Rect { x: 10.0, y: 10.0, w: 30.0, h: 20.0 };
        let (whole, _, _) = crop_and_redact(&source, None, &[secret], 1.0).unwrap();
        assert_eq!(pixel(&whole, 12, 12), [17, 17, 17, 255]);
        assert_eq!(pixel(&whole, 100, 80), [200, 30, 30, 255]);

        // Covered in the cropped picture too, wherever the crop starts.
        let (cropped, _, _) = crop_and_redact(&source, Some(Rect { x: 5.0, y: 5.0, w: 60.0, h: 40.0 }), &[secret], 1.0).unwrap();
        assert_eq!(pixel(&cropped, 10, 10), [17, 17, 17, 255]);
    }

    #[test]
    fn a_broken_capture_says_so_and_names_are_safe() {
        assert!(crop_and_redact(b"not a png", None, &[], 1.0).is_err());
        assert_eq!(file_name("pane · Master/..", 7), "7-pane---master.png");
        assert_eq!(file_name("", 7), "7-ade.png");
        assert!(!file_name("../../fuori", 7).contains(".."));
    }
}

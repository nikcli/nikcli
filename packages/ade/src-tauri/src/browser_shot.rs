//! The picture that goes with a request sent from the browser pane (S46).
//!
//! The user picks elements on a page and sends what to change; the session
//! that gets the request also gets a picture of that part of the page. It is
//! the capture of `vision.rs` — ADE's own window as WebView2 rendered it,
//! cropped and with the sensitive rectangles painted over before the file
//! exists — written into the project, next to the request's details, where
//! the agent can read it without leaving its folder.
//!
//! Unlike the captures an agent asks for (`vision.rs`, ADE Test only until
//! the consent review), this one runs in the official ADE too (D47): it is
//! taken only because the user clicked Send in a browser pane, and only of
//! that pane's rectangle, which the pane computes and the command refuses to
//! take empty. No `@ade` verb reaches it, and a page in a frame cannot invoke
//! anything (`browser/frame-script.ts`); the command also answers only ADE's
//! own window.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::vision::{capture_png, crop_and_redact, Rect};
use crate::{within_roots, WriteRoots};

#[derive(Debug, Serialize)]
pub struct BrowserShot {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// Where a picture may go: a `.png` inside an open project's `.ade/browser`.
fn check_destination(path: &str) -> Result<(), String> {
    let normal = path.replace('\\', "/");
    if !normal.to_ascii_lowercase().ends_with(".png") {
        return Err("lo screenshot va in un file .png".into());
    }
    if !normal.contains("/.ade/browser/") || normal.contains("/../") {
        return Err("lo screenshot va nella cartella .ade/browser del progetto".into());
    }
    Ok(())
}

/// What may be photographed: a real rectangle, never the whole window by default.
fn check_crop(crop: &Rect) -> Result<(), String> {
    let values = [crop.x, crop.y, crop.w, crop.h];
    if values.iter().any(|value| !value.is_finite()) || crop.x < 0.0 || crop.y < 0.0 || crop.w < 1.0 || crop.h < 1.0 {
        return Err("zona dello screenshot non valida".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_shot(
    app: AppHandle,
    caller: tauri::Webview,
    roots: tauri::State<'_, WriteRoots>,
    path: String,
    crop: Rect,
    redact: Vec<Rect>,
    scale: f64,
) -> Result<BrowserShot, String> {
    if caller.label() != "main" {
        return Err("lo screenshot del pannello si chiede solo dalla finestra di ADE".into());
    }
    check_crop(&crop)?;
    check_destination(&path)?;
    let target = within_roots(&roots, &path)?;
    let window = app.get_webview_window("main").ok_or("finestra principale non trovata")?;
    let png = capture_png(&window)?;
    let (bytes, width, height) = crop_and_redact(&png, Some(crop), &redact, scale)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("cartella non creata: {error}"))?;
    }
    std::fs::write(&target, &bytes).map_err(|error| format!("screenshot non salvato: {error}"))?;
    Ok(BrowserShot { path, width, height })
}

#[cfg(test)]
mod tests {
    use super::{check_crop, check_destination};
    use crate::vision::Rect;

    #[test]
    fn a_picture_goes_only_into_the_projects_browser_folder() {
        assert!(check_destination("C:/work/app/.ade/browser/20260917-1012-anteprima.png").is_ok());
        assert!(check_destination("C:\\work\\app\\.ade\\browser\\x.PNG").is_ok());
        assert!(check_destination("C:/work/app/.ade/browser/x.md").is_err());
        assert!(check_destination("C:/work/app/src/x.png").is_err());
        assert!(check_destination("C:/work/app/.ade/browser/../../.git/x.png").is_err());
    }

    #[test]
    fn only_a_real_rectangle_is_photographed() {
        let rect = |x: f64, y: f64, w: f64, h: f64| Rect { x, y, w, h };
        assert!(check_crop(&rect(10.0, 20.0, 300.0, 200.0)).is_ok());
        assert!(check_crop(&rect(0.0, 0.0, 0.0, 0.0)).is_err());
        assert!(check_crop(&rect(10.0, 20.0, 0.5, 200.0)).is_err());
        assert!(check_crop(&rect(-5.0, 20.0, 300.0, 200.0)).is_err());
        assert!(check_crop(&rect(f64::NAN, 20.0, 300.0, 200.0)).is_err());
        assert!(check_crop(&rect(10.0, 20.0, f64::INFINITY, 200.0)).is_err());
    }
}

//! macOS and Linux: the same signature, and a sentence instead of a video.
//!
//! The two are next in S36 — ScreenCaptureKit on macOS (12.3+), the desktop
//! portal with PipeWire on Linux — and each has a limit the user already knows
//! about, filed as issues #1 and #2 on the fork: on macOS the screen recording
//! permission is lost at every update while ADE is signed ad-hoc, and on Linux
//! the portal always asks which window to capture.
//!
//! Until then the command answers, rather than failing somewhere deeper with a
//! message about a missing symbol.

use std::path::{Path, PathBuf};

use super::{Quality, Target};

pub struct Active {
    path: PathBuf,
}

pub fn path_of(active: &Active) -> &Path {
    &active.path
}

pub fn start(_app: &tauri::AppHandle, _target: Target, _path: &Path, _quality: Quality) -> Result<Active, String> {
    Err(problem().into())
}

pub fn stop(active: Active) -> Result<PathBuf, String> {
    Ok(active.path)
}

#[cfg(target_os = "macos")]
fn problem() -> &'static str {
    "La registrazione su macOS non è ancora disponibile: arriva con ScreenCaptureKit."
}

#[cfg(not(target_os = "macos"))]
fn problem() -> &'static str {
    "La registrazione su Linux non è ancora disponibile: arriva con il portale dello schermo e PipeWire."
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_answer_says_what_is_missing_and_never_pretends_to_record() {
        let said = super::problem();
        assert!(said.contains("non è ancora disponibile"));
        assert!(said.ends_with('.'));
    }
}

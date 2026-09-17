//! Windows capture: Windows.Graphics.Capture through the `windows-capture` crate.
//!
//! The window is captured whole — WGC has no crop of its own — and a pane take
//! cuts each frame to the pane's rectangle before it reaches the encoder. The
//! capture reads the composition tree, not the screen, so a window behind
//! another still records; a minimised one stops producing frames, which is why
//! the take ends by itself rather than writing a frozen video.
//!
//! The pointer is left out of the frames on purpose: ADE draws it at export
//! from the events file, where a click can be highlighted and zoomed.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    set_hardware_acceleration, AudioSettingsBuilder, ContainerSettingsBuilder, ContainerSettingsSubType, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use super::{compose, crop_in, even, fit_in, Quality, Target};

/// The pace the capture is throttled to, from the chosen frame rate.
fn frame_interval(fps: u32) -> Duration {
    Duration::from_nanos(1_000_000_000 / u64::from(fps.max(1)))
}

/// What the heaviest level costs when the frontend sends no rate: 8 Mbit/s,
/// the measured 66 MB a minute (`results/agy-S36-misure.md`).
///
/// Always pinned, never left to the encoder: asked to choose, the hardware
/// encoder on this machine wrote 165 MB a minute. Which encoder actually runs
/// is Media Foundation's choice — it uses the GPU when there is one and falls
/// back to software by itself — and at a fixed rate the file is the same size
/// either way, so the take never fails for want of a GPU.
const BITRATE: u32 = 8_000_000;

/// Set once the hardware encoder has refused a take in this process.
///
/// From then on every take is encoded in software: the refusal does not heal
/// by itself (measured on 2026-09-16: still failing a minute later, while
/// another process could use the same encoder), and a second failed start is
/// a second promo that was never recorded.
static SOFTWARE_ONLY: AtomicBool = AtomicBool::new(false);

/// The hardware first, software when it refuses. `create` builds the encoder.
fn with_fallback<T, E: std::fmt::Display>(mut create: impl FnMut() -> Result<T, E>) -> Result<T, E> {
    if !SOFTWARE_ONLY.load(Ordering::Relaxed) {
        set_hardware_acceleration(true);
        match create() {
            Ok(value) => return Ok(value),
            Err(error) => {
                eprintln!("[record] encoder hardware rifiutato ({error}): passo al software");
                SOFTWARE_ONLY.store(true, Ordering::Relaxed);
            }
        }
    }
    set_hardware_acceleration(false);
    create()
}

struct Take {
    encoder: Option<VideoEncoder>,
    crop: Option<(u32, u32, u32, u32)>,
    /// Reused between pane frames: a frame is several megabytes.
    scratch: Vec<u8>,
    /// Kept so a failure mid-take is told to the user instead of a silent stop.
    problem: Arc<Mutex<Option<String>>>,
}

#[derive(Clone)]
struct Flags {
    width: u32,
    height: u32,
    crop: Option<(u32, u32, u32, u32)>,
    path: PathBuf,
    quality: Quality,
    problem: Arc<Mutex<Option<String>>>,
}

impl GraphicsCaptureApiHandler for Take {
    type Flags = Flags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        let (captured_width, captured_height) = match flags.crop {
            Some((_, _, width, height)) => (width, height),
            None => (flags.width, flags.height),
        };
        /*
         * A lighter take is encoded smaller, not captured smaller: the capture
         * is the window as it is, and Media Foundation scales on the way into
         * the file — fitted inside the level's box, never stretched to it.
         */
        let (width, height) = fit_in((captured_width, captured_height), (flags.quality.width, flags.quality.height));
        let encoder = with_fallback(|| {
            VideoEncoder::new(
                VideoSettingsBuilder::new(width, height)
                    .sub_type(VideoSettingsSubType::H264)
                    .frame_rate(flags.quality.fps)
                    .bitrate(flags.quality.bitrate.unwrap_or(BITRATE)),
                // The assistant's voice and the microphone are written as their own
                // tracks by ADE, not mixed into the video here (S36, D33-D35).
                AudioSettingsBuilder::default().disabled(true),
                ContainerSettingsBuilder::default().sub_type(ContainerSettingsSubType::MPEG4),
                &flags.path,
            )
        })?;
        Ok(Self { encoder: Some(encoder), crop: flags.crop, scratch: Vec::new(), problem: flags.problem })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame<'_>, _control: InternalCaptureControl) -> Result<(), Self::Error> {
        let Some(encoder) = self.encoder.as_mut() else { return Ok(()) };
        // Secret fields are never in a frame: the page covers them for as
        // long as a take runs (`data-ade-recording` in index.css).
        match self.crop {
            None => encoder.send_frame(frame)?,
            Some((x, y, width, height)) => {
                let timestamp = frame.timestamp().map_err(|error| error.to_string())?.Duration;
                let mut buffer = frame.buffer_crop(x, y, x + width, y + height)?;
                let (width, height, pitch) = (buffer.width(), buffer.height(), buffer.row_pitch());
                compose(buffer.as_raw_buffer(), width, height, pitch, &mut self.scratch);
                encoder.send_frame_buffer(&self.scratch, timestamp)?;
            }
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if let Some(encoder) = self.encoder.take() {
            if let Err(error) = encoder.finish() {
                *self.problem.lock().unwrap() = Some(error.to_string());
            }
        }
        Ok(())
    }
}

pub struct Active {
    control: Option<CaptureControl<Take, Box<dyn std::error::Error + Send + Sync>>>,
    path: PathBuf,
    problem: Arc<Mutex<Option<String>>>,
}

pub fn path_of(active: &Active) -> &Path {
    &active.path
}

pub fn start(app: &tauri::AppHandle, target: Target, path: &Path, quality: Quality) -> Result<Active, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Nessuna finestra di ADE da registrare.".to_string())?;
    let hwnd = main.hwnd().map_err(|error| format!("Finestra non disponibile: {error}"))?;
    let window = Window::from_raw_hwnd(hwnd.0 as *mut std::ffi::c_void);

    // From the window, not from the first frame: that one can arrive in a
    // different size when the window is covered.
    let width = even(window.width().map_err(|error| error.to_string())? as u32);
    let height = even(window.height().map_err(|error| error.to_string())? as u32);
    let crop = match target {
        Target::Window => None,
        Target::Pane { x, y, width: pane_width, height: pane_height } => Some(
            crop_in((width, height), x, y, pane_width, pane_height)
                .ok_or_else(|| "Il pannello scelto è fuori dalla finestra.".to_string())?,
        ),
    };

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("Cartella non scrivibile: {error}"))?;
    }

    let problem = Arc::new(Mutex::new(None));
    let settings = Settings::new(
        window,
        // The pointer is drawn at export, from the events file.
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(frame_interval(quality.fps)),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        Flags { width, height, crop, path: path.to_path_buf(), quality, problem: Arc::clone(&problem) },
    );

    let control = Take::start_free_threaded(settings).map_err(|error| describe(&error.to_string()))?;
    Ok(Active { control: Some(control), path: path.to_path_buf(), problem })
}

pub fn stop(mut active: Active) -> Result<PathBuf, String> {
    if let Some(control) = active.control.take() {
        let callback = control.callback();
        let stopped = control.stop().map_err(|error| error.to_string());
        /*
         * The encoder is closed here, not whenever the handler happens to be
         * dropped: `on_closed` only runs when the window itself goes away, and
         * a drop swallows the error. Closing it now releases the encoder
         * before the next take asks for one, and says if the file is bad.
         */
        let encoder = callback.lock().encoder.take();
        if let Some(encoder) = encoder {
            if let Err(error) = encoder.finish() {
                *active.problem.lock().map_err(|_| "registratore occupato".to_string())? = Some(error.to_string());
            }
        }
        stopped?;
    }
    if let Some(problem) = active.problem.lock().map_err(|_| "registratore occupato".to_string())?.clone() {
        return Err(format!("La registrazione si è interrotta: {problem}"));
    }
    Ok(active.path)
}

/// The crate's own words, turned into something the user can act on.
///
/// Every one of these is a Windows version that does not have the switch,
/// rather than anything the user did wrong.
fn describe(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("unsupported") || lower.contains("not supported") {
        return format!(
            "Questa versione di Windows non offre tutto quello che serve alla registrazione ({error}). Serve Windows 10 2004 o più recente."
        );
    }
    format!("Registrazione non avviata: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both tests set `SOFTWARE_ONLY`, a process-wide static, and cargo runs
    /// tests in parallel: one at a time, or each reads the other's state.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn a_refused_hardware_encoder_falls_back_to_software_and_stays_there() {
        let _serial = serial();
        SOFTWARE_ONLY.store(false, Ordering::Relaxed);
        let mut calls = 0;
        let made: Result<u8, String> = with_fallback(|| {
            calls += 1;
            if calls == 1 { Err("0xC00D6D60".to_string()) } else { Ok(7) }
        });
        assert_eq!(made, Ok(7));
        assert_eq!(calls, 2);
        assert!(SOFTWARE_ONLY.load(Ordering::Relaxed));

        // The next take goes straight to software: one call, no failed start first.
        let mut next = 0;
        let again: Result<u8, String> = with_fallback(|| {
            next += 1;
            Ok(1)
        });
        assert_eq!(again, Ok(1));
        assert_eq!(next, 1);
        SOFTWARE_ONLY.store(false, Ordering::Relaxed);
    }

    #[test]
    fn a_software_failure_is_the_error_the_user_sees() {
        let _serial = serial();
        SOFTWARE_ONLY.store(true, Ordering::Relaxed);
        let made: Result<u8, String> = with_fallback(|| Err("nessun encoder".to_string()));
        assert_eq!(made, Err("nessun encoder".to_string()));
        SOFTWARE_ONLY.store(false, Ordering::Relaxed);
    }
}

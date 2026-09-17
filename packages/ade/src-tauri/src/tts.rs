//! The voice assistant's own voice: Piper, offline, in a resident process.
//!
//! The Web Speech voices WebView2 offers on Windows are the OneCore ones
//! (Elsa, Cosimo), and the user heard them as a robot. S15 compared Windows,
//! Piper, Kokoro and a network voice on the same sentence
//! (`ade-team/results/voice-S15.md`): Piper was the natural voice that still
//! answers in under a second, and the user chose a male one.
//!
//! Piper is a separate program, not a library in the webview: its ~190 MB stay
//! out of the renderer, which Parakeet once pushed to 4.2 GB. It is kept
//! running between sentences because loading the voice is the slow part
//! (0.8–1.6 s cold against 0.2–0.35 s per sentence warm). It needs no cleanup
//! on exit: Piper reads sentences from its stdin and ends at end of file, which
//! is what it gets when ADE exits or is killed (checked with a killed parent).
//!
//! Nothing is bundled. The runtime and the voice are downloaded on first use,
//! from pinned URLs and checked against pinned SHA-256 digests, with the
//! `curl.exe`, `tar.exe` and `certutil.exe` every Windows 10+ ships, so no HTTP
//! or archive crate is added for a one-time download. The voices' licences are
//! the models' own; not redistributing them is part of why they are fetched.
//!
//! Windows only. Elsewhere the commands say so, and the front end keeps the
//! Web Speech voice.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// One file to fetch: where from, and the digest it must have.
struct Download {
    url: &'static str,
    sha256: &'static str,
}

const RUNTIME: Download = Download {
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
};

/// A voice ADE knows how to fetch: the model and its config, pinned to a revision.
struct Voice {
    id: &'static str,
    /// The model's own page, where its licence is stated; opened from the settings.
    source: &'static str,
    model: Download,
    config: Download,
}

const VOICES: &[Voice] = &[
    Voice {
        id: "ugo",
        source: "https://huggingface.co/Einrich99/PiperTTS-UGO-Italian",
        model: Download {
            url: "https://huggingface.co/Einrich99/PiperTTS-UGO-Italian/resolve/3d165b2a45cb134e96eb3a30a85568b213848ad2/medium/it_IT-ugo-medium.onnx",
            sha256: "8be36a89f0f11f8a87751e7cf25ae5c07d1ff1c46c3ccb0fd3541102a1e9476d",
        },
        config: Download {
            url: "https://huggingface.co/Einrich99/PiperTTS-UGO-Italian/resolve/3d165b2a45cb134e96eb3a30a85568b213848ad2/medium/it_IT-ugo-medium.onnx.json",
            sha256: "feb477322e426918b978c46a80c7eb02e21014c38131dd6878fd72a5e21e4081",
        },
    },
    Voice {
        id: "paola",
        source: "https://huggingface.co/rhasspy/piper-voices/tree/main/it/it_IT/paola/medium",
        model: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/it/it_IT/paola/medium/it_IT-paola-medium.onnx",
            sha256: "6fc918b5a0ea6137382833dddfa567bffbe6a5060c02043c87192ee59c04210c",
        },
        config: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/it/it_IT/paola/medium/it_IT-paola-medium.onnx.json",
            sha256: "aea19c0a7fce29fbc359b93f10e7902854401e4c95ae2ea328ae516b15d296cf",
        },
    },
];

fn voice(id: &str) -> Result<&'static Voice, String> {
    VOICES.iter().find(|v| v.id == id).ok_or_else(|| format!("voce sconosciuta: {id}"))
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("tts").join("piper"))
}

fn exe_path(root: &Path) -> PathBuf {
    root.join("piper").join("piper.exe")
}

/// Written after the runtime archive is fully extracted, holding its digest.
///
/// `piper.exe` alone does not prove an installation: an extraction cut short
/// can leave the executable without the DLLs and espeak data beside it, and a
/// check on the exe would then never repair it.
fn runtime_marker(root: &Path) -> PathBuf {
    root.join("piper").join(".ade-complete")
}

fn runtime_ready(root: &Path) -> bool {
    exe_path(root).is_file()
        && std::fs::read_to_string(runtime_marker(root)).map(|d| d.trim() == RUNTIME.sha256).unwrap_or(false)
}

fn model_path(root: &Path, id: &str) -> PathBuf {
    root.join("voices").join(format!("{id}.onnx"))
}

/// The piper process for one voice, with its pipes. Sentences go through it one at a time.
struct Resident {
    voice: String,
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: std::io::BufReader<std::process::ChildStdout>,
}

impl Drop for Resident {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Names the scratch file each sentence is written to; sentences run one at a time, so it only has to differ.
static SENTENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The resident process, and the lock that keeps two installs apart.
#[derive(Default)]
pub struct Piper {
    resident: Mutex<Option<Resident>>,
    install: Mutex<()>,
}

#[derive(Serialize)]
pub struct PiperStatus {
    supported: bool,
    installed: bool,
}

#[tauri::command]
pub fn tts_piper_status(app: tauri::AppHandle, voice_id: String) -> Result<PiperStatus, String> {
    voice(&voice_id)?;
    if !cfg!(windows) {
        return Ok(PiperStatus { supported: false, installed: false });
    }
    let root = root(&app)?;
    let installed = runtime_ready(&root)
        && model_path(&root, &voice_id).is_file()
        && model_path(&root, &voice_id).with_extension("onnx.json").is_file();
    Ok(PiperStatus { supported: true, installed })
}

/// Downloads what is missing for `voice_id`: the runtime once, then the voice.
///
/// curl, tar and certutil block for seconds, so the work runs on Tauri's
/// blocking pool rather than on an async worker the other commands need.
#[tauri::command]
pub async fn tts_piper_install(app: tauri::AppHandle, voice_id: String) -> Result<(), String> {
    let wanted = voice(&voice_id)?;
    if !cfg!(windows) {
        return Err("La voce Piper è disponibile solo su Windows.".into());
    }
    tauri::async_runtime::spawn_blocking(move || install_blocking(&app, wanted))
        .await
        .map_err(|e| e.to_string())?
}

fn install_blocking(app: &tauri::AppHandle, wanted: &'static Voice) -> Result<(), String> {
    let state = app.state::<Piper>();
    // Two first sentences must not download the same files into each other.
    let _one = state.install.lock().map_err(|_| "installazione bloccata")?;
    let root = root(app)?;
    std::fs::create_dir_all(root.join("voices")).map_err(|e| e.to_string())?;

    if !runtime_ready(&root) {
        // Whatever an interrupted attempt left is discarded, not trusted.
        let _ = std::fs::remove_dir_all(root.join("piper"));
        let zip = root.join("piper.zip.part");
        fetch(&RUNTIME, &zip)?;
        let extracted = run(system_tool("tar.exe"), &["-xf".as_ref(), zip.as_os_str(), "-C".as_ref(), root.as_os_str()]);
        let _ = std::fs::remove_file(&zip);
        extracted?;
        if !exe_path(&root).is_file() {
            return Err("L'archivio di Piper non contiene piper.exe.".into());
        }
        std::fs::write(runtime_marker(&root), RUNTIME.sha256).map_err(|e| e.to_string())?;
    }
    let model = model_path(&root, wanted.id);
    let config = model.with_extension("onnx.json");
    for (download, path) in [(&wanted.config, config), (&wanted.model, model)] {
        if path.is_file() {
            continue;
        }
        let part = path.with_extension("part");
        fetch(download, &part)?;
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One sentence as WAV bytes, from the resident process (started, or restarted for another voice).
///
/// On the blocking pool: the sentences of one reply are requested together and
/// wait for each other on the resident process's lock, and each wait would
/// otherwise hold an async worker.
#[tauri::command]
pub async fn tts_piper_speak(app: tauri::AppHandle, voice_id: String, text: String) -> Result<tauri::ipc::Response, String> {
    voice(&voice_id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || speak_blocking(&app, &voice_id, &text))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn speak_blocking(app: &tauri::AppHandle, voice_id: &str, text: &str) -> Result<Vec<u8>, String> {
    let state = app.state::<Piper>();
    let root = root(app)?;
    let scratch = root.join("scratch");
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    // One line per sentence is Piper's input format; a newline inside would split it.
    let text: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if text.trim().is_empty() {
        return Err("testo vuoto".into());
    }

    let mut guard = state.resident.lock().map_err(|_| "voce bloccata")?;
    if guard.as_ref().map(|r| r.voice != voice_id).unwrap_or(true) {
        *guard = None;
        if !runtime_ready(&root) {
            return Err("La voce Piper non è ancora installata.".into());
        }
        *guard = Some(start(&root, voice_id)?);
    }
    let out = scratch.join(format!("{}.wav", SENTENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let result = synthesize(guard.as_mut().expect("started above"), &text, &out);
    if result.is_err() {
        // A process that failed once is not trusted with the next sentence.
        *guard = None;
    }
    drop(guard);
    let bytes = result.and_then(|_| std::fs::read(&out).map_err(|e| e.to_string()));
    let _ = std::fs::remove_file(&out);
    bytes
}

/// Opens the model's page in the browser: only the pages listed in `VOICES`, never a URL from the caller.
#[tauri::command]
pub async fn tts_open_voice_source(app: tauri::AppHandle, voice_id: String) -> Result<(), String> {
    let source = voice(&voice_id)?.source;
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app).open(source, None).map_err(|e| e.to_string())
}

/// Ends the resident process, freeing its memory until the next sentence.
#[tauri::command]
pub fn tts_piper_stop(state: tauri::State<'_, Piper>) {
    if let Ok(mut guard) = state.resident.lock() {
        *guard = None;
    }
}

fn start(root: &Path, voice_id: &str) -> Result<Resident, String> {
    use std::process::{Command, Stdio};
    let exe = exe_path(root);
    let model = model_path(root, voice_id);
    if !exe.is_file() || !model.is_file() {
        return Err("La voce Piper non è ancora installata.".into());
    }
    let mut command = Command::new(&exe);
    command
        .arg("--model")
        .arg(&model)
        .arg("--json-input")
        .current_dir(exe.parent().unwrap_or(root))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|e| format!("Piper non si avvia: {e}"))?;
    let stdin = child.stdin.take().ok_or("Piper senza stdin")?;
    let stdout = std::io::BufReader::new(child.stdout.take().ok_or("Piper senza stdout")?);
    Ok(Resident { voice: voice_id.to_string(), child, stdin, stdout })
}

/// Piper writes the sentence to `out` and prints that path when it is done.
fn synthesize(resident: &mut Resident, text: &str, out: &Path) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let line = serde_json::json!({ "text": text, "output_file": out.to_string_lossy() }).to_string();
    writeln!(resident.stdin, "{line}").map_err(|e| format!("Piper non risponde: {e}"))?;
    resident.stdin.flush().map_err(|e| format!("Piper non risponde: {e}"))?;
    let mut answer = String::new();
    let read = resident.stdout.read_line(&mut answer).map_err(|e| format!("Piper non risponde: {e}"))?;
    if read == 0 {
        return Err("Piper si è chiuso.".into());
    }
    if !out.is_file() {
        return Err("Piper non ha scritto l'audio.".into());
    }
    Ok(())
}

fn system_tool(name: &str) -> PathBuf {
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    PathBuf::from(system_root).join("System32").join(name)
}

fn hide_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn run(program: PathBuf, args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let mut command = std::process::Command::new(&program);
    command.args(args).stdin(std::process::Stdio::null());
    hide_window(&mut command);
    let output = command.output().map_err(|e| format!("{} non eseguibile: {e}", program.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} è fallito: {}",
            program.file_name().and_then(|n| n.to_str()).unwrap_or("comando"),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Downloads to `path` and keeps the file only if its digest is the pinned one.
fn fetch(download: &Download, path: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(path);
    run(
        system_tool("curl.exe"),
        // Bounded by progress, not by a total: the install lock is held for the
        // whole download, so a stalled connection left every later request for
        // this voice waiting, while a fixed ceiling would also cut off a slow
        // line that is still getting there. Under 1 KB/s for a minute is stalled.
        &[
            "-fsSL".as_ref(),
            "--retry".as_ref(),
            "2".as_ref(),
            "--connect-timeout".as_ref(),
            "20".as_ref(),
            "--speed-limit".as_ref(),
            "1024".as_ref(),
            "--speed-time".as_ref(),
            "60".as_ref(),
            "-o".as_ref(),
            path.as_os_str(),
            download.url.as_ref(),
        ],
    )
    .map_err(|e| format!("Download della voce non riuscito: {e}"))?;
    let listing = run(system_tool("certutil.exe"), &["-hashfile".as_ref(), path.as_os_str(), "SHA256".as_ref()])?;
    if digest_in(&listing).as_deref() != Some(download.sha256) {
        let _ = std::fs::remove_file(path);
        return Err("Il file scaricato non corrisponde a quello atteso: scartato.".into());
    }
    Ok(())
}

/// The hex digest in `certutil -hashfile` output: the line of 64 hex digits, spaces removed.
fn digest_in(listing: &str) -> Option<String> {
    listing
        .lines()
        .map(|line| line.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase())
        .find(|line| line.len() == 64 && line.chars().all(|c| c.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn certutil_output_yields_the_digest_in_either_spelling() {
        let modern = "SHA256 hash of piper.zip:\r\nf3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea\r\nCertUtil: -hashfile command completed successfully.\r\n";
        let spaced = "SHA256 hash of file x:\r\nf3 c5 89 06 40 2b 24 f3 a9 6d 92 14 5f 58 ac ba 6d 86 c9 b5 db 89 6d 20 7f 78 dc 80 81 1e fc ea\r\nCertUtil: ok";
        let expected = Some(RUNTIME.sha256.to_string());
        assert_eq!(digest_in(modern), expected);
        assert_eq!(digest_in(spaced), expected);
        assert_eq!(digest_in("CertUtil: error"), None);
    }

    #[test]
    fn a_runtime_without_its_completion_marker_is_not_installed() {
        let root = std::env::temp_dir().join(format!("ade-tts-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("piper")).unwrap();
        std::fs::write(exe_path(&root), b"exe").unwrap();
        // An extraction cut short: the exe is there, the marker is not.
        assert!(!runtime_ready(&root));
        std::fs::write(runtime_marker(&root), "not the digest").unwrap();
        assert!(!runtime_ready(&root));
        std::fs::write(runtime_marker(&root), RUNTIME.sha256).unwrap();
        assert!(runtime_ready(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_known_voices_and_pinned_urls() {
        assert!(voice("ugo").is_ok());
        assert!(voice("paola").is_ok());
        assert!(voice("giorgio").is_err());
        assert!(voice("../../evil").is_err());
        for v in VOICES {
            assert!(v.source.starts_with("https://huggingface.co/"));
            for d in [&v.model, &v.config] {
                assert!(d.url.starts_with("https://huggingface.co/"));
                assert!(!d.url.contains("/resolve/main/"), "{} is not pinned to a revision", d.url);
                assert_eq!(d.sha256.len(), 64);
            }
        }
    }
}

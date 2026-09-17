//! The two file paths behind "the agent tells ADE which conversation it opened".
//!
//! The reasoning is in `src/session-new/agent-link.ts` and
//! `src/session-new/agent-hooks.ts`; this side only moves bytes. It exists
//! because those files live outside anything the webview may touch — the drop
//! directory is ADE's own application data, and the hook configuration belongs
//! to another program entirely — so both need a command with the paths fixed
//! in Rust rather than supplied by the frontend.
//!
//! Two rules keep that honest:
//!
//! - the drop file is addressed by its nonce, and a nonce is hex, so nothing
//!   the frontend sends can escape the directory;
//! - the hook configuration is addressed by an agent id that must appear in
//!   [`HOOK_TARGETS`], so the only files reachable are the two listed there.
//!
//! Neither install nor removal happens on its own. Both are commands, invoked
//! from the settings panel, because they edit files ADE does not own.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::Manager;

/// Where the hooks drop their reports, under ADE's own application data.
///
/// Not the temp directory: a report is a few hundred bytes that has to survive
/// exactly as long as it takes the frontend to poll for it, and a cleaner
/// running between the two would turn a resumable session into a fresh one for
/// no visible reason.
const LINK_SUBDIR: &str = "agent-sessions";

/// How long a drop file that nobody claimed is kept.
///
/// Claimed ones are deleted the moment they are read. This is for the rest:
/// a session that ADE lost interest in, or one whose window closed between the
/// hook writing and the poll arriving. A day is long enough that the sweep
/// never races a live session and short enough that the directory does not
/// accumulate.
const LINK_TTL: Duration = Duration::from_secs(60 * 60 * 24);

/// Filename of the script ADE installs. Mirrors `HOOK_MARKER` in `agent-hooks.ts`.
const SCRIPT_NAME: &str = "ade-agent-session.ps1";

/// A CLI ADE knows how to install a reporting hook into.
///
/// Mirrors `HOOK_TARGETS` in `src/session-new/agent-hooks.ts`, which decides
/// what to write; this table decides where. They are checked against each other
/// by `src/session-new/agent-hooks.test.ts` — add a CLI to one and the other
/// fails until it is added there too.
struct HookTarget {
    id: &'static str,
    config: &'static [&'static str],
    script: &'static [&'static str],
}

const HOOK_TARGETS: &[HookTarget] = &[
    HookTarget {
        id: "claude-code",
        config: &[".claude", "settings.json"],
        script: &[".claude", "hooks", SCRIPT_NAME],
    },
    HookTarget {
        id: "codex",
        config: &[".codex", "hooks.json"],
        script: &[".codex", SCRIPT_NAME],
    },
];

/// The directory the hooks write into, created if it is not there yet.
pub fn link_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let base = app.path().app_local_data_dir().ok()?;
    let dir = base.join(LINK_SUBDIR);
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Deletes drop files nobody came back for.
///
/// Called once at startup rather than on a timer: the directory grows by one
/// small file per agent session that ADE did not read the report of, which is
/// a rate that does not need watching.
pub fn sweep(app: &tauri::AppHandle) {
    let Some(dir) = link_dir(app) else { return };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age > LINK_TTL);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// A nonce is 24 hex characters, and anything else is not one.
///
/// The check is here and not only at the caller because this is what stops a
/// path from being built out of frontend input: without it, `..\\..\\` in place
/// of a nonce would read any file on the disk through a command whose whole
/// purpose is to read one known-shaped file.
fn nonce_file(nonce: &str) -> Result<String, String> {
    if nonce.is_empty() || nonce.len() > 64 || !nonce.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("nonce non valido".to_string());
    }
    Ok(format!("{nonce}.json"))
}

fn nonce_path(app: &tauri::AppHandle, nonce: &str) -> Result<PathBuf, String> {
    let name = nonce_file(nonce)?;
    let dir = link_dir(app).ok_or_else(|| "cartella sessioni non disponibile".to_string())?;
    Ok(dir.join(name))
}

/// The report a hook left for this spawn, if it has run yet.
///
/// `None` is the normal answer: the frontend polls for a while after starting
/// an agent, and most of those polls arrive before the CLI has got as far as
/// its own `SessionStart`. Left on disk rather than consumed, so a report that
/// does not parse is still there to be looked at.
#[tauri::command]
pub async fn agent_link_read(app: tauri::AppHandle, nonce: String) -> Result<Option<String>, String> {
    let path = nonce_path(&app, &nonce)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("rapporto non leggibile: {error}")),
    }
}

/// Whether the agent of this spawn is in a turn, as its last `UserPromptSubmit`
/// or `Stop` hook wrote it; `None` until either has run. Not consumed: it is a
/// state, overwritten by the next turn, and read as often as it is needed.
#[tauri::command]
pub async fn agent_activity_read(app: tauri::AppHandle, nonce: String) -> Result<Option<String>, String> {
    let json = nonce_path(&app, &nonce)?;
    let path = json.with_extension("activity");
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("attività non leggibile: {error}")),
    }
}

/// Forgets a report the frontend has taken.
#[tauri::command]
pub async fn agent_link_clear(app: tauri::AppHandle, nonce: String) -> Result<(), String> {
    let path = nonce_path(&app, &nonce)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("rapporto non rimosso: {error}")),
    }
}

/// What the settings panel needs to show one CLI's row.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookFiles {
    /// Absolute path of the CLI's configuration file.
    pub config_path: String,
    /// Its current contents, or `None` if the CLI has never written one.
    pub config_text: Option<String>,
    /// Absolute path ADE's script goes at.
    pub script_path: String,
    /// Whether that script is on disk right now.
    pub script_present: bool,
}

fn target(agent: &str) -> Result<&'static HookTarget, String> {
    HOOK_TARGETS
        .iter()
        .find(|target| target.id == agent)
        .ok_or_else(|| format!("nessun hook noto per {agent}"))
}

fn under_home(segments: &[&str]) -> Result<PathBuf, String> {
    let home = dirs_home().ok_or_else(|| "cartella utente non trovata".to_string())?;
    Ok(segments.iter().fold(home, |path, segment| path.join(segment)))
}

/// The user's home directory.
///
/// Read from the environment rather than through Tauri's path resolver so the
/// tests below can point it somewhere harmless: these functions write into the
/// real `~/.claude`, and a test that did that would be a bug report from the
/// user's next Claude Code session.
fn dirs_home() -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let candidates = ["HOME"];
    for key in candidates {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

/// Reads one CLI's hook configuration so the frontend can decide what to write.
#[tauri::command]
pub async fn agent_hook_read(agent: String) -> Result<HookFiles, String> {
    let target = target(&agent)?;
    let config = under_home(target.config)?;
    let script = under_home(target.script)?;
    Ok(HookFiles {
        config_text: fs::read_to_string(&config).ok(),
        config_path: config.to_string_lossy().to_string(),
        script_present: script.is_file(),
        script_path: script.to_string_lossy().to_string(),
    })
}

/// Writes back the configuration, and installs or removes the script.
///
/// `script: None` means removal. The configuration is written either way and
/// the frontend has already taken ADE's entry out of it, so the two halves
/// cannot disagree: there is never a config pointing at a script that is not
/// there, nor a script nothing invokes.
///
/// The configuration is written through a temporary file in the same
/// directory. It belongs to another program which may be running right now,
/// and a half-written `settings.json` is a CLI that will not start.
#[tauri::command]
pub async fn agent_hook_write(
    app: tauri::AppHandle,
    agent: String,
    config_text: String,
    script: Option<String>,
) -> Result<(), String> {
    let target = target(&agent)?;
    let config = under_home(target.config)?;
    let script_path = under_home(target.script)?;

    /*
     * This command writes a program another CLI runs and the configuration
     * that makes it run, so it must not be a way to install any program.
     *
     * The configuration may differ from what is on disk only in ADE's own
     * entries, and those must invoke ADE's script exactly as `hookCommand`
     * spells it. The script's text is the part no rule can check, so a script
     * that is not already the one on disk is shown to the user first, in a
     * native dialog nothing in the webview can click.
     */
    let current = fs::read_to_string(&config).ok();
    check_hook_config(current.as_deref(), &config_text, &hook_command(&script_path))?;
    if let Some(text) = script.as_ref() {
        let on_disk = fs::read_to_string(&script_path).ok();
        if on_disk.as_deref() != Some(text.as_str()) {
            let question = format!(
                "ADE vuole installare o aggiornare il suo hook per {agent}:\n\n{}\n\nLo script viene eseguito da {agent} a ogni sessione, per dire ad ADE quale conversazione ha aperto. Consentire?",
                script_path.display()
            );
            let allowed = tauri::async_runtime::spawn_blocking(move || {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                app.dialog()
                    .message(question)
                    .title("Hook di ADE")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom("Consenti".into(), "Annulla".into()))
                    .blocking_show()
            })
            .await
            .map_err(|e| e.to_string())?;
            if !allowed {
                return Err("installazione dell'hook annullata".to_string());
            }
        }
    }

    match script {
        Some(text) => {
            if let Some(parent) = script_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("cartella hook non creata: {e}"))?;
            }
            write_atomic(&script_path, text.as_bytes())?;
        }
        None => match fs::remove_file(&script_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("script non rimosso: {error}")),
        },
    }

    if let Some(parent) = config.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cartella configurazione non creata: {e}"))?;
    }
    write_atomic(&config, config_text.as_bytes())
}

/// How a CLI's configuration invokes ADE's script. Mirrors `hookCommand` in `agent-hooks.ts`.
fn hook_command(script_path: &Path) -> String {
    format!("powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"", script_path.display())
}

/// The configuration with every ADE entry taken out, and whatever that emptied.
fn without_ade(value: &serde_json::Value) -> Option<serde_json::Value> {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            if map.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(SCRIPT_NAME)) {
                return None;
            }
            let kept: serde_json::Map<String, Value> = map
                .iter()
                .filter_map(|(k, v)| without_ade(v).map(|v| (k.clone(), v)))
                .collect();
            // Empty containers compare as absent: removing ADE's entry may
            // leave `"hooks": {}` where there was no `hooks` key before.
            (!kept.is_empty()).then_some(Value::Object(kept))
        }
        Value::Array(items) => {
            let kept: Vec<Value> = items.iter().filter_map(without_ade).collect();
            (!kept.is_empty()).then_some(Value::Array(kept))
        }
        other => Some(other.clone()),
    }
}

fn ade_commands(value: &serde_json::Value, out: &mut Vec<String>) {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            for (key, v) in map {
                match v {
                    Value::String(s) if key == "command" && s.contains(SCRIPT_NAME) => out.push(s.clone()),
                    other => ade_commands(other, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|v| ade_commands(v, out)),
        _ => {}
    }
}

/// Refuses a configuration that changes anything but ADE's own hook entries.
fn check_hook_config(current: Option<&str>, next: &str, command: &str) -> Result<(), String> {
    let parse = |text: &str| -> Result<serde_json::Value, String> {
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Object(Default::default()));
        }
        serde_json::from_str(text).map_err(|e| format!("configurazione non valida: {e}"))
    };
    let before = parse(current.unwrap_or(""))?;
    let after = parse(next)?;
    if without_ade(&before) != without_ade(&after) {
        return Err("la configurazione cambia più degli hook di ADE: scrittura rifiutata".to_string());
    }
    let mut commands = Vec::new();
    ade_commands(&after, &mut commands);
    if let Some(bad) = commands.iter().find(|c| c.as_str() != command) {
        return Err(format!("comando hook non riconosciuto: {bad}"));
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let staging = path.with_extension("ade-part");
    {
        let mut file =
            fs::File::create(&staging).map_err(|e| format!("{} non scrivibile: {e}", path.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("{} non scritto: {e}", path.display()))?;
        file.sync_all()
            .map_err(|e| format!("{} non salvato: {e}", path.display()))?;
    }
    fs::rename(&staging, path).map_err(|e| {
        let _ = fs::remove_file(&staging);
        format!("{} non sostituito: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hook_write_may_only_touch_ade_entries() {
        let script = Path::new("C:\\Users\\x\\.claude\\hooks").join(SCRIPT_NAME);
        let command = hook_command(&script);
        let entry = |cmd: &str| format!(r#"{{"type":"command","command":{}}}"#, serde_json::to_string(cmd).unwrap());
        let current = r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify"}]}]}}"#;
        let installed = format!(
            r#"{{"model":"opus","hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"notify"}}]}},{{"hooks":[{}]}}],"SessionStart":[{{"hooks":[{}]}}]}}}}"#,
            entry(&command),
            entry(&command)
        );
        assert!(check_hook_config(Some(current), &installed, &command).is_ok());
        assert!(check_hook_config(Some(&installed), current, &command).is_ok());
        assert!(check_hook_config(None, &format!(r#"{{"hooks":{{"SessionStart":[{{"hooks":[{}]}}]}}}}"#, entry(&command)), &command).is_ok());

        let widened = installed.replace(r#""model":"opus""#, r#""model":"opus","permissions":{"allow":["Bash"]}"#);
        assert!(check_hook_config(Some(current), &widened, &command).is_err());
        let foreign = installed.replace("notify", "calc");
        assert!(check_hook_config(Some(current), &foreign, &command).is_err());
        let hijacked = installed.replace("powershell -NoProfile", "calc & powershell -NoProfile");
        assert!(check_hook_config(Some(current), &hijacked, &command).is_err());
    }

    #[test]
    fn every_target_has_a_script_this_module_recognises() {
        for target in HOOK_TARGETS {
            assert_eq!(target.script.last(), Some(&SCRIPT_NAME));
            assert!(!target.config.is_empty());
        }
    }

    #[test]
    fn a_nonce_that_is_not_hex_never_becomes_a_path() {
        assert_eq!(nonce_file("a1b2c3").as_deref(), Ok("a1b2c3.json"));
        for bad in ["", "../../../windows/win.ini", "a1b2/c3", "a1b2.json", &"f".repeat(65)] {
            assert!(nonce_file(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn an_unknown_agent_has_no_files_to_touch() {
        assert!(target("gemini").is_err());
        assert!(target("../../etc").is_err());
    }

    #[test]
    fn a_config_path_stays_under_the_home_directory() {
        let home = dirs_home().expect("a home directory");
        for entry in HOOK_TARGETS {
            let config = under_home(entry.config).expect("a path");
            let script = under_home(entry.script).expect("a path");
            assert!(config.starts_with(&home), "{} escaped", config.display());
            assert!(script.starts_with(&home), "{} escaped", script.display());
        }
    }

    #[test]
    fn write_atomic_replaces_a_file_without_leaving_its_staging_copy() {
        let dir = std::env::temp_dir().join(format!("ade-hook-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("a directory");
        let path = dir.join("settings.json");
        fs::write(&path, b"prima").expect("a file");

        write_atomic(&path, b"dopo").expect("the write to land");

        assert_eq!(fs::read_to_string(&path).expect("the file"), "dopo");
        assert!(!path.with_extension("ade-part").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}

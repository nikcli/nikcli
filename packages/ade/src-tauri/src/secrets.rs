//! The user's API keys, in the operating system's own keychain.
//!
//! Windows Credential Manager, the macOS Keychain, the Secret Service on
//! Linux: the value is written there and read from there, and nowhere else.
//! Not in a file, not in localStorage, not in a log line, and — the part that
//! shapes every command below — not back into the page. The page can save a
//! key, list the names with a masked tail, copy one (Rust writes it to the
//! clipboard) and delete one. It cannot read a value, because a page loaded in
//! the browser pane runs in the same window and this file would otherwise be
//! a way to read every key the user owns.
//!
//! What is in a file is the index: names, the environment variable each one
//! becomes, which agents get it at launch. Names are not secrets, and the
//! keychain cannot list its own entries portably.
//!
//! Entries are filed under the app's identifier, so ADE Test
//! (`ai.nikcli.ade.test`) never sees or overwrites the installed ADE's keys.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// What the page sees of a key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub name: String,
    /// The variable it becomes in an agent's environment: `OPENAI_API_KEY`.
    pub env: String,
    /// Agent ids that receive it at launch. Empty by default: a key such as
    /// `ANTHROPIC_API_KEY` switches Claude Code from the subscription to paid
    /// API use, so no agent gets one unless the user named it.
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub created_ms: u64,
    /// `••••••••abcd`, computed in Rust; absent when the keychain has no value.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub masked: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
struct Index {
    keys: Vec<SecretInfo>,
}

/// Where values go. The keychain in ADE; a map in the tests.
pub trait Vault: Send + Sync {
    fn get(&self, service: &str, name: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, service: &str, name: &str) -> Result<(), String>;
}

pub struct SystemVault;

/// The keychain's error, without anything that could be the value.
fn describe(error: keyring::Error) -> String {
    match error {
        keyring::Error::NoStorageAccess(_) => "portachiavi di sistema non accessibile".into(),
        keyring::Error::PlatformFailure(_) => "il portachiavi di sistema ha rifiutato l'operazione".into(),
        keyring::Error::TooLong(field, max) => format!("{field} troppo lungo per il portachiavi (massimo {max})"),
        keyring::Error::Invalid(field, _) => format!("{field} non valido per il portachiavi"),
        keyring::Error::Ambiguous(_) => "più voci con lo stesso nome nel portachiavi".into(),
        keyring::Error::BadEncoding(_) => "valore nel portachiavi non leggibile come testo".into(),
        keyring::Error::NoEntry => "nessuna voce".into(),
        _ => "errore del portachiavi".into(),
    }
}

impl Vault for SystemVault {
    fn get(&self, service: &str, name: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(service, name).map_err(describe)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(describe(error)),
        }
    }
    fn set(&self, service: &str, name: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(service, name)
            .map_err(describe)?
            .set_password(value)
            .map_err(describe)
    }
    fn delete(&self, service: &str, name: &str) -> Result<(), String> {
        match keyring::Entry::new(service, name).map_err(describe)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(describe(error)),
        }
    }
}

/// Serialises index writes: two saves at once would each drop the other's key.
#[derive(Default)]
pub struct SecretsLock(Mutex<()>);

/// Variables a key may not become: what the agent needs to start, and ADE's own.
const RESERVED_ENV: &[&str] = &[
    "PATH", "PATHEXT", "TERM", "COLORTERM", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "SHELL", "PWD", "LD_PRELOAD",
    "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS",
];

pub fn check_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || " ._-".contains(c));
    if ok {
        Ok(())
    } else {
        Err("nome non valido: lettere, cifre, spazio, . _ -, fino a 64 caratteri".into())
    }
}

pub fn check_env(env: &str) -> Result<(), String> {
    let ok = !env.is_empty()
        && env.len() <= 64
        && env.chars().next().is_some_and(|c| c.is_ascii_uppercase() || c == '_')
        && env.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !ok {
        return Err("variabile non valida: maiuscole, cifre e _, es. OPENAI_API_KEY".into());
    }
    if RESERVED_ENV.contains(&env) || env.starts_with("ADE_") {
        return Err(format!("{env} è riservata: ADE o il sistema la usano già"));
    }
    Ok(())
}

pub fn check_value(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("valore vuoto".into());
    }
    if value.len() > 4096 {
        return Err("valore troppo lungo (massimo 4096 caratteri)".into());
    }
    // A line break or NUL in an environment variable breaks the agent's launch.
    if value.contains(['\0', '\r', '\n']) {
        return Err("il valore contiene un a capo: incollalo su una riga".into());
    }
    Ok(())
}

/// The last four characters for a key long enough that four say nothing useful.
pub fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < 16 {
        return "•".repeat(8);
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}{tail}", "•".repeat(8))
}

fn service(app: &AppHandle) -> String {
    format!("{}.secrets", app.config().identifier)
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("secrets-index.json"))
        .map_err(|e| format!("cartella di configurazione: {e}"))
}

fn read_index(path: &std::path::Path) -> Index {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_index(path: &std::path::Path, index: &Index) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("indice chiavi: {e}"))?;
    }
    let text = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| format!("indice chiavi: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| format!("indice chiavi: {e}"))
}

/* The operations, on an index path and a vault, so the tests need no app. */

fn list_in(vault: &dyn Vault, service: &str, path: &std::path::Path) -> Result<Vec<SecretInfo>, String> {
    let mut keys = read_index(path).keys;
    for key in &mut keys {
        key.masked = vault.get(service, &key.name)?.map(|value| mask(&value));
    }
    Ok(keys)
}

fn save_in(
    vault: &dyn Vault,
    service: &str,
    path: &std::path::Path,
    name: &str,
    env: &str,
    agents: Vec<String>,
    value: Option<&str>,
    now_ms: u64,
) -> Result<(), String> {
    check_name(name)?;
    check_env(env)?;
    let mut index = read_index(path);
    if index.keys.iter().any(|key| key.env == env && key.name != name) {
        return Err(format!("{env} è già la variabile di un'altra chiave"));
    }
    let existing = index.keys.iter().position(|key| key.name == name);
    match value {
        Some(value) => {
            check_value(value)?;
            vault.set(service, name, value)?;
        }
        None if existing.is_none() => return Err("una chiave nuova ha bisogno di un valore".into()),
        None => {}
    }
    let mut agents: Vec<String> = agents.into_iter().filter(|a| !a.trim().is_empty()).collect();
    agents.sort();
    agents.dedup();
    let entry = SecretInfo {
        name: name.into(),
        env: env.into(),
        agents,
        created_ms: existing.map(|i| index.keys[i].created_ms).unwrap_or(now_ms),
        masked: None,
    };
    match existing {
        Some(i) => index.keys[i] = entry,
        None => index.keys.push(entry),
    }
    write_index(path, &index)
}

fn delete_in(vault: &dyn Vault, service: &str, path: &std::path::Path, name: &str) -> Result<(), String> {
    vault.delete(service, name)?;
    let mut index = read_index(path);
    index.keys.retain(|key| key.name != name);
    write_index(path, &index)
}

/// The agent id, as the index names agents, that a pty command starts.
///
/// Decided here from the command itself, not taken from the page: the page
/// only asks, and a page (or a plugin loaded into it) that asked for every key
/// on a `powershell` launch would otherwise read them all from the terminal.
/// `None` for anything that is not an agent or a shell, such as `ssh`.
pub fn agent_for_command(command: &str) -> Option<&'static str> {
    let name = command.trim();
    let stem = match name.rsplit_once('.') {
        Some((head, ext)) if ["exe", "cmd", "bat", "com", "ps1"].iter().any(|known| known.eq_ignore_ascii_case(ext)) => head,
        _ => name,
    }
    .to_ascii_lowercase();
    match stem.as_str() {
        "claude" => Some("claude-code"),
        "codex" => Some("codex"),
        "opencode" => Some("opencode"),
        "nikcli" => Some("nikcli"),
        "agy" => Some("agy"),
        "kimi" => Some("kimi"),
        "prime" => Some("prime"),
        "pi" => Some("pi"),
        "ohmypi" => Some("ohmypi"),
        "hermes" => Some("hermes"),
        "cmd" | "powershell" | "pwsh" | "sh" | "bash" | "zsh" | "fish" => Some("terminal"),
        _ => None,
    }
}

/// The keys the user gave to `agent`, as `(name, ENV)`; the index only, no keychain read.
fn assigned_in(path: &std::path::Path, agent: &str) -> Vec<(String, String)> {
    read_index(path)
        .keys
        .into_iter()
        .filter(|key| key.agents.iter().any(|allowed| allowed == agent))
        .map(|key| (key.name, key.env))
        .collect()
}

/// The variables for a launch of `agent`: `(ENV, value)` for each named key.
///
/// Every name must be a key the user assigned to that agent in the index; one
/// that is not refuses the whole launch, because the request did not come
/// from the user's choice.
fn env_in(
    vault: &dyn Vault,
    service: &str,
    path: &std::path::Path,
    agent: Option<&str>,
    names: &[String],
) -> Result<Vec<(String, String)>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let Some(agent) = agent else {
        return Err("le chiavi API vanno solo ad agenti e terminali".into());
    };
    let index = read_index(path);
    let by_name: BTreeMap<&str, &SecretInfo> = index.keys.iter().map(|key| (key.name.as_str(), key)).collect();
    let mut vars = Vec::new();
    for name in names {
        let Some(key) = by_name.get(name.as_str()) else {
            return Err(format!("chiave «{name}» non trovata"));
        };
        if !key.agents.iter().any(|allowed| allowed == agent) {
            return Err(format!("chiave «{name}» non assegnata a {agent} in Impostazioni › Chiavi API"));
        }
        // Checked again: the index is a file the user could have edited.
        check_env(&key.env)?;
        match vault.get(service, name)? {
            Some(value) => vars.push((key.env.clone(), value)),
            None => return Err(format!("chiave «{name}» senza valore nel portachiavi")),
        }
    }
    Ok(vars)
}

/// The variables `pty_spawn` sets when `command` is started with `names`. Called from Rust only.
pub fn env_for(app: &AppHandle, command: &str, names: &[String]) -> Result<Vec<(String, String)>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    env_in(&SystemVault, &service(app), &index_path(app)?, agent_for_command(command), names)
}

/// A key assigned to an agent, without its value.
#[derive(Debug, Serialize)]
pub struct AssignedSecret {
    pub name: String,
    pub env: String,
}

/// The keys the user gave to the agent `command` starts: names and variables,
/// read from the index alone. What a launch asks for, without touching the
/// keychain (which on macOS can prompt) for every key just to mask it.
#[tauri::command]
pub async fn secret_assigned(app: AppHandle, command: String) -> Result<Vec<AssignedSecret>, String> {
    let Some(agent) = agent_for_command(&command) else {
        return Ok(Vec::new());
    };
    Ok(assigned_in(&index_path(&app)?, agent)
        .into_iter()
        .map(|(name, env)| AssignedSecret { name, env })
        .collect())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/*
 * `async` for the reason in `lib.rs`: the keychain can block on a prompt
 * (macOS asks the first time), and a synchronous command would freeze the
 * window while it does.
 */

#[tauri::command]
pub async fn secret_list(app: AppHandle, lock: tauri::State<'_, SecretsLock>) -> Result<Vec<SecretInfo>, String> {
    let _guard = lock.0.lock().map_err(|_| "chiavi bloccate")?;
    list_in(&SystemVault, &service(&app), &index_path(&app)?)
}

#[tauri::command]
pub async fn secret_save(
    app: AppHandle,
    lock: tauri::State<'_, SecretsLock>,
    name: String,
    env: String,
    agents: Vec<String>,
    value: Option<String>,
) -> Result<(), String> {
    let _guard = lock.0.lock().map_err(|_| "chiavi bloccate")?;
    save_in(&SystemVault, &service(&app), &index_path(&app)?, name.trim(), env.trim(), agents, value.as_deref(), now_ms())
}

#[tauri::command]
pub async fn secret_delete(app: AppHandle, lock: tauri::State<'_, SecretsLock>, name: String) -> Result<(), String> {
    let _guard = lock.0.lock().map_err(|_| "chiavi bloccate")?;
    delete_in(&SystemVault, &service(&app), &index_path(&app)?, &name)
}

/// Seconds a copied key stays on the clipboard before ADE clears it.
const CLIPBOARD_CLEAR_SECS: u64 = 45;

/// Copies a key to the clipboard from here, so the value never enters the page.
/// Cleared after a while, unless something else was copied since.
#[tauri::command]
pub async fn secret_copy(app: AppHandle, lock: tauri::State<'_, SecretsLock>, name: String) -> Result<u64, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let value = {
        let _guard = lock.0.lock().map_err(|_| "chiavi bloccate")?;
        if !read_index(&index_path(&app)?).keys.iter().any(|key| key.name == name) {
            return Err(format!("chiave «{name}» non trovata"));
        }
        SystemVault
            .get(&service(&app), &name)?
            .ok_or_else(|| format!("chiave «{name}» senza valore nel portachiavi"))?
    };
    app.clipboard().write_text(value.clone()).map_err(|_| "appunti non disponibili".to_string())?;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(CLIPBOARD_CLEAR_SECS));
        if handle.clipboard().read_text().ok().as_deref() == Some(value.as_str()) {
            let _ = handle.clipboard().write_text(String::new());
        }
    });
    Ok(CLIPBOARD_CLEAR_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryVault(Mutex<HashMap<(String, String), String>>);

    impl Vault for MemoryVault {
        fn get(&self, service: &str, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(&(service.into(), name.into())).cloned())
        }
        fn set(&self, service: &str, name: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert((service.into(), name.into()), value.into());
            Ok(())
        }
        fn delete(&self, service: &str, name: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(&(service.into(), name.into()));
            Ok(())
        }
    }

    fn temp_index(tag: &str) -> PathBuf {
        let dir = std::env::current_dir().unwrap().join("target").join("secrets-test").join(format!("{tag}-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("secrets-index.json")
    }

    const FAKE: &str = "sk-test-0000000000000000abcd";

    #[test]
    fn the_value_goes_to_the_vault_and_only_names_to_the_file() {
        let vault = MemoryVault::default();
        let path = temp_index("file");
        save_in(&vault, "svc", &path, "OpenAI", "OPENAI_API_KEY", vec!["codex".into(), "codex".into()], Some(FAKE), 7).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(FAKE) && !text.contains("abcd") && !text.contains("masked"), "the index holds no part of the value");
        let listed = list_in(&vault, "svc", &path).unwrap();
        assert_eq!(listed[0].masked.as_deref(), Some("••••••••abcd"));
        assert_eq!(listed[0].agents, vec!["codex".to_string()]);
        assert_eq!(listed[0].created_ms, 7);
    }

    #[test]
    fn metadata_changes_without_retyping_the_value_and_delete_removes_both() {
        let vault = MemoryVault::default();
        let path = temp_index("edit");
        assert!(save_in(&vault, "svc", &path, "Stripe", "STRIPE_KEY", vec![], None, 1).is_err());
        save_in(&vault, "svc", &path, "Stripe", "STRIPE_KEY", vec![], Some(FAKE), 1).unwrap();
        save_in(&vault, "svc", &path, "Stripe", "STRIPE_SECRET_KEY", vec!["claude-code".into()], None, 9).unwrap();
        let listed = list_in(&vault, "svc", &path).unwrap();
        assert_eq!((listed[0].env.as_str(), listed[0].created_ms), ("STRIPE_SECRET_KEY", 1));
        assert_eq!(
            env_in(&vault, "svc", &path, Some("claude-code"), &["Stripe".into()]).unwrap(),
            vec![("STRIPE_SECRET_KEY".into(), FAKE.into())]
        );
        delete_in(&vault, "svc", &path, "Stripe").unwrap();
        assert!(list_in(&vault, "svc", &path).unwrap().is_empty());
        assert_eq!(vault.get("svc", "Stripe").unwrap(), None);
    }

    #[test]
    fn two_keys_cannot_claim_one_variable() {
        let vault = MemoryVault::default();
        let path = temp_index("dup");
        save_in(&vault, "svc", &path, "A", "API_KEY", vec![], Some(FAKE), 1).unwrap();
        assert!(save_in(&vault, "svc", &path, "B", "API_KEY", vec![], Some(FAKE), 1).is_err());
    }

    #[test]
    fn a_launch_asking_for_a_missing_key_fails_instead_of_starting_without_it() {
        let vault = MemoryVault::default();
        let path = temp_index("missing");
        assert!(env_in(&vault, "svc", &path, Some("codex"), &["Nope".into()]).is_err());
    }

    /// The review's scenario: the page asks for every key on a shell, or for
    /// a key the user did not give to Claude Code.
    #[test]
    fn a_launch_gets_only_keys_assigned_to_the_agent_its_command_starts() {
        let vault = MemoryVault::default();
        let path = temp_index("assigned");
        save_in(&vault, "svc", &path, "Anthropic", "ANTHROPIC_API_KEY", vec![], Some(FAKE), 1).unwrap();
        save_in(&vault, "svc", &path, "OpenAI", "OPENAI_API_KEY", vec!["codex".into()], Some(FAKE), 1).unwrap();
        let all = vec!["Anthropic".to_string(), "OpenAI".to_string()];

        let shell = env_in(&vault, "svc", &path, agent_for_command("powershell.exe"), &all).unwrap_err();
        assert!(shell.contains("non assegnata a terminal"), "{shell}");
        let claude = env_in(&vault, "svc", &path, agent_for_command("claude"), &["Anthropic".into()]).unwrap_err();
        assert!(claude.contains("non assegnata a claude-code"), "{claude}");
        assert!(env_in(&vault, "svc", &path, agent_for_command("ssh"), &["OpenAI".into()]).is_err());

        let codex = env_in(&vault, "svc", &path, agent_for_command("codex.cmd"), &["OpenAI".into()]).unwrap();
        assert_eq!(codex, vec![("OPENAI_API_KEY".to_string(), FAKE.to_string())]);
        assert_eq!(env_in(&vault, "svc", &path, None, &[]).unwrap(), vec![]);

        assert_eq!(assigned_in(&path, "codex"), vec![("OpenAI".to_string(), "OPENAI_API_KEY".to_string())]);
        assert!(assigned_in(&path, "claude-code").is_empty());
    }

    #[test]
    fn commands_map_to_the_agent_ids_the_page_uses() {
        assert_eq!(agent_for_command("claude"), Some("claude-code"));
        assert_eq!(agent_for_command("CMD.EXE"), Some("terminal"));
        assert_eq!(agent_for_command("zsh"), Some("terminal"));
        assert_eq!(agent_for_command("kimi"), Some("kimi"));
        assert_eq!(agent_for_command("ssh"), None);
        assert_eq!(agent_for_command("evil"), None);
    }

    #[test]
    fn names_variables_and_values_are_checked() {
        assert!(check_name("GitHub token").is_ok());
        assert!(check_name("../x").is_err());
        assert!(check_env("OPENAI_API_KEY").is_ok());
        for bad in ["PATH", "ADE_PANE_TOKEN", "openai", "1KEY", "NODE_OPTIONS"] {
            assert!(check_env(bad).is_err(), "{bad}");
        }
        assert!(check_value("a\nb").is_err());
        assert!(check_value("  ").is_err());
        assert_eq!(mask("short"), "••••••••");
    }
}

/// ADE's desktop shell.
///
/// Deliberately thin: the product is the web bundle, so this crate opens the
/// window declared in tauri.conf.json and adds exactly one command of its own.
/// The main desktop app carries a sidecar server, deep links and an updater;
/// ADE ships with none of them, and inheriting them would tie its lifecycle to
/// a product it does not release with.
///
/// Where WebView2 cannot write its profile under %LOCALAPPDATA% — a locked-down
/// machine, or a sandboxed parent — set WEBVIEW2_USER_DATA_FOLDER before launch.
/// WebView2 reads that variable itself, but never gets the chance here: Tauri
/// always passes a data directory derived from the bundle identifier, and an
/// explicit path wins over the environment. So `open_main_window` reads the
/// variable and forwards it, which is what makes the escape hatch real.
mod agent_link;
mod brand;
mod append;
mod browse;
mod browser_shot;
mod frontend;
mod gateway;
mod media;
mod project_bytes;
mod pty;
mod record;
mod secrets;
mod serve;
mod serve_proxy;
mod shots;
mod mailbox;
mod stats;
mod tray;
mod tts;
mod usage;
mod vision;
mod update;
mod glass;

use serde::Serialize;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Where this window may write
// ---------------------------------------------------------------------------

/*
 * The commands below reach the disk directly, and the page that calls them is
 * not only ADE's own interface: the browser pane loads pages the user points it
 * at, and whatever runs in that frame can invoke everything registered here.
 * Reading is left open — the sidebar has to be able to open any project the
 * user names — but writing, linking and deleting are confined to directories
 * the user has actually opened, because those three are how a page turns "I can
 * call a command" into "I own this machine".
 *
 * The frontend registers a root when it discovers a project (`host/project.ts`).
 * Nothing is writable until it does, which is the safe direction to fail: an
 * editor that refuses to save says so, while a silent grant says nothing.
 */
///
/// The roots are canonical. The second list holds them as they were opened,
/// separators unified: ade-media compares a URL's text with both before it
/// resolves anything, and a URL carries the path as opened (`media.rs`).
#[derive(Default)]
pub struct WriteRoots(Mutex<Vec<PathBuf>>, Mutex<Vec<String>>);

/*
 * Most commands in this file are `async` without awaiting anything.
 *
 * That reads like a mistake and is not: a synchronous `#[tauri::command]` is
 * dispatched on the thread that owns the window, so a `read_dir` on a cold
 * network share or a `git status` on a large repository stops the window from
 * drawing until it finishes. Declaring them `async` moves them onto Tauri's
 * async runtime, which is all these need. Bounded waits such as `nikcli_bot`
 * and `nikcli_serve_start` go further onto a blocking worker. `pty.rs` reached
 * the same conclusion first and documents it on `pty_write`.
 */

/// Adds a directory to the set this window may write inside.
#[tauri::command]
async fn allow_write_root(roots: tauri::State<'_, WriteRoots>, path: String) -> Result<(), String> {
    let resolved = Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;
    if !resolved.is_dir() {
        return Err(format!("non è una cartella: {path}"));
    }
    if let Some(reason) = too_broad_root(&resolved, dirs::home_dir().as_deref()) {
        return Err(format!("{path}: {reason}"));
    }
    let mut allowed = roots.0.lock().map_err(|_| "radici bloccate")?;
    if !allowed.contains(&resolved) {
        allowed.push(resolved);
    }
    drop(allowed);
    let as_opened = path.replace('\\', "/");
    let mut opened = roots.1.lock().map_err(|_| "radici bloccate")?;
    if !opened.contains(&as_opened) {
        opened.push(as_opened);
    }
    Ok(())
}

/// The file `ade-msg design` names, if a pane may show it: see `media::design_sheet`.
///
/// Checked here, against the folders ADE serves, because only this side can
/// resolve a link; the page asks and shows the refusal it gets back.
#[tauri::command]
async fn design_sheet_path(roots: tauri::State<'_, WriteRoots>, path: String, cwd: String) -> Result<String, String> {
    let served = roots.0.lock().map(|guard| guard.clone()).unwrap_or_default();
    let opened = roots.1.lock().map(|guard| guard.clone()).unwrap_or_default();
    media::design_sheet(&served, &opened, &path, &cwd).map(|sheet| sheet.to_string_lossy().into_owned())
}

/// Why `dir` cannot be a write root, when it cannot.
///
/// Any folder used to be accepted, so a caller could register the drive root or
/// the home directory and the confinement below confined nothing. A project is
/// a folder the user works in; a directory holding the user's whole profile, a
/// system directory or ADE's own configuration is not one, whoever asks.
fn too_broad_root(dir: &Path, home: Option<&Path>) -> Option<&'static str> {
    if dir.parent().is_none() {
        return Some("la radice del disco non è un progetto");
    }
    // `\\?\C:\` is a prefix plus a root: two components, and no real parent.
    #[cfg(windows)]
    if dir.components().count() <= 2 {
        return Some("la radice del disco non è un progetto");
    }
    if let Some(home) = home.and_then(|h| h.canonicalize().ok()) {
        if home.starts_with(dir) {
            return Some("la cartella utente (o una sua antenata) non è un progetto");
        }
        for private in [".ssh", ".gnupg", ".aws", ".config", ".claude", ".codex", "AppData"] {
            if dir.starts_with(home.join(private)) {
                return Some("cartella di configurazione dell'utente");
            }
        }
    }
    let lowered = dir.to_string_lossy().to_lowercase().replace('\\', "/");
    for system in ["/windows", "/program files", "/program files (x86)", "/programdata"] {
        if lowered.contains(&format!(":{system}")) {
            return Some("cartella di sistema");
        }
    }
    #[cfg(not(windows))]
    for system in ["/etc", "/usr", "/bin", "/sbin", "/var", "/System", "/Library"] {
        if dir.starts_with(system) {
            return Some("cartella di sistema");
        }
    }
    None
}

/// True when a write would land where git reads commands from.
///
/// A project root contains its `.git`, and `.git/config` (`core.pager`,
/// `core.fsmonitor`, aliases) or anything under `.git/hooks` runs the next time
/// git does — which ADE itself does every few seconds. The editor never needs
/// either; `.git/info/exclude`, which ADE does write, stays allowed.
fn is_git_executable_path(path: &Path) -> bool {
    let names: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    names.iter().enumerate().any(|(i, name)| {
        if name != ".git" {
            return false;
        }
        let mut rest = &names[i + 1..];
        // `.git/worktrees/<name>/config.worktree` is the same file for a worktree,
        // and `.git/modules/<name>/…` is a submodule's own `.git`, nested as deep
        // as the submodules are (review area 1, MEDIO 3).
        while let [dir, _, tail @ ..] = rest {
            if dir != "worktrees" && dir != "modules" {
                break;
            }
            rest = tail;
        }
        // `.git` itself: a file there is a `gitdir:` pointer, which sends git
        // to read its config (and hooks) from wherever it names. `commondir`
        // does the same for a worktree.
        rest.is_empty()
            || matches!(rest.first().map(String::as_str), Some("hooks"))
            || matches!(rest, [f] if f == "config" || f == "config.worktree" || f == "commondir")
    })
}

/// Resolves `path` to a form that can be compared against a root, without
/// requiring it to exist yet.
///
/// `canonicalize` is the only thing that follows a junction or a symlink, and
/// following them is the point: a link planted inside the project and aimed at
/// the user's startup folder would sail through a textual prefix check. But it
/// needs the path to exist, and a file being saved for the first time does not.
/// So the deepest existing ancestor is canonicalised and the names below it are
/// appended — with `..` refused rather than resolved, since a `..` that climbs
/// out of the root is exactly what this is here to stop.
fn resolve_for_check(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };

    let mut existing = absolute.as_path();
    let mut below: Vec<&OsStr> = Vec::new();
    while !existing.exists() {
        let (Some(name), Some(parent)) = (existing.file_name(), existing.parent()) else {
            return Err(format!("percorso irrisolvibile: {}", absolute.display()));
        };
        below.push(name);
        existing = parent;
    }

    let mut resolved = existing
        .canonicalize()
        .map_err(|e| format!("{}: {e}", absolute.display()))?;
    for name in below.iter().rev() {
        if *name == OsStr::new("..") {
            return Err(format!("percorso risalente: {}", absolute.display()));
        }
        if *name == OsStr::new(".") {
            continue;
        }
        resolved.push(name);
    }
    Ok(resolved)
}

/// The resolved path, when it falls inside a registered root; an error naming
/// the refusal otherwise.
fn within_roots(roots: &WriteRoots, path: &str) -> Result<PathBuf, String> {
    let resolved = resolve_for_check(Path::new(path))?;
    let allowed = roots.0.lock().map_err(|_| "radici bloccate")?;
    if allowed.is_empty() {
        return Err("nessun progetto aperto: scrittura non consentita".to_string());
    }
    // `starts_with` on a Path compares whole components, so a root of
    // `/work/app` does not also cover `/work/app-backup`.
    if allowed.iter().any(|root| resolved.starts_with(root)) {
        if is_git_executable_path(&resolved) {
            return Err(format!("configurazione o hook di git: {path}"));
        }
        return Ok(resolved);
    }
    Err(format!("fuori dal progetto: {path}"))
}

/// Whether `path` is a file of the project at `root` once links and
/// junctions are followed (C6 review, MEDIO): the chat's attachments.
///
/// nikcli reads a `file://` part itself, with `bypassCwdCheck` and without
/// asking (`session/prompt.ts`), so a link or a junction inside the project
/// aimed at `~/.ssh` or an `auth.json` would send that file to the provider.
/// Both sides are resolved (`resolve_for_check`, which follows them) and
/// compared by whole components (`starts_with`), so `app-backup` is not
/// inside `app`. The path must be absolute and an existing file.
///
/// A `.env` or `.env.*` is refused by the name it resolves to (`env`): nikcli
/// guards those files for its read tool, and an attachment skips that guard.
///
/// There is a window between this check and nikcli's read (TOCTOU): a link
/// swapped in between is read where it points then. Closing it would mean
/// sending the file's contents instead of its path; the check still stops
/// every link already there when the user attaches.
fn attachment_inside(root: &Path, path: &Path) -> Result<PathBuf, &'static str> {
    if !path.is_absolute() || !root.is_absolute() {
        return Err("outside");
    }
    let root = root.canonicalize().map_err(|_| "outside")?;
    let resolved = resolve_for_check(path).map_err(|_| "outside")?;
    if resolved == root || !resolved.starts_with(&root) {
        return Err("outside");
    }
    if !resolved.is_file() {
        return Err("notFile");
    }
    if is_env_file(&resolved) {
        return Err("env");
    }
    Ok(resolved)
}

/// `.env` or `.env.<anything>`, in any case.
fn is_env_file(path: &Path) -> bool {
    let name = path.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    name == ".env" || name.starts_with(".env.")
}

/// `"ok"`, or why the chat may not attach `path` (`attachment_inside`).
#[tauri::command]
fn chat_attachment_inside(root: String, path: String) -> String {
    match attachment_inside(Path::new(&root), Path::new(&path)) {
        Ok(_) => "ok".to_string(),
        Err(reason) => reason.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Filesystem commands — let the frontend read the disk without shelling out
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified_ms: f64,
}

/// Lists the contents of `path`, directories first, then files, both sorted
/// alphabetically (case-insensitive). Entries the OS refuses to stat are
/// silently skipped instead of aborting the whole listing.
#[tauri::command]
async fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut dirs: Vec<DirEntry> = Vec::new();
    let mut files: Vec<DirEntry> = Vec::new();

    for entry in rd {
        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let full = entry.path().to_string_lossy().into_owned();
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let de = DirEntry {
            name,
            path: full,
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified_ms,
        };
        if meta.is_dir() {
            dirs.push(de);
        } else {
            files.push(de);
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.append(&mut files);
    Ok(dirs)
}

#[derive(Serialize, Clone, Debug)]
struct FileRead {
    text: String,
    truncated: bool,
    bytes: usize,
}

/// Reads up to `max_bytes` of a text file. Returns an explicit error for
/// binary content so the frontend can tell the user instead of showing
/// mojibake.
#[tauri::command]
async fn read_text_file(path: String, max_bytes: usize) -> Result<FileRead, String> {
    read_text(&path, max_bytes)
}

/// The reading itself, as a plain function so the tests below can call it.
fn read_text(path: &str, max_bytes: usize) -> Result<FileRead, String> {
    /*
     * One byte past the cap, rather than the whole file. The sidebar makes it
     * one click to open a 2 GB pack file, and reading it whole would allocate
     * all of it — on the thread drawing the window — before this function got
     * the chance to say it was too big.
     */
    let file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let meta = file.metadata().map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("il percorso è una directory: {path}"));
    }
    let total = meta.len() as usize;

    let mut data: Vec<u8> = Vec::new();
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|e| format!("{path}: {e}"))?;

    let truncated = data.len() > max_bytes;
    let slice = if truncated { &data[..max_bytes] } else { &data[..] };

    /*
     * Cut on a character boundary, not a byte one.
     *
     * A perfectly good UTF-8 file whose millionth byte lands inside an accented
     * letter is not binary, and calling it one did real damage: the error came
     * back as an empty buffer, the "truncated" flag that guards against saving
     * a partial file was false, and one keystroke plus Ctrl+S wrote the empty
     * buffer over the original. An incomplete character at the very end is the
     * cut this function made; anything else really is not text.
     */
    let text = match std::str::from_utf8(slice) {
        Ok(whole) => whole.to_string(),
        Err(error)
            if truncated && error.error_len().is_none() && error.valid_up_to() > 0 =>
        {
            String::from_utf8_lossy(&slice[..error.valid_up_to()]).into_owned()
        }
        // The size travels with it: the file pane says what it could not show.
        Err(_) => return Err(format!("file binario, {total} byte")),
    };

    Ok(FileRead { text, truncated, bytes: total })
}

/// Writes `contents` to `path` atomically. Refuses to write if the path is a
/// directory. Creates any missing parent directories. Writes first to a sibling
/// temporary file and then renames it over the target to prevent partial writes
/// on interrupted saves.
#[tauri::command]
async fn write_text_file(
    roots: tauri::State<'_, WriteRoots>,
    path: String,
    contents: String,
) -> Result<(), String> {
    write_atomic(&roots, &path, contents.as_bytes())
}

/// The same write, for content that is not text.
///
/// The video panel's frame captures are PNGs, and there was no way to put one
/// on disk: base64 through `write_text_file` would have written the text of
/// the image. Same confinement, same atomic rename — only the bytes differ,
/// which is why both go through one function.
#[tauri::command]
async fn write_bytes(
    roots: tauri::State<'_, WriteRoots>,
    path: String,
    contents: Vec<u8>,
) -> Result<(), String> {
    write_atomic(&roots, &path, &contents)
}

fn write_atomic(roots: &WriteRoots, path: &str, bytes: &[u8]) -> Result<(), String> {
    let target = match within_roots(roots, path) {
        Ok(target) => target,
        Err(refusal) => global_bot_file(path).ok_or(refusal)?,
    };
    let target = target.as_path();
    if target.is_dir() {
        return Err(format!("il percorso è una directory: {path}"));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{path}: {e}"))?;
        }
    }

    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_else(|| "file".into());
    let now_nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_name = format!(".{file_name}.tmp_{}_{now_nanos}", std::process::id());
    let temp_path = parent.join(temp_name);

    if let Err(e) = std::fs::write(&temp_path, bytes) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("{path}: {e}"));
    }

    if let Err(e) = std::fs::rename(&temp_path, target) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("{path}: {e}"));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Bots: nikcli agent files, and the two nikcli commands the panel needs
// ---------------------------------------------------------------------------

/// nikcli's global configuration directory. Mirrors `globalConfigDir` in `bots/nikcli.ts`.
fn nikcli_global_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    #[cfg(windows)]
    let dir = home.join("AppData").join("Roaming").join("nikcli");
    #[cfg(not(windows))]
    let dir = home.join(".config").join("nikcli");
    Some(dir)
}

/// True for `<config>/agent(s)/**/<name>.md`: the shape of a bot's file.
fn is_bot_path(path: &Path, config: &Path) -> bool {
    let Ok(rest) = path.strip_prefix(config) else {
        return false;
    };
    let mut parts = rest.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase());
    let first = parts.next();
    let names: Vec<String> = parts.collect();
    matches!(first.as_deref(), Some("agent") | Some("agents"))
        && names.len() >= 1
        && names.len() <= 4
        && names.last().is_some_and(|n| n.ends_with(".md"))
        && names.iter().all(|n| n != ".." && n != ".")
}

/// A global bot's file, resolved, when `path` is one.
///
/// The global directory is not a write root — it also holds nikcli's providers
/// and plugins, which are code — so only agent files inside it are writable.
fn global_bot_file(path: &str) -> Option<PathBuf> {
    let config = nikcli_global_dir()?;
    let config = config.canonicalize().unwrap_or(config);
    let resolved = resolve_for_check(Path::new(path)).ok()?;
    is_bot_path(&resolved, &config).then_some(resolved)
}

/// Deletes a bot's file: a project one inside an open project's `.nikcli`, or a global one.
#[tauri::command]
async fn bot_delete(roots: tauri::State<'_, WriteRoots>, path: String) -> Result<(), String> {
    let project = within_roots(&roots, &path).ok().filter(|target| {
        target
            .ancestors()
            .any(|dir| dir.file_name().is_some_and(|n| n == ".nikcli") && is_bot_path(target, dir))
    });
    let target = project
        .or_else(|| global_bot_file(&path))
        .ok_or_else(|| format!("non è il file di un bot: {path}"))?;
    std::fs::remove_file(&target).map_err(|e| format!("{path}: {e}"))
}

/// The arguments `nikcli` may be run with from the bots panel.
///
///   nikcli --version
///   nikcli models
///   nikcli agent create --path <dir> --description <t> --mode <m> --tools <list> [--model <id>]
///
/// Each option once, each with a value, and `--path` a configuration root the
/// agent file is then written under.
///
/// `--version` is here rather than behind a door of its own: it is the same
/// program with fixed arguments, it writes nothing and reads nothing but
/// itself, and the top bar asks it a few times a day. A second command would
/// have been a second thing to keep in step with this list for no gain.
/// A provider id as nikcli names one (`openrouter`, `nikcli-inference`,
/// `amazon-bedrock`): letters, digits, `-`, `_` and `.`, starting with a letter
/// or a digit, so it can never read as an option.
fn is_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

fn check_nikcli_args(roots: &WriteRoots, args: &[String]) -> Result<(), String> {
    match args {
        [only] if only == "--version" => Ok(()),
        [only] if only == "models" => Ok(()),
        // One provider's catalog, read-only: its prices, for whether a routine's model is free (B11), and
        // its models' variants, the efforts a bot's form offers (chat-bot-facili, pezzo 0; `bots/catalog.ts`).
        // Any provider: the variants are every model's, not only those whose price of 0 means free.
        [models, provider, verbose] if models == "models" && verbose == "--verbose" && is_provider_id(provider) => Ok(()),
        // Every provider's, read-only: the bot form's models, names and variants included, when ADE's
        // server is not open on the bot's folder (composer-chip, pezzo 1; `bots/catalog.ts`).
        [models, verbose] if models == "models" && verbose == "--verbose" => Ok(()),
        [agent, create, rest @ ..] if agent == "agent" && create == "create" => {
            if rest.len() % 2 != 0 {
                return Err("argomenti di nikcli agent create incompleti".to_string());
            }
            let mut seen = Vec::new();
            for pair in rest.chunks(2) {
                let (flag, value) = (pair[0].as_str(), pair[1].as_str());
                if !["--path", "--description", "--mode", "--tools", "--model"].contains(&flag) || seen.contains(&flag) {
                    return Err(format!("opzione di nikcli non consentita: {flag}"));
                }
                seen.push(flag);
                if flag == "--path" {
                    let resolved = resolve_for_check(Path::new(value))?;
                    let global = nikcli_global_dir().map(|d| d.canonicalize().unwrap_or(d));
                    let in_project = within_roots(roots, value).is_ok();
                    if !in_project && global.as_deref() != Some(resolved.as_path()) {
                        return Err(format!("cartella dei bot non consentita: {value}"));
                    }
                }
            }
            if !seen.contains(&"--path") {
                return Err("nikcli agent create senza --path".to_string());
            }
            Ok(())
        }
        _ => Err("comando nikcli non consentito".to_string()),
    }
}

fn nikcli_timeout(args: &[String]) -> Duration {
    match args {
        [only] if only == "--version" => Duration::from_secs(15),
        [only] if only == "models" => Duration::from_secs(30),
        [models, ..] if models == "models" => Duration::from_secs(30),
        [agent, create, ..] if agent == "agent" && create == "create" => Duration::from_secs(120),
        _ => Duration::from_secs(120),
    }
}

#[cfg(windows)]
#[link(name = "ntdll")]
extern "system" {
    fn NtResumeProcess(process_handle: windows::Win32::Foundation::HANDLE) -> i32;
}

#[cfg(windows)]
fn resume_child(child: &std::process::Child) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    /*
     * The child starts suspended so it cannot create descendants before entering the job.
     * `std::process::Child` exposes the process handle, not the primary thread handle,
     * so the process is resumed through ntdll instead of `ResumeThread`.
     */
    let status =
        unsafe { NtResumeProcess(windows::Win32::Foundation::HANDLE(child.as_raw_handle())) };
    if status < 0 {
        return Err(format!("nikcli non può essere riattivato: {status:#x}"));
    }
    Ok(())
}

#[cfg(windows)]
struct ChildTreeGuard(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ChildTreeGuard {
    fn new() -> Result<Self, String> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let handle =
            unsafe { CreateJobObjectW(None, None) }.map_err(|error| error.message().to_string())?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // Closing the guard also kills descendants left behind by a completed command.
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if let Err(error) = result {
            let _ = unsafe { CloseHandle(handle) };
            return Err(error.message().to_string());
        }
        Ok(Self(handle))
    }

    fn assign_pid(&self, pid: u32) -> Result<(), String> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) }
            .map_err(|error| error.message().to_string())?;
        let result = unsafe { AssignProcessToJobObject(self.0, process) };
        let _ = unsafe { CloseHandle(process) };
        result.map_err(|error| error.message().to_string())
    }
}

#[cfg(windows)]
impl Drop for ChildTreeGuard {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(not(windows))]
struct ChildTreeGuard;

#[cfg(not(windows))]
impl ChildTreeGuard {
    fn new() -> Result<Self, String> {
        Ok(Self)
    }

    fn assign_pid(&self, _pid: u32) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
fn kill_process_tree_fallback(_pid: u32) {}

#[cfg(unix)]
fn kill_process_tree_fallback(pid: u32) {
    let pid = format!("-{pid}");
    let _ = std::process::Command::new("kill")
        .args(["-KILL", "--", &pid])
        .status();
}

#[cfg(not(any(windows, unix)))]
fn kill_process_tree_fallback(pid: u32) {
    let _ = pty::kill_tree(pid);
}

fn terminate_child_tree(
    child: &mut std::process::Child,
    pid: u32,
    guard: &mut Option<ChildTreeGuard>,
    job_assigned: bool,
) {
    drop(guard.take());
    if !job_assigned {
        kill_process_tree_fallback(pid);
    }
    #[cfg(not(windows))]
    let _ = pty::kill_tree(pid);
    let _ = child.kill();
    let _ = child.wait();
}

fn run_bounded_output(
    mut command: std::process::Command,
    timeout: Duration,
    label: &str,
) -> Result<ShellOutput, String> {
    use std::process::Stdio;

    let mut tree_guard = Some(ChildTreeGuard::new().map_err(|error| {
        format!("Impossibile creare il job Windows che protegge {label}: {error}. Riavvia ADE e riprova.")
    })?);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0004);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{label} non eseguibile: {error}"))?;
    let pid = child.id();
    let job_assigned = if cfg!(windows) {
        let Some(guard) = tree_guard.as_ref() else {
            terminate_child_tree(&mut child, pid, &mut tree_guard, false);
            return Err(
                format!("Impossibile proteggere {label} con il job Windows. Riavvia ADE e riprova."),
            );
        };
        match guard.assign_pid(pid) {
            Ok(()) => true,
            Err(error) => {
                terminate_child_tree(&mut child, pid, &mut tree_guard, false);
                return Err(format!(
                    "Impossibile assegnare {label} al job Windows: {error}. Riavvia ADE e riprova."
                ));
            }
        }
    } else {
        false
    };
    #[cfg(windows)]
    {
        if let Err(error) = resume_child(&child) {
            terminate_child_tree(&mut child, pid, &mut tree_guard, job_assigned);
            return Err(error);
        }
    }
    let Some(mut stdout) = child.stdout.take() else {
        terminate_child_tree(&mut child, pid, &mut tree_guard, job_assigned);
        return Err(format!("{label} non ha uno stdout leggibile"));
    };
    let Some(mut stderr) = child.stderr.take() else {
        terminate_child_tree(&mut child, pid, &mut tree_guard, job_assigned);
        return Err(format!("{label} non ha uno stderr leggibile"));
    };
    let out_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                terminate_child_tree(&mut child, pid, &mut tree_guard, job_assigned);
                return Err(format!(
                    "{label} non ha risposto entro {} secondi ed è stato fermato.",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                terminate_child_tree(&mut child, pid, &mut tree_guard, job_assigned);
                return Err(format!("{label} non eseguibile: {error}"));
            }
        }
    };
    let drain_deadline = Instant::now() + Duration::from_secs(1);
    while !out_reader.is_finished() || !err_reader.is_finished() {
        if Instant::now() >= drain_deadline {
            terminate_child_tree(&mut child, pid, &mut tree_guard, job_assigned);
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let stdout = out_reader
        .join()
        .map_err(|_| format!("lettura dell'output di {label} fallita"))?;
    let stderr = err_reader
        .join()
        .map_err(|_| format!("lettura degli errori di {label} fallita"))?;
    Ok(ShellOutput {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// Runs `nikcli models` or `nikcli agent create`, and hands back what it printed.
#[tauri::command]
async fn nikcli_bot(
    roots: tauri::State<'_, WriteRoots>,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<ShellOutput, String> {
    check_nikcli_args(&roots, &args)?;
    let program = pty::which_on_path("nikcli").ok_or("nikcli non trovato nel PATH")?;
    let mut command = std::process::Command::new(program);
    command.args(&args);
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let timeout = nikcli_timeout(&args);
    tauri::async_runtime::spawn_blocking(move || run_bounded_output(command, timeout, "nikcli"))
        .await
        .map_err(|_| "avvio di nikcli interrotto".to_string())?
}

/// Runs `claude agents --json`, the CLI's own list of its live sessions, and
/// hands back what it printed.
///
/// One program, fixed arguments, nothing from the caller but a directory: the
/// list is what native mail delivery is routed on, and `run` is git-only on
/// purpose (see below), so this is the second door of its kind, next to
/// `nikcli_bot`. An older CLI without the subcommand exits non-zero, and the
/// caller reads that as "the CLI does not list".
#[tauri::command]
async fn claude_agents(cwd: Option<String>) -> Result<ShellOutput, String> {
    let program = pty::which_on_path("claude").ok_or("claude non trovato nel PATH")?;
    let mut command = std::process::Command::new(program);
    command.args(["agents", "--json"]);
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }
    tauri::async_runtime::spawn_blocking(move || list_claude_agents(command, CLAUDE_AGENTS_TIMEOUT))
        .await
        .map_err(|_| "elenco degli agenti di claude interrotto".to_string())?
}

/// How long `claude agents` has. The page asks every 5 s, so a listing that
/// takes longer than this is one the next call would have replaced anyway.
const CLAUDE_AGENTS_TIMEOUT: Duration = Duration::from_secs(10);

/// Off the async runtime and on a clock, like `claude_version` and `nikcli_bot`:
/// a bare `output()` inside the async command held a Tauri worker, and left the
/// child hanging, for as long as a stuck `claude` did not answer — once per call,
/// every 5 s, until the app's async commands stopped.
fn list_claude_agents(command: std::process::Command, timeout: Duration) -> Result<ShellOutput, String> {
    run_bounded_output(command, timeout, "claude")
}

/// Runs `claude --version` and hands back its first line, or None.
///
/// The hook form depends on it (audit 0.7.7, C3): the exec form, `command`
/// plus `args`, is only written for a Claude Code known to read `args`. An
/// older one may drop the field and run `powershell` bare, which reads the
/// hook's stdin — the prompt — as commands. One program, one fixed argument,
/// nothing from the caller; the page asks once per session.
#[tauri::command]
async fn claude_version() -> Option<String> {
    let program = pty::which_on_path("claude")?;
    let mut command = std::process::Command::new(program);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    /*
     * Off the async runtime and on a clock. A `claude` that never answers — a
     * broken node, a slow start under load, some day an update prompt — used to
     * hold a Tauri worker forever and leave the child hanging; now it is killed
     * after five seconds and the answer is None, which the page reads as "write
     * the shell form", the safe direction.
     */
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = command.spawn().ok()?;
        first_line_within(&mut child, std::time::Duration::from_secs(5))
    })
    .await
    .ok()
    .flatten()
}

/// Reads `reader` on a thread of its own, sending what it has as it goes.
///
/// The reader is never joined. A thread that is blocked in `read` on a pipe
/// somebody else holds does not come back, and there is no timeout on a join, so
/// joining is how a bounded wait became an unbounded one. What the caller waits
/// for instead is a channel, and this is what puts bytes on it.
fn read_on_a_thread(mut reader: Box<dyn std::io::Read + Send>) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut chunk = vec![0_u8; 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    // Nobody waiting any more is a normal end, not an error: the
                    // caller gave up and this thread can stop reading.
                    if tx.send(chunk[..read].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
        // Dropping the sender is how the reader says it is finished.
    });
    rx
}

/// Collects what a reader sent, until it finishes or `limit` runs out.
///
/// Every chunk, not the first one: a line that arrives in two reads is one line,
/// and a `PATH` longer than the buffer is still a `PATH` with its marker at the
/// end. The first chunk alone is what a `recv_timeout` returns, and a caller that
/// takes it has half a line whenever the pipe split one.
fn collect_until(rx: std::sync::mpsc::Receiver<Vec<u8>>, limit: std::time::Duration) -> Option<Vec<u8>> {
    let deadline = std::time::Instant::now() + limit;
    let mut out: Vec<u8> = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left) {
            Ok(chunk) => out.extend_from_slice(&chunk),
            // Finished, or out of time. Both end the wait; what arrived so far is
            // what there is, and the caller decides whether that is a line.
            Err(_) => break,
        }
    }
    (!out.is_empty()).then_some(out)
}

/// The first line of some output, at most 200 characters, trimmed.
fn first_line_of(out: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(out);
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.chars().take(200).collect())
}

/// The first line out of `reader`, within `limit`, with nothing joined.
///
/// This is the part both callers share, and it is a function of its own so a test
/// can hand it a reader that misbehaves on purpose — one that sends a line in
/// pieces, one that never finishes — instead of a process to arrange.
///
/// `cfg(test)` because this is the seam the tests use and nothing else calls it:
/// the two callers read their own pipe and go through `collect_until` directly,
/// because each has its own deadline to honour. It stays as a function so the
/// behaviour that matters — a line in pieces, a reader that never finishes — is
/// tested on the same code the callers use and not on a copy of it.
#[cfg(test)]
fn first_line_from(reader: Box<dyn std::io::Read + Send>, limit: std::time::Duration) -> Option<String> {
    let rx = read_on_a_thread(reader);
    let out = collect_until(rx, limit)?;
    first_line_of(&out)
}

/// Waits up to `timeout` for `child` to exit and returns the first line of its
/// stdout, at most 200 characters. A child that fails, or is still running at
/// the deadline, gives None; the late one is killed and reaped first.
///
/// The deadline is the deadline: it bounds the wait for the output as well as the
/// wait for the process, and nothing on the way out is joined. See
/// `read_on_a_thread` for what that costs when it is not done, and
/// `collect_until` for why the first chunk is not the answer.
fn first_line_within(child: &mut std::process::Child, timeout: std::time::Duration) -> Option<String> {
    use std::time::Instant;

    let stdout = child.stdout.take()?;
    // Read on a thread so the pipe cannot fill and stall the child while the
    // loop below waits on it.
    let rx = read_on_a_thread(Box::new(stdout));
    let started = Instant::now();
    let deadline = started + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    // The child is gone, so what the reader sends is all there will be. What is
    // left of the deadline is what there is time for.
    let left = deadline.saturating_duration_since(Instant::now());
    let out = collect_until(rx, left)?;
    first_line_of(&out)
}

// ---------------------------------------------------------------------------
// git, behind a gate of its own
// ---------------------------------------------------------------------------

/*
 * Why git does not go through the shell plugin any more.
 *
 * The plugin validates arguments by position: an allowlist entry describes
 * argument one, argument two, and so on, for a fixed count. ADE calls git with
 * anything from two arguments to seven, so the only entry that fit was
 * `"args": true` — and `"args": true` on git is arbitrary execution, because
 * git takes a command as data in several places:
 *
 *   git -c core.pager=<anything> log
 *   git -c protocol.ext.allow=always clone ext::sh -c <anything>
 *   git --exec-path=<dir> <anything in that dir>
 *
 * Here the check can be about meaning instead of position. The first argument
 * must be a subcommand ADE actually uses, which leaves no room in front of it
 * for a `-c`; the handful of per-subcommand options that also carry a command
 * are refused wherever they appear; and the environment is narrowed to the one
 * variable ADE sets, so GIT_PAGER and friends cannot arrive that way either.
 */
const GIT_SUBCOMMANDS: &[&str] = &[
    "status",
    "worktree",
    "rev-parse",
    "rev-list",
    "branch",
    "add",
    "commit",
    "commit-tree",
    "write-tree",
    "merge",
    "rebase",
    "cherry-pick",
    "diff",
    "show",
    "log",
    "ls-files",
];

/// Options that hand git something to run. Refused at any position.
const GIT_EXECUTING_FLAGS: &[&str] = &[
    "-c",
    "--config-env",
    "--exec-path",
    "--upload-pack",
    "--receive-pack",
    "--exec",
    "--ext-diff",
    "--textconv",
];

/// Options that make git write a file of the caller's choosing, outside the
/// confinement every other write in this file goes through.
const GIT_WRITING_FLAGS: &[&str] = &["--output", "--output-directory"];

/// The only variable ADE sets for git: the throwaway index a snapshot stages
/// into, so the user's real index is never touched.
const GIT_ENV_KEYS: &[&str] = &["GIT_INDEX_FILE"];

#[derive(Serialize, Clone, Debug)]
struct ShellOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Where a git call would write outside the index and the work tree it runs
/// in: a `worktree add` or `move` destination, and a `GIT_INDEX_FILE`. Each
/// must be a place ADE may write, inside a project, or the
/// `<project>-worktrees` folder beside one, where ADE puts its own checkouts
/// (`worktreePlan`).
///
/// Only the flags were checked: a commit holding a PowerShell profile,
/// then `worktree add` into the profile's folder, wrote outside every root and
/// ran at the next PowerShell start (review area 1, MEDIO 2).
fn check_git_destinations(
    roots: &WriteRoots,
    args: &[String],
    cwd: Option<&str>,
    env: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let base = match cwd.filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    let place = |raw: &str| -> Result<(), String> {
        let resolved = resolve_for_check(&base.join(raw))?;
        let allowed = roots.0.lock().map_err(|_| "radici bloccate")?;
        let beside = |root: &PathBuf| match (root.parent(), root.file_name()) {
            (Some(parent), Some(name)) => {
                let mut container = name.to_os_string();
                container.push("-worktrees");
                resolved.parent() == Some(parent.join(container).as_path())
            }
            _ => false,
        };
        if allowed.iter().any(|root| resolved.starts_with(root) || beside(root)) && !is_git_executable_path(&resolved) {
            Ok(())
        } else {
            Err(format!("git scriverebbe fuori dal progetto: {raw}"))
        }
    };
    if args.first().map(String::as_str) == Some("worktree") {
        let sub = args.get(1).map(String::as_str);
        if matches!(sub, Some("add" | "move")) {
            // The positionals, past the options and the values some of them take.
            let mut positionals = Vec::new();
            let mut rest = args[2..].iter();
            while let Some(arg) = rest.next() {
                if arg == "-b" || arg == "-B" || arg == "--reason" {
                    rest.next();
                } else if !arg.starts_with('-') {
                    positionals.push(arg.as_str());
                }
            }
            let destination = if sub == Some("add") { positionals.first() } else { positionals.get(1) };
            place(destination.ok_or("git worktree senza cartella di destinazione")?)?;
        }
    }
    if let Some(index) = env.get("GIT_INDEX_FILE") {
        // The review's own index is in the repository's git dir, which for a
        // project that is itself a worktree is the main repository's, outside
        // every root: that one name, under a `.git`, is allowed wherever it is.
        let resolved = resolve_for_check(&base.join(index))?;
        let review_index = resolved.file_name() == Some(std::ffi::OsStr::new("ade-review-index"))
            && resolved.components().any(|part| part.as_os_str().eq_ignore_ascii_case(".git"))
            && !is_git_executable_path(&resolved);
        if !review_index {
            place(index)?;
        }
    }
    Ok(())
}

fn check_git_args(args: &[String]) -> Result<(), String> {
    let Some(subcommand) = args.first() else {
        return Err("git senza sottocomando".to_string());
    };
    if !GIT_SUBCOMMANDS.contains(&subcommand.as_str()) {
        return Err(format!("sottocomando git non consentito: {subcommand}"));
    }
    for arg in &args[1..] {
        if arg == "--" {
            break;
        }
        // `--exec-path=/tmp/x` and `--exec-path /tmp/x` are the same option.
        let head = arg.split('=').next().unwrap_or(arg);
        if GIT_EXECUTING_FLAGS.contains(&head) || GIT_WRITING_FLAGS.contains(&head) {
            return Err(format!("opzione git non consentita: {arg}"));
        }
        /*
         * `rebase -x <cmd>` is `--exec`, and git's option parser also takes it
         * glued (`-xcmd`) or clustered (`-ix cmd`). Any short-option cluster
         * holding an x is refused for rebase; `cherry-pick -x` only annotates
         * the message and stays allowed.
         */
        if subcommand == "rebase" && arg.starts_with('-') && !arg.starts_with("--") && arg[1..].contains('x') {
            return Err(format!("opzione git non consentita: {arg}"));
        }
    }
    Ok(())
}

/// Runs one git command and hands back what it printed.
#[tauri::command]
async fn git_run(
    roots: tauri::State<'_, WriteRoots>,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<ShellOutput, String> {
    check_git_args(&args)?;
    let env = env.unwrap_or_default();
    check_git_destinations(&roots, &args, cwd.as_deref(), &env)?;

    let mut command = std::process::Command::new("git");
    command.args(&args);
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }
    for (key, value) in env {
        if !GIT_ENV_KEYS.contains(&key.as_str()) {
            return Err(format!("variabile non consentita: {key}"));
        }
        command.env(key, value);
    }

    /*
     * No console window. Without this flag every git call from a windowed
     * application flashes a black rectangle on screen, and ADE makes several
     * per keystroke-worth of activity.
     */
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|e| format!("git non eseguibile: {e}"))?;

    Ok(ShellOutput {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[tauri::command]
async fn current_dir() -> Result<String, String> {
    let dir = std::env::current_dir().map_err(|e| e.to_string())?;
    // An app opened from Finder or the Dock starts in `/`, which is nobody's
    // project; the home directory is where a terminal would have started.
    if dir.parent().is_none() {
        if let Some(home) = dirs::home_dir() {
            return Ok(home.to_string_lossy().into_owned());
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Gives a GUI launch the PATH the user's shell would have.
///
/// macOS starts apps from Finder or the Dock with launchd's PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so `nikcli`, `bun`, Homebrew and every
/// agent CLI are missing from the terminal panes, from the new-session form
/// (which then disables every agent as "not installed") and from `nikcli serve`.
///
/// The PATH becomes, in order: what the login shell reports, what the process
/// already had, and the directories the usual installers write to. The shell's
/// answer is the one that knows about nvm, asdf and custom profiles, but it can
/// fail — a slow `.zshrc`, a prompt waiting on input — so the known directories
/// are added whether it answered or not. Only directories that exist are kept.
#[cfg(unix)]
fn import_login_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = dirs::home_dir();
    let merged = merge_path(login_shell_path().as_deref(), &current, &known_bin_dirs(home.as_deref()));
    std::env::set_var("PATH", merged);
}

#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| s.starts_with('/'))
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut child = Command::new(&shell)
        .args(["-ilc", "printf '__ADE_PATH__%s__ADE_END__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    // Read on a thread so a chatty profile cannot fill the pipe and stall the
    // shell, and so the wait below can give up on one that never exits. Same
    // three pieces as the Windows side and for the same reasons: a channel, no
    // join, and every chunk rather than the first.
    let rx = read_on_a_thread(Box::new(stdout));
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    // The shell is gone, so what the reader sends is all there will be.
    let left = deadline.saturating_duration_since(Instant::now());
    let out = collect_until(rx, left)?;
    path_between_markers(&out)
}

/// The `PATH` between the two markers, from whatever the shell printed.
///
/// A function of its own, and not `cfg(unix)`, so a test can run it here: the two
/// callers of this logic are the shell on unix and the marker in a test, and the
/// part that goes wrong is arithmetic on an offset, which a Windows build cannot
/// see and neither can a test that never runs.
///
/// The start marker is looked for from the end and the end marker from the
/// beginning of what follows it, because a login profile prints things and one of
/// them may contain a marker: the last `__ADE_PATH__` is ours and the first
/// `__ADE_END__` after it is the end of ours. Bytes, not a String, because the
/// reader gives bytes and `rfind` on a `Vec<u8>` does not exist — which is how a
/// line that could not compile got committed once.
///
/// `allow(dead_code)` off unix: the only caller is `login_shell_path`, which is
/// `cfg(unix)`, so on Windows this exists for its four tests and nothing should
/// warn about a function that tests use.
#[cfg_attr(not(unix), allow(dead_code))]
fn path_between_markers(out: &[u8]) -> Option<String> {
    const START: &[u8] = b"__ADE_PATH__";
    const END: &[u8] = b"__ADE_END__";
    let start = out.windows(START.len()).rposition(|window| window == START)? + START.len();
    // `position` counts from where the slice starts, so this is the one addition
    // and there is no other. The first version added `start` twice and made
    // `out[start..end]` a slice out of range on the most ordinary output there is,
    // which on macOS is the first line of `run()`.
    let end = start + out[start..].windows(END.len()).position(|window| window == END)?;
    let path = String::from_utf8_lossy(&out[start..end]).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// Where Homebrew, bun, npm, pnpm, cargo, volta, pipx and nvm put binaries.
#[cfg(unix)]
fn known_bin_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = home {
        for relative in [
            ".bun/bin",
            ".local/bin",
            ".npm-global/bin",
            ".cargo/bin",
            ".volta/bin",
            ".deno/bin",
            ".opencode/bin",
            "Library/pnpm",
            ".local/share/pnpm",
            "bin",
        ] {
            dirs.push(home.join(relative));
        }
        // nvm has no stable "current" link; the newest installed Node is the
        // best guess at the one the user's shell selects.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            versions.sort();
            if let Some(newest) = versions.last() {
                dirs.push(newest.join("bin"));
            }
        }
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// Joins PATH sources in priority order, dropping empty and repeated entries.
#[cfg(unix)]
fn merge_path(login: Option<&str>, current: &str, known: &[PathBuf]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    let known = known.iter().map(|d| d.to_string_lossy().into_owned());
    for entry in login
        .unwrap_or("")
        .split(':')
        .map(str::to_string)
        .chain(current.split(':').map(str::to_string))
        .chain(known)
    {
        if !entry.is_empty() && seen.insert(entry.clone()) {
            out.push(entry);
        }
    }
    out.join(":")
}

#[tauri::command]
async fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "impossibile determinare la home".to_string())
}

#[tauri::command]
async fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Opens an ADE release page in the default browser.
///
/// Only the fork's release pages: the URL comes from GitHub's API, and a
/// command that opens any URL is one every page in the browser pane could call.
/// The shell plugin's own `open` permission stays out of the capabilities for
/// the same reason.
#[tauri::command]
async fn ade_open_release(app: tauri::AppHandle, url: String) -> Result<(), String> {
    const PREFIX: &str = "https://github.com/SandroHub013/nikcli/releases/";
    if !url.starts_with(PREFIX) || url.contains(char::is_whitespace) {
        return Err("non è una pagina di rilascio di ADE".into());
    }
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(url, None)
        .map_err(|e| e.to_string())
}

/// Whether `url` may be handed to the system browser: http or https only, no
/// whitespace or control characters, at most 2048 bytes. Anything else — a
/// `file:` URL, a `javascript:` one — could run something on the user's machine.
fn is_external_url(url: &str) -> bool {
    (url.starts_with("http://") || url.starts_with("https://"))
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Opens a link clicked in a session in the system browser (Ctrl+click).
///
/// A plain click opens ADE's own browser pane; this is for the logins that do
/// not work there. Only web URLs: see `is_external_url`.
#[tauri::command]
async fn ade_open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_external_url(&url) {
        return Err("non è un indirizzo web".into());
    }
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(url, None)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod external_url_tests {
    use super::{is_external_url, webview_on_screen};

    #[test]
    fn only_web_urls_reach_the_system_browser() {
        assert!(is_external_url("https://example.com/a?b=c"));
        assert!(!is_external_url("file:///C:/x"));
        assert!(!is_external_url("javascript:alert(1)"));
        assert!(!is_external_url("https://a b"));
        assert!(!is_external_url("https://x\n"));
        let long = format!("https://{}", "a".repeat(2049 - "https://".len()));
        assert_eq!(long.len(), 2049);
        assert!(!is_external_url(&long));
    }

    #[test]
    fn the_page_is_on_screen_only_while_the_window_is_shown_and_not_minimised() {
        assert!(webview_on_screen(true, false));
        assert!(!webview_on_screen(true, true));
        assert!(!webview_on_screen(false, false));
        assert!(!webview_on_screen(false, true));
    }
}

#[tauri::command]
fn ade_window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn ade_window_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn ade_window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Window close interception (D81, d81-chiusura)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseAction {
    PreventAndAsk(u64),
    AllowClose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseRequestStatus {
    Pending,
    Acked,
    Cancelled,
    Confirmed,
}

#[derive(Debug)]
pub(crate) struct CloseManager {
    confirmed: std::sync::atomic::AtomicBool,
    active_request: Mutex<Option<(u64, CloseRequestStatus)>>,
    request_counter: std::sync::atomic::AtomicU64,
    default_timeout: std::time::Duration,
}

impl CloseManager {
    pub(crate) fn new(default_timeout: std::time::Duration) -> Self {
        Self {
            confirmed: std::sync::atomic::AtomicBool::new(false),
            active_request: Mutex::new(None),
            request_counter: std::sync::atomic::AtomicU64::new(0),
            default_timeout,
        }
    }

    pub(crate) fn default_timeout(&self) -> std::time::Duration {
        self.default_timeout
    }

    pub(crate) fn on_close_requested(&self) -> CloseAction {
        use std::sync::atomic::Ordering;
        if self.confirmed.swap(false, Ordering::SeqCst) {
            CloseAction::AllowClose
        } else {
            let req_id = self.request_counter.fetch_add(1, Ordering::SeqCst) + 1;
            if let Ok(mut guard) = self.active_request.lock() {
                *guard = Some((req_id, CloseRequestStatus::Pending));
            }
            CloseAction::PreventAndAsk(req_id)
        }
    }

    pub(crate) fn ack(&self, request_id: u64) -> bool {
        if let Ok(mut guard) = self.active_request.lock() {
            if let Some((id, status)) = &mut *guard {
                if *id == request_id && *status == CloseRequestStatus::Pending {
                    *status = CloseRequestStatus::Acked;
                    return true;
                }
            }
        }
        false
    }

    pub(crate) fn confirm(&self, request_id: Option<u64>) -> bool {
        use std::sync::atomic::Ordering;
        let mut confirmed = false;
        if let Ok(mut guard) = self.active_request.lock() {
            if let Some((id, status)) = &mut *guard {
                if request_id.is_none() || request_id == Some(*id) {
                    *status = CloseRequestStatus::Confirmed;
                    confirmed = true;
                }
            } else if request_id.is_none() {
                confirmed = true;
            }
        }
        if confirmed {
            self.confirmed.store(true, Ordering::SeqCst);
        }
        confirmed
    }

    pub(crate) fn cancel(&self, request_id: Option<u64>) -> bool {
        if let Ok(mut guard) = self.active_request.lock() {
            if let Some((id, status)) = &mut *guard {
                if request_id.is_none() || request_id == Some(*id) {
                    *status = CloseRequestStatus::Cancelled;
                    return true;
                }
            }
        }
        false
    }

    pub(crate) fn on_timeout(&self, request_id: u64) -> bool {
        use std::sync::atomic::Ordering;
        let mut force_close = false;
        if let Ok(mut guard) = self.active_request.lock() {
            if let Some((id, status)) = &mut *guard {
                if *id == request_id && *status == CloseRequestStatus::Pending {
                    *status = CloseRequestStatus::Confirmed;
                    force_close = true;
                }
            }
        }
        if force_close {
            self.confirmed.store(true, Ordering::SeqCst);
        }
        force_close
    }
}

impl Default for CloseManager {
    fn default() -> Self {
        Self::new(std::time::Duration::from_secs(4))
    }
}

#[derive(Clone, serde::Serialize)]
struct CloseRequestPayload {
    #[serde(rename = "requestId")]
    request_id: u64,
}

fn attach_close_handler(window: &tauri::WebviewWindow, manager: std::sync::Arc<CloseManager>) {
    use tauri::Emitter;
    let target = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            use tauri::Manager;
            // A bot's gateway is on: the window goes, ADE stays in the tray (G11), once the page is asked.
            let app = target.app_handle();
            if tray::hides_on_close(app.state::<gateway::Gateway>().any_on(), app.state::<tray::Tray>().quitting()) {
                api.prevent_close();
                tray::request_hide(app);
                return;
            }
            match manager.on_close_requested() {
                CloseAction::AllowClose => {}
                CloseAction::PreventAndAsk(request_id) => {
                    api.prevent_close();
                    if let Err(err) = target.emit(
                        "ade-window-close-requested",
                        CloseRequestPayload { request_id },
                    ) {
                        eprintln!("ADE: errore emissione ade-window-close-requested: {err}");
                    }
                    let timeout = manager.default_timeout();
                    let mgr = manager.clone();
                    let win = target.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(timeout);
                        if mgr.on_timeout(request_id) {
                            eprintln!(
                                "ADE: la pagina non ha risposto entro {timeout:?}, chiusura finestra forzata"
                            );
                            let _ = win.close();
                        }
                    });
                }
            }
        }
    });
}

#[tauri::command]
fn ade_confirm_close(
    window: tauri::WebviewWindow,
    manager: tauri::State<'_, std::sync::Arc<CloseManager>>,
    request_id: Option<u64>,
) -> Result<(), String> {
    if manager.confirm(request_id) {
        window.close().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn ade_cancel_close(
    manager: tauri::State<'_, std::sync::Arc<CloseManager>>,
    tray: tauri::State<'_, tray::Tray>,
    request_id: Option<u64>,
) -> Result<(), String> {
    manager.cancel(request_id);
    // The user said no to closing: Esci from the tray is off again.
    tray.set_quitting(false);
    Ok(())
}

#[tauri::command]
fn ade_close_ack(
    manager: tauri::State<'_, std::sync::Arc<CloseManager>>,
    request_id: u64,
) -> Result<(), String> {
    manager.ack(request_id);
    Ok(())
}


#[tauri::command]
async fn write_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// What the frontend is told when a registered voice hotkey changes state.
#[derive(Clone, serde::Serialize)]
struct GlobalVoiceEvent {
    chord: String,
    state: &'static str,
}

/// True for the test build (`tauri.test.conf.json`).
///
/// The official ADE and the test one run side by side on the same machine:
/// the test build is what gets rebuilt, restarted and killed all day, the
/// official one is what the user is working in. They are told apart by the
/// identifier, which already gives the test build its own data directory,
/// WebView2 profile, mailbox and hooks; this covers what the identifier does
/// not separate.
pub(crate) fn is_test_build(app: &tauri::AppHandle) -> bool {
    app.config().identifier.ends_with(".test")
}

/// Whether the Windows session is locked, so always-on listening can pause.
///
/// While the lock screen is up the input desktop is Winlogon's, which this
/// process may not switch to: that refusal is the whole test. No event is
/// needed — the page asks every few seconds — and no new crate: two calls into
/// user32, which every Windows process already loads.
#[tauri::command]
fn session_locked() -> bool {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "user32")]
        extern "system" {
            fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut c_void;
            fn SwitchDesktop(desktop: *mut c_void) -> i32;
            fn CloseDesktop(desktop: *mut c_void) -> i32;
        }
        const DESKTOP_SWITCHDESKTOP: u32 = 0x0100;
        // SAFETY: plain Win32 calls; the handle is closed before returning.
        unsafe {
            let desktop = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
            if desktop.is_null() {
                return true;
            }
            let switched = SwitchDesktop(desktop);
            CloseDesktop(desktop);
            switched == 0
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
async fn register_global_voice_shortcut(app: tauri::AppHandle, chord: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    use std::str::FromStr;
    // Hotkeys are system-wide: a test build that registers the voice chords
    // takes them away from the official ADE, or fails because it holds them.
    if is_test_build(&app) {
        return Ok(());
    }
    let shortcut = Shortcut::from_str(&chord).map_err(|e| format!("Scorciatoia non valida '{chord}': {e}"))?;
    app.global_shortcut().register(shortcut).map_err(|e| format!("Registrazione fallita per '{chord}': {e}"))?;
    Ok(())
}

#[tauri::command]
async fn unregister_global_voice_shortcuts(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens ADE's window, and says out loud if it cannot.
///
/// Built here instead of declared in tauri.conf.json because a window that
/// fails to create from the config fails quietly: the process stays up, owning
/// nothing but its event-target window, and neither the log nor the exit code
/// mentions it. Building it explicitly turns that into an error with a reason.
fn open_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    // The config always names the product (`bun run brand` writes it); the
    // fallback reads the same brand.json, so no name is typed here.
    let mut title = app.config().product_name.clone().unwrap_or_else(|| crate::brand::name().to_owned());
    // `bun run test:app` names the worktree and branch, so with several test
    // instances open the taskbar says which is which.
    if is_test_build(app) {
        if let Ok(label) = std::env::var("ADE_TEST_LABEL") {
            if !label.trim().is_empty() {
                title = format!("{title} · {}", label.trim());
            }
        }
    }
    // The dev server is ADE's page only in a debug build; a release has none.
    #[cfg(all(windows, debug_assertions))]
    let dev_url = app.config().build.dev_url.clone();
    #[cfg(all(windows, not(debug_assertions)))]
    let dev_url: Option<tauri::Url> = None;
    let tray_title = title.clone();
    let builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .title(title)
        // A new document in the window is a new page: the old one's ptys have
        // no owner left. See `pty::Registry::end_all`. Only the top document
        // raises this, and on the first load there is nothing to end.
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                use tauri::Manager;
                window.state::<pty::Registry>().end_all_in_background();
                // Nor any listener for the chats' messages: they wait for the new page.
                window.state::<gateway::Gateway>().page_loading();
            }
        })
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .resizable(true)
        .transparent(true)
        .disable_drag_drop_handler()
        // In every frame: Tauri's IPC made inert, and the inspector bridge in
        // a browser pane's frame. See `src/browser/frame-script.ts`.
        .initialization_script_for_all_frames(include_str!("../scripts/browser-frame.js"))
        .center();

    // On macOS and Linux, `on_navigation` with `is_own_page` is also called for subframes:
    // - on macOS, wry 0.55.1 wkwebview/navigation.rs:50-81 does not check targetFrame.isMainFrame;
    // - on Linux, webkitgtk decide-policy also triggers for child frames.
    // This leaves the browser panel and Design preview frames white. This does not happen on Windows.
    // macOS and Linux revert to the 0.7.6 behavior (no on_navigation).
    #[cfg(windows)]
    let builder = builder.on_navigation(move |url| is_own_page(url, dev_url.as_ref()));

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    /*
     * An escape hatch for machines where WebView2 will not start.
     *
     * When msedgewebview2.exe dies during creation it takes the window with it,
     * and the app keeps running with nothing on screen: the least debuggable
     * failure a desktop app can have. Flags like `--disable-gpu` or
     * `--no-sandbox` fix whole classes of that, but naming any argument
     * replaces Tauri's own defaults, so this stays opt-in rather than becoming
     * a permanent cost for everyone:
     *
     *   set ADE_BROWSER_ARGS=--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu
     */
    #[cfg(windows)]
    let builder = match std::env::var("ADE_BROWSER_ARGS") {
        Ok(args) if !args.trim().is_empty() => builder.additional_browser_args(&args),
        _ => builder,
    };

    /*
     * Where the profile lives, when %LOCALAPPDATA% will not take it.
     *
     * Tauri's default is %LOCALAPPDATA%\<identifier>, and on a machine whose
     * anti-ransomware policy keys on the executable, an unsigned locally built
     * ade-desktop.exe cannot create it: `build()` fails with os error 5. Worse,
     * when the directory already exists but the browser process still cannot
     * write inside it, WebView2 gets far enough to show the window and then
     * dies a few seconds later with a Chromium CHECK — a window that opens and
     * vanishes, with nothing on stderr.
     */
    #[cfg(windows)]
    let builder = match std::env::var("WEBVIEW2_USER_DATA_FOLDER") {
        Ok(dir) if !dir.trim().is_empty() => builder.data_directory(PathBuf::from(dir.trim())),
        _ => builder,
    };

    let window = builder.build()?;

    {
        use tauri::Manager;
        let close_manager = app.state::<std::sync::Arc<CloseManager>>().inner().clone();
        attach_close_handler(&window, close_manager);
    }

    // With the window's name, «ADE Test · <worktree>» in a test build (G11).
    if let Err(error) = tray::install(app, &tray_title) {
        eprintln!("ADE: icona nella tray non creata: {error}");
    }

    #[cfg(windows)]
    {
        #[cfg(debug_assertions)]
        let origin = own_origin(tauri::Manager::config(&window).build.dev_url.as_ref());
        #[cfg(not(debug_assertions))]
        let origin = own_origin(None);
        browse::refuse_ade_in_frames(&window, origin);
        allow_own_microphone(&window);
        follow_window_visibility(&window);
    }

    window.show()?;
    window.set_focus()?;
    Ok(())
}

/**
 * The microphone for ADE's own page, without WebView2's permission prompt.
 *
 * WebView2 asks like a browser does — «tauri.localhost desidera usare i
 * microfoni» — and remembers the answer in the profile. A desktop app has no
 * browser settings to take a «Blocca» back, so one wrong click left the voice
 * assistant refusing to start for good, with an error pointing at settings
 * that do not exist. The page is the app itself: its request is granted, as a
 * native app's would be, and Windows' own microphone privacy switch still
 * applies. Anything else asking — a site in the browser pane's frame — keeps
 * the prompt.
 */
/**
 * Where ADE's page comes from. It is not loaded yet when the window is built,
 * so its address is the one it will have: Vite's in development, Tauri's own
 * scheme in a release (http://tauri.localhost on Windows, without
 * useHttpsScheme).
 */
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn own_origin(dev_url: Option<&tauri::Url>) -> String {
    dev_url
        .map(|url| url.origin().ascii_serialization())
        .filter(|origin| origin != "null")
        .unwrap_or_else(|| "http://tauri.localhost".to_string())
}

/// Whether the main window may go to `url`: ADE's own page and nothing else.
///
/// Tauri's scheme in a release (`tauri://localhost`, and `http(s)://tauri.localhost`
/// on Windows), plus the dev server's origin in development. Every other
/// top-level navigation is refused. A click in a markdown preview once took
/// the whole window to the page a README's form named; whatever lets a page
/// do that next, the window stays ADE.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn is_own_page(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" if url.host_str() == Some("tauri.localhost") => true,
        _ => dev_url.is_some_and(|dev| {
            let origin = dev.origin();
            origin.is_tuple() && origin == url.origin()
        }),
    }
}

#[cfg(test)]
mod own_page_tests {
    use super::is_own_page;

    fn url(text: &str) -> tauri::Url {
        tauri::Url::parse(text).unwrap()
    }

    #[test]
    fn a_release_allows_only_tauris_own_scheme() {
        for allowed in ["tauri://localhost/", "tauri://localhost/index.html", "http://tauri.localhost/", "https://tauri.localhost/a?b"] {
            assert!(is_own_page(&url(allowed), None), "{allowed}");
        }
        for refused in [
            "https://example.com/form?",
            "http://localhost:5177/",
            "http://tauri.localhost.example.com/",
            "tauri://example.com/",
            "file:///C:/x",
            "about:blank",
            "data:text/html,x",
        ] {
            assert!(!is_own_page(&url(refused), None), "{refused}");
        }
    }

    #[test]
    fn development_adds_the_dev_server_origin_only() {
        let dev = url("http://localhost:5177");
        assert!(is_own_page(&url("http://localhost:5177/"), Some(&dev)));
        assert!(is_own_page(&url("http://localhost:5177/src/index.html?x"), Some(&dev)));
        assert!(is_own_page(&url("tauri://localhost/"), Some(&dev)));
        assert!(!is_own_page(&url("http://localhost:5178/"), Some(&dev)));
        assert!(!is_own_page(&url("https://localhost:5177/"), Some(&dev)));
        assert!(!is_own_page(&url("https://example.com/"), Some(&dev)));
    }
}

#[cfg(test)]
mod own_origin_tests {
    use super::own_origin;

    #[test]
    fn development_uses_the_dev_server_and_a_release_tauri_localhost() {
        let dev = tauri::Url::parse("http://localhost:5270/").unwrap();
        assert_eq!(own_origin(Some(&dev)), "http://localhost:5270");
        assert_eq!(own_origin(None), "http://tauri.localhost");
    }
}

/// Whether the page should count as on screen: the window is shown and not minimised.
fn webview_on_screen(visible: bool, minimized: bool) -> bool {
    visible && !minimized
}

/*
 * A minimised ADE kept working as hard as a focused one (P1-C1): WebView2 is
 * not told the window went away, so the page stayed `visible` and Chromium
 * slowed neither its timers nor its drawing, and every poll in ADE that
 * pauses while hidden (`host/every.ts`) never did. The controller is told
 * instead: `put_IsVisible(false)` when the window is minimised or hidden, and
 * true again when it comes back, so the page gets `visibilitychange`.
 *
 * Minimising and restoring arrive as a move and a resize; the answer is read
 * from the window then, and the controller only touched when it changes.
 */
#[cfg(windows)]
fn follow_window_visibility(window: &tauri::WebviewWindow) {
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::Arc;

    // 0 unknown, 1 on screen, 2 off screen.
    let applied = Arc::new(AtomicU8::new(0));
    let target = window.clone();
    window.on_window_event(move |event| {
        if !matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Focused(_)
        ) {
            return;
        }
        let on_screen = webview_on_screen(
            target.is_visible().unwrap_or(true),
            target.is_minimized().unwrap_or(false),
        );
        let state = if on_screen { 1 } else { 2 };
        if applied.swap(state, Ordering::SeqCst) == state {
            return;
        }
        let result = target.with_webview(move |webview| unsafe {
            if let Err(error) = webview.controller().SetIsVisible(on_screen) {
                eprintln!("ADE: visibilità della webview non cambiata: {error}");
            }
        });
        if let Err(error) = result {
            eprintln!("ADE: webview non raggiunta per la visibilità: {error}");
        }
    });
}

#[cfg(windows)]
fn allow_own_microphone(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler, SetPermissionStateCompletedHandler};
    use windows_core::{Interface, HSTRING};

    #[cfg(debug_assertions)]
    let origin = own_origin(tauri::Manager::config(window).build.dev_url.as_ref());
    #[cfg(not(debug_assertions))]
    let origin = own_origin(None);
    let result = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        // A «Blocca» already saved in the profile is never asked again, so the
        // handler below would not hear of it: the saved answer is replaced.
        let profile = core.cast::<ICoreWebView2_13>().and_then(|core| core.Profile()).and_then(|p| p.cast::<ICoreWebView2Profile4>());
        if let Ok(profile) = profile {
            let done = SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(())));
            if let Err(error) = profile.SetPermissionState(
                COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                &HSTRING::from(origin.as_str()),
                COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                &done,
            ) {
                eprintln!("ADE: permesso del microfono non salvato per {origin}: {error}");
            }
        }
        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                return Ok(());
            }
            let mut uri = windows_core::PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            let same_origin = tauri::Url::parse(&uri).map(|u| u.origin().ascii_serialization() == origin).unwrap_or(false);
            if same_origin {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(error) = core.add_PermissionRequested(&handler, &mut token) {
            eprintln!("ADE: permesso del microfono non collegato: {error}");
        }
    });
    if let Err(error) = result {
        eprintln!("ADE: permesso del microfono non collegato: {error}");
    }
}

pub fn run() {
    #[cfg(unix)]
    import_login_path();

    let context = tauri::generate_context!();
    let builder = tauri::Builder::default();
    // The first plugin: a second ADE of this identity ends before anything of its own starts.
    let builder = if tray::single_instance(&context.config().identifier, std::env::var("ADE_SINGLE_INSTANCE").ok().as_deref()) {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
    } else {
        builder
    };
    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri::Emitter;
                    /*
                     * Both edges, named. A registered hotkey is taken by the
                     * OS before the webview sees a keydown, so for these
                     * chords this event is the only keyboard ADE has: the
                     * release is what lets push-to-talk let go, and the
                     * chord text is what lets the frontend tell the two
                     * voice features apart (see voice/global-shortcut.ts).
                     */
                    let state = match event.state() {
                        tauri_plugin_global_shortcut::ShortcutState::Pressed => "pressed",
                        tauri_plugin_global_shortcut::ShortcutState::Released => "released",
                    };
                    let _ = app.emit(
                        "nikcli-global-voice",
                        GlobalVoiceEvent { chord: shortcut.to_string(), state },
                    );
                })
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty::Registry::default())
        .manage(record::Recorder::default())
        .manage(frontend::DevServer::default())
        .manage(serve::Server::default())
        .manage(serve_proxy::Requests::default())
        .manage(shots::Watch::default())
        .manage(WriteRoots::default())
        .manage(secrets::SecretsLock::default())
        .manage(gateway::Gateway::default())
        .manage(stats::Stats::new())
        .manage(tts::Piper::default())
        .manage(tts::KokoroState::default())
        .manage(usage::UsageCache::default())
        .manage(std::sync::Arc::new(CloseManager::default()))
        .manage(tray::Tray::default())
        /*
         * The video panel's files.
         *
         * Confined to the same roots everything else writes inside: a scheme
         * that served an arbitrary path would let anything in the browser
         * pane's frame read the disk through a `<video>` tag.
         */
        .register_uri_scheme_protocol(media::SCHEME, |ctx, request| {
            use tauri::Manager;
            let state = ctx.app_handle().state::<WriteRoots>();
            let mut roots = match state.0.lock() {
                Ok(guard) => guard.clone(),
                Err(_) => Vec::new(),
            };
            // The recent takes' own files, one by one: their folder is not a root.
            roots.extend(ctx.app_handle().state::<record::Recorder>().playable());
            // The asking page's own origin, as the webview reports it: the
            // one origin that may read a take back into a canvas.
            let origin = ctx
                .app_handle()
                .get_webview_window(ctx.webview_label())
                .and_then(|webview| webview.url().ok())
                .map(|url| url.origin().ascii_serialization());
            let opened = state.1.lock().map(|guard| guard.clone()).unwrap_or_default();
            media::respond(&roots, &opened, &request, origin.as_deref())
        })
        .setup(|app| {
            // Before the window, not after: a webview pointed at a port that
            // is not listening yet shows its own error page and stays on it.
            frontend::ensure(app.handle());
            // Reports nobody came back for, from sessions that are long gone.
            agent_link::sweep(app.handle());
            // `ade-msg` on disk before any session can look for it.
            mailbox::install(app.handle());
            // The bots' gateways the user left on; they read once the page listens.
            gateway::resume(app.handle());
            if let Err(error) = open_main_window(app.handle()) {
                eprintln!("ADE: impossibile aprire la finestra: {error}");
                return Err(Box::new(error));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ade_open_release,
            ade_open_external,
            browse::ade_browser_framing,
            browse::ade_open_in_browser,
            browse::ade_forget_site,
            browser_shot::browser_shot,
            vision::capture_window,
            vision::vision_allowed,
            update::ade_update_install,
            record::record_start,
            record::record_stop,
            record::record_state,
            record::record_write,
            allow_write_root,
            git_run,
            bot_delete,
            nikcli_bot,
            claude_agents,
            claude_version,
            read_dir,
            read_text_file,
            write_text_file,
            write_bytes,
            current_dir,
            home_dir,
            path_exists,
            stats::system_stats,
            usage::transcript_usage,
            mailbox::mailbox_take,
            tts::tts_piper_status,
            tts::tts_piper_install,
            tts::tts_piper_speak,
            tts::tts_piper_stop,
            tts::tts_piper_cancel,
            tts::tts_open_voice_source,
            tts::tts_local_status,
            tts::tts_local_install,
            tts::tts_local_speak,
            tts::tts_local_stop,
            tts::tts_local_delete,
            tts::tts_install_status,
            tts::tts_install_cancel,
            mailbox::mailbox_receipt,
            mailbox::mailbox_publish,
            mailbox::mailbox_result,
            mailbox::mailbox_result_reclaim,
            mailbox::mailbox_state,
            mailbox::mailbox_inbox_put,
            mailbox::mailbox_dir,
            mailbox::mailbox_inbox_read,
            agent_link::agent_activity_read,
            agent_link::agent_activity_read_many,
            agent_link::agent_link_read,
            design_sheet_path,
            agent_link::agent_link_clear,
            agent_link::agent_hook_read,
            agent_link::agent_hook_write,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_which,
            gateway::gateway_ready,
            gateway::gateway_status,
            gateway::gateway_set_token,
            gateway::gateway_clear_token,
            gateway::gateway_forget_bot,
            gateway::gateway_probe,
            gateway::gateway_set_enabled,
            gateway::gateway_send,
            gateway::gateway_edit,
            gateway::gateway_typing,
            gateway::gateway_pairing_list,
            gateway::gateway_pairing_approve,
            gateway::gateway_pairing_reject,
            gateway::gateway_pairing_revoke,
            gateway::gateway_pairing_open,
            gateway::gateway_slack_manifest,
            serve::nikcli_serve_start,
            serve::nikcli_serve_status,
            serve::nikcli_serve_stop,
            serve_proxy::nikcli_serve_fetch,
            serve_proxy::nikcli_serve_abort,
            chat_attachment_inside,
            shots::shots_dir,
            shots::shots_recent,
            shots::shots_watch,
            shots::shot_bytes,
            shots::shot_delete,
            project_bytes::read_project_bytes,
            append::append_text_file,
            ade_window_minimize,
            ade_window_toggle_maximize,
            ade_window_close,
            ade_confirm_close,
            ade_cancel_close,
            ade_close_ack,
            tray::ade_tray_take,
            tray::ade_hide_to_tray,
            write_clipboard,
            secrets::secret_list,
            secrets::secret_save,
            secrets::secret_delete,
            secrets::secret_copy,
            secrets::secret_assigned,
            register_global_voice_shortcut,
            unregister_global_voice_shortcuts,
            session_locked,
            glass::ade_glass_status,
            glass::ade_window_set_glass,
        ])
        .build(context)
        .expect("error while running ADE")
        /*
         * Every process this window started is a child of it, so they die
         * with it.
         *
         * Without this they do not: they are detached processes holding
         * ports, and a few restarts of ADE leave several of them running
         * against the same workspace. `Exit` rather than `ExitRequested` so
         * it also covers the paths that do not go through a window close.
         */
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<gateway::Gateway>().shutdown();
                app.state::<serve::Server>().shutdown();
                app.state::<frontend::DevServer>().shutdown();
                app.state::<pty::Registry>().end_all();
                // The resident voice hosts, killed and not left to notice the
                // closed pipe: 219 MB of Kokoro and a Piper process do not wait for
                // the EOF of a stdin nobody writes to again.
                app.state::<tts::KokoroState>().stop();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the test temp dir (`TMP`), with a project and a secret beside it.
    fn attachment_fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("ade-attach-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("app");
        let secrets = base.join("segreti");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::write(project.join("src").join("a.ts"), "export {}").unwrap();
        std::fs::write(secrets.join("id_ed25519"), "CHIAVE-FINTA").unwrap();
        std::fs::create_dir_all(base.join("app-backup")).unwrap();
        std::fs::write(base.join("app-backup").join("x.ts"), "x").unwrap();
        (base, project, secrets)
    }

    #[test]
    fn an_attachment_is_a_real_file_of_the_project_and_nothing_else() {
        let (base, project, _secrets) = attachment_fixture("real");
        let inside = |path: PathBuf| attachment_inside(&project, &path);
        assert!(inside(project.join("src").join("a.ts")).is_ok());
        // Climbing out, a sibling with the same prefix, the folder itself, a folder, a missing file.
        assert_eq!(inside(project.join("src").join("..").join("..").join("segreti").join("id_ed25519")), Err("outside"));
        assert_eq!(inside(base.join("app-backup").join("x.ts")), Err("outside"));
        assert_eq!(inside(project.clone()), Err("outside"));
        assert_eq!(inside(project.join("src")), Err("notFile"));
        assert_eq!(inside(project.join("src").join("manca.ts")), Err("notFile"));
        assert_eq!(attachment_inside(&project, Path::new("src/a.ts")), Err("outside"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_dotenv_file_is_never_attached_whatever_it_is_called() {
        let (base, project, _secrets) = attachment_fixture("env");
        for name in [".env", ".env.local", ".ENV.production", ".env.example"] {
            std::fs::write(project.join(name), "API_KEY=finta").unwrap();
            assert_eq!(attachment_inside(&project, &project.join(name)), Err("env"), "{name}");
        }
        std::fs::write(project.join("env.ts"), "x").unwrap();
        assert!(attachment_inside(&project, &project.join("env.ts")).is_ok());
        // A link with another name, aimed at .env inside the project: refused by what it resolves to.
        let link = project.join("docs");
        #[cfg(windows)]
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(project.join("src")).output().map(|o| o.status.success());
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(project.join("src"), &link).map(|_| true);
        std::fs::write(project.join("src").join(".env"), "API_KEY=finta").unwrap();
        if matches!(made, Ok(true)) {
            assert_eq!(attachment_inside(&project, &link.join(".env")), Err("env"));
        }
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_in_the_project_aimed_outside_is_refused() {
        let (base, project, secrets) = attachment_fixture("junction");
        let link = project.join("docs");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&secrets)
            .output()
            .unwrap();
        assert!(made.status.success(), "mklink /J: {}", String::from_utf8_lossy(&made.stderr));
        assert_eq!(attachment_inside(&project, &link.join("id_ed25519")), Err("outside"));
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_link_in_the_project_aimed_outside_is_refused() {
        let (base, project, secrets) = attachment_fixture("link");
        let link = project.join("note.txt");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(secrets.join("id_ed25519"), &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(secrets.join("id_ed25519"), &link);
        match made {
            Ok(()) => assert_eq!(attachment_inside(&project, &link), Err("outside")),
            // Windows without Developer Mode cannot make a symlink: the junction test covers the case.
            Err(error) => eprintln!("symlink non creato, caso saltato: {error}"),
        }
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    fn sleeper() -> std::process::Command {
        let mut command = std::process::Command::new("powershell");
        command.args(["-NoProfile", "-Command", "Start-Sleep 30"]);
        command
    }

    #[cfg(unix)]
    fn sleeper() -> std::process::Command {
        let mut command = std::process::Command::new("sleep");
        command.arg("30");
        command
    }

    #[test]
    fn an_agents_listing_that_never_answers_is_stopped_on_time() {
        use std::time::{Duration, Instant};

        let started = Instant::now();
        let problem = list_claude_agents(sleeper(), Duration::from_millis(300)).expect_err("must time out");
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
        assert!(problem.starts_with("claude non ha risposto"), "{problem}");
    }

    #[test]
    fn a_version_that_never_answers_is_none_and_leaves_no_child() {
        use std::process::Stdio;
        use std::time::{Duration, Instant};

        let mut child = sleeper()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("sleeper starts");
        let started = Instant::now();
        assert_eq!(first_line_within(&mut child, Duration::from_secs(5)), None);
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        assert!(child.try_wait().expect("handle still valid").is_some(), "child still running");
    }

    /**
     * The markers, on the bytes, with nothing Unix about them.
     *
     * `login_shell_path` is `cfg(unix)` and this is not, so what is tested here
     * runs on this machine: the arithmetic on the offsets is what goes wrong, and
     * the first version of it added `start` twice, which put `out[start..end]` out
     * of range on the most ordinary output a login shell produces. On macOS that
     * is the first line of `run()`.
     */
    #[test]
    fn l_uscita_piu_semplice_da_il_path() {
        let out = b"__ADE_PATH__/usr/local/bin:/usr/bin__ADE_END__";
        assert_eq!(path_between_markers(out).as_deref(), Some("/usr/local/bin:/usr/bin"));
    }

    #[test]
    fn il_rumore_del_profilo_prima_dei_marcatori_non_conta() {
        // Un profilo di login stampa, e quello che stampa puo' contenere un
        // marcatore: l'ultimo __ADE_PATH__ e' il nostro, e il primo __ADE_END__
        // dopo di quello chiude il nostro e non quello del rumore.
        let out = b"Last login: Tue\n__ADE_PATH__/rumore__ADE_END__\n__ADE_PATH__/opt/bin__ADE_END__\n";
        assert_eq!(path_between_markers(out).as_deref(), Some("/opt/bin"));
    }

    #[test]
    fn due_marcatori_e_niente_fine_non_da_un_path() {
        // Il caso in cui la shell e' stata uccisa prima di arrivare in fondo: la
        // parte che c'e' non e' un PATH, quindi nessun PATH.
        let out = b"__ADE_PATH__/usr/local/bin";
        assert_eq!(path_between_markers(out), None);
        // E senza il marcatore di inizio non c'e' niente da cercare.
        assert_eq!(path_between_markers(b"__ADE_END__/usr/bin"), None);
        // E un PATH vuotofra i due marcatori non e' un PATH.
        assert_eq!(path_between_markers(b"__ADE_PATH____ADE_END__"), None);
    }

    /**
     * The reader that misbehaves, and the function that has to survive it.
     *
     * These call the function callers use, with the reader as a parameter: a line
     * handed over in pieces, and one that never finishes. The first is a
     * `recv_timeout` that returns only the first chunk — a line the pipe split
     * came back half a line. The second is a reader still blocked when the child
     * is gone, which a join waits for for ever.
     */
    #[test]
    fn una_riga_spezzata_in_piu_read_e_una_riga() {
        use std::io::Read;
        use std::time::Duration;

        /// Says one thing at a time, however much the caller asked for, and then
        /// the end of the stream: a reader that hands out a fixed sequence and
        /// finishes, which is what a pipe that split one line looks like.
        struct Trickle {
            pieces: Vec<&'static [u8]>,
            at: usize,
        }
        impl Read for Trickle {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let Some(piece) = self.pieces.get(self.at) else {
                    return Ok(0);
                };
                self.at += 1;
                let take = piece.len().min(buffer.len());
                buffer[..take].copy_from_slice(&piece[..take]);
                Ok(take)
            }
        }

        let line = first_line_from(
            Box::new(Trickle {
                pieces: vec![b"__ADE_PATH__/usr/lo", b"cal/bin:/opt/hom", b"ebrew/bin__ADE_END__"],
                at: 0,
            }),
            Duration::from_secs(2),
        );
        // Non la prima meta' e non i primi 1024 byte: la riga intera, che e'
        // quello che il marcatore promette.
        assert_eq!(line.as_deref(), Some("__ADE_PATH__/usr/local/bin:/opt/homebrew/bin__ADE_END__"));
    }

    #[test]
    fn un_lettore_che_non_finisce_mai_non_allunga_la_scadenza() {
        use std::io::Read;
        use std::time::{Duration, Instant};

        /// A `Read` that never returns, which is what a pipe held open by something
        /// that is not this process looks like from here.
        struct Never;
        impl Read for Never {
            fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_secs(60));
                Ok(0)
            }
        }

        let started = Instant::now();
        // One second allowed, half a second tolerated: with no join, the function
        // returns when the time is up and not when the reader is ready. On the
        // old code it did not return at all.
        let answer = first_line_from(Box::new(Never), Duration::from_secs(1));
        let took = started.elapsed();
        assert!(answer.is_none(), "un lettore bloccato non è una risposta");
        assert!(took < Duration::from_secs(2), "la scadenza non vale: {took:?}");
    }

    #[test]
    fn un_lettore_che_tace_dopo_una_riga_non_fa_aspettare_oltre_il_tempo() {
        use std::io::Read;
        use std::time::{Duration, Instant};

        /// Says one line and then goes quiet without ending: the reader whose pipe
        /// somebody else is holding, which is the case the deadline exists for.
        struct ThenSilence {
            said: bool,
        }
        impl Read for ThenSilence {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.said {
                    // Silent, not finished: this is the difference that was being
                    // papered over by a reader that just ended the stream.
                    std::thread::sleep(Duration::from_secs(60));
                    return Ok(0);
                }
                self.said = true;
                let line = b"/usr/local/bin\n";
                buffer[..line.len()].copy_from_slice(line);
                Ok(line.len())
            }
        }

        // Four hundred milliseconds allowed, and three seconds tolerated: the
        // reader is never going to say anything else, so the answer is the line
        // that already arrived, and the wait ends when the allowance does rather
        // than when the pipe does.
        let started = Instant::now();
        let answer = first_line_from(Box::new(ThenSilence { said: false }), Duration::from_millis(400));
        let took = started.elapsed();
        assert_eq!(answer.as_deref(), Some("/usr/local/bin"), "la riga arrivata e' la risposta");
        assert!(took < Duration::from_secs(3), "ha aspettato il lettore: {took:?}");
    }

    #[test]
    fn bounded_nikcli_output_kills_and_reaps_a_command_that_does_not_finish() {
        let started = Instant::now();
        let error =
            run_bounded_output(sleeper(), Duration::from_millis(100), "nikcli").expect_err("must time out");
        assert!(error.contains("ed è stato fermato"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "took {:?}",
            started.elapsed()
        );
    }

    #[cfg(windows)]
    #[test]
    fn bounded_nikcli_output_does_not_wait_for_a_grandchild_holding_stdout() {
        let temp = TempDir::new("grandchild-output");
        let release = temp.join("release.txt");
        let marker = temp.join("survived.txt");
        let grandchild = format!(
            "for ($i = 0; $i -lt 50; $i++) {{ if (Test-Path -LiteralPath \"{}\") {{ break }}; Start-Sleep -Milliseconds 100 }}; Set-Content -LiteralPath \"{}\" -Value alive",
            release.display(),
            marker.display()
        );
        let script = format!(
            "$p = Start-Process powershell -NoNewWindow -ArgumentList @('-NoProfile','-Command','{grandchild}') -PassThru; 'root-output'; exit 0"
        );
        let mut command = std::process::Command::new("powershell");
        command.args(["-NoProfile", "-Command", &script]);
        let started = Instant::now();
        let output =
            run_bounded_output(command, Duration::from_secs(5), "nikcli").expect("root output must survive");
        let returned = started.elapsed();
        assert_eq!(output.code, Some(0));
        assert!(output.stdout.contains("root-output"), "{}", output.stdout);
        assert!(returned < Duration::from_secs(3), "took {:?}", returned);
        std::fs::write(&release, b"release").expect("release marker");
        std::thread::sleep(Duration::from_secs(2));
        assert!(!marker.exists(), "grandchild survived the job");
    }

    #[cfg(unix)]
    #[test]
    fn the_login_path_comes_first_and_nothing_repeats() {
        let known = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/bin")];
        let merged = merge_path(Some("/Users/a/.bun/bin:/usr/bin"), "/usr/bin:/bin", &known);
        assert_eq!(merged, "/Users/a/.bun/bin:/usr/bin:/bin:/opt/homebrew/bin");
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_did_not_answer_still_gets_the_known_dirs() {
        let known = vec![PathBuf::from("/opt/homebrew/bin")];
        assert_eq!(merge_path(None, "/usr/bin:/bin", &known), "/usr/bin:/bin:/opt/homebrew/bin");
    }

    /// A throwaway directory that cleans itself up, so these tests need no
    /// fixture crate and leave nothing behind when one of them fails.
    struct TempDir(PathBuf);

    impl TempDir {
        /*
         * Under the crate's own target directory rather than %TEMP%. On the
         * machine this was written on, %TEMP% answers a create with "Accesso
         * negato" (os error 5) for anything not launched from the user's own
         * folder tree, and eight tests failing on that says nothing about the
         * code. `target/` is writable wherever cargo can build at all, and
         * `cargo clean` takes these with it.
         */
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("test-tmp")
                .join(format!("{tag}-{nanos}"));
            std::fs::create_dir_all(&path).expect("temp dir");
            TempDir(path)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        /// This directory registered as the one writable root, canonicalised
        /// the same way `allow_write_root` would do it.
        fn roots(&self) -> WriteRoots {
            let roots = WriteRoots::default();
            roots
                .0
                .lock()
                .unwrap()
                .push(self.0.canonicalize().expect("canonical temp dir"));
            roots
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_path_inside_a_root_is_accepted_even_when_it_does_not_exist_yet() {
        let dir = TempDir::new("inside");
        let roots = dir.roots();
        let target = dir.join("nested").join("new-file.txt");

        let resolved = within_roots(&roots, &target.to_string_lossy())
            .expect("a new file under the project is writable");
        assert!(resolved.ends_with("new-file.txt"));
    }

    #[test]
    fn a_path_outside_every_root_is_refused() {
        let dir = TempDir::new("outside");
        let other = TempDir::new("elsewhere");
        let roots = dir.roots();

        let error = within_roots(&roots, &other.join("stolen.txt").to_string_lossy())
            .expect_err("a file outside the project is not writable");
        assert!(error.contains("fuori dal progetto"), "{error}");
    }

    #[test]
    fn climbing_out_with_dot_dot_is_refused() {
        let dir = TempDir::new("climb");
        let roots = dir.roots();
        // `..` below the deepest existing directory is never resolved, because
        // resolving it is how a path escapes a prefix check.
        let sneaky = dir.join("missing").join("..").join("..").join("evil.txt");

        assert!(within_roots(&roots, &sneaky.to_string_lossy()).is_err());
    }

    #[test]
    fn a_sibling_root_with_a_shared_prefix_is_not_covered() {
        let dir = TempDir::new("app");
        let roots = dir.roots();
        // `<dir>-backup` shares every character of `<dir>` but not a component,
        // which is the case a string prefix check gets wrong.
        let sibling = PathBuf::from(format!("{}-backup", dir.0.to_string_lossy()));
        std::fs::create_dir_all(&sibling).expect("sibling dir");

        let result = within_roots(&roots, &sibling.join("f.txt").to_string_lossy());
        let _ = std::fs::remove_dir_all(&sibling);
        assert!(result.is_err(), "a sibling directory is not inside the root");
    }

    #[test]
    fn nothing_is_writable_before_a_project_is_opened() {
        let dir = TempDir::new("noroot");
        let roots = WriteRoots::default();

        let error = within_roots(&roots, &dir.join("f.txt").to_string_lossy())
            .expect_err("an empty root set grants nothing");
        assert!(error.contains("nessun progetto aperto"), "{error}");
    }

    #[test]
    fn git_config_and_hooks_are_not_writable_inside_a_project() {
        let dir = TempDir::new("githooks");
        let roots = dir.roots();
        for bad in [
            dir.join(".git").join("hooks").join("pre-commit"),
            dir.join(".git").join("config"),
            dir.join(".git").join("worktrees").join("w").join("config.worktree"),
            // Review area 1, MEDIO 3: where git also reads a config or a hook from.
            dir.join(".git").join("worktrees").join("w").join("commondir"),
            dir.join(".git").join("modules").join("sub").join("config"),
            dir.join(".git").join("modules").join("sub").join("hooks").join("pre-commit"),
            dir.join(".git").join("modules").join("a").join("modules").join("b").join("config"),
            dir.join("sub").join(".git"),
        ] {
            let error = within_roots(&roots, &bad.to_string_lossy()).expect_err("refused");
            assert!(error.contains("git"), "{error}");
        }
        assert!(within_roots(&roots, &dir.join(".git").join("info").join("exclude").to_string_lossy()).is_ok());
        assert!(within_roots(&roots, &dir.join("src").join("config").to_string_lossy()).is_ok());
    }

    #[test]
    fn a_root_that_is_the_whole_disk_or_home_is_refused() {
        let home = dirs::home_dir().expect("home");
        let home = home.canonicalize().expect("canonical home");
        assert!(too_broad_root(&home, Some(&home)).is_some());
        if let Some(parent) = home.parent() {
            assert!(too_broad_root(parent, Some(&home)).is_some());
        }
        let mut root = home.clone();
        while let Some(parent) = root.parent() {
            root = parent.to_path_buf();
        }
        assert!(too_broad_root(&root, Some(&home)).is_some());
        assert!(too_broad_root(&home.join(".ssh"), Some(&home)).is_some());

        let project = TempDir::new("project");
        let project_path = project.0.canonicalize().expect("canonical");
        assert!(too_broad_root(&project_path, Some(&home)).is_none());
    }

    #[test]
    fn only_an_agent_file_counts_as_a_bot() {
        let config = Path::new("C:\\cfg\\nikcli");
        assert!(is_bot_path(&config.join("agent").join("reviewer.md"), config));
        assert!(is_bot_path(&config.join("agents").join("team").join("senior.md"), config));
        assert!(!is_bot_path(&config.join("nikcli.json"), config));
        assert!(!is_bot_path(&config.join("plugin").join("x.md"), config));
        assert!(!is_bot_path(&config.join("agent").join("run.js"), config));
        assert!(!is_bot_path(&config.join("agent"), config));
        assert!(!is_bot_path(Path::new("C:\\elsewhere\\agent\\x.md"), config));
    }

    #[test]
    fn nikcli_runs_only_the_commands_on_the_list() {
        let dir = TempDir::new("bots");
        let roots = dir.roots();
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let home = dir.join(".nikcli").to_string_lossy().into_owned();

        assert!(check_nikcli_args(&roots, &args(&["--version"])).is_ok());
        assert!(check_nikcli_args(&roots, &args(&["models"])).is_ok());
        assert!(check_nikcli_args(&roots, &args(&["models", "opencode", "--verbose"])).is_ok());
        assert!(check_nikcli_args(&roots, &args(&["models", "openrouter", "--verbose"])).is_ok());
        assert!(check_nikcli_args(&roots, &args(&["models", "nikcli-inference", "--verbose"])).is_ok());
        assert!(check_nikcli_args(&roots, &args(&["models", "--verbose"])).is_ok());
        assert!(check_nikcli_args(
            &roots,
            &args(&["agent", "create", "--path", &home, "--description", "a", "--mode", "primary", "--tools", ""])
        )
        .is_ok());
        for bad in [
            &["run", "rm -rf"][..],
            &["models", "--x"],
            &["models", "--help", "--verbose"],
            &["models", "-x", "--verbose"],
            &["models", "", "--verbose"],
            &["models", "open router", "--verbose"],
            &["models", "..\\x", "--verbose"],
            &["models", "a/b", "--verbose"],
            &["models", "opencode", "--refresh"],
            &["models", "opencode"],
            &["models", "opencode", "--verbose", "--x"],
            &["models", "--verbose", "--x"],
            &["models", "--refresh"],
            &["--version", "--x"],
            &["--help"],
            &["agent", "create", "--description", "a"],
            &["agent", "create", "--path", &home, "--path", &home],
            &["agent", "create", "--path", &home, "--exec", "calc"],
            &["agent", "create", "--path", "C:\\Windows\\Temp"],
            &["agent", "create", "--path"],
        ] {
            assert!(check_nikcli_args(&roots, &args(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn nikcli_commands_have_command_specific_timeouts() {
        let args = |list: &[&str]| list.iter().map(|arg| (*arg).to_string()).collect::<Vec<_>>();
        assert_eq!(nikcli_timeout(&args(&["--version"])), Duration::from_secs(15));
        assert_eq!(nikcli_timeout(&args(&["models"])), Duration::from_secs(30));
        assert_eq!(nikcli_timeout(&args(&["agent", "create"])), Duration::from_secs(120));
    }

    #[test]
    fn git_options_that_run_or_write_are_refused() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        for bad in [
            &["rebase", "-x", "calc", "main"][..],
            &["rebase", "-ix", "calc"],
            &["rebase", "-xcalc"],
            &["rebase", "--exec=calc"],
            &["diff", "--output=C:/evil.txt"],
            &["log", "--output", "x"],
            &["diff", "--ext-diff"],
            &["status", "-c", "core.fsmonitor=calc"],
            &["config", "core.pager", "calc"],
        ] {
            assert!(check_git_args(&args(bad)).is_err(), "{bad:?}");
        }
        for good in [
            &["cherry-pick", "-x", "abc"][..],
            &["rebase", "main"],
            &["diff", "--cached", "HEAD"],
            &["log", "--", "--output=x"],
        ] {
            assert!(check_git_args(&args(good)).is_ok(), "{good:?}");
        }
    }

    /// Review area 1, MEDIO 2: `worktree add` and `GIT_INDEX_FILE` wrote wherever they were pointed.
    #[test]
    fn git_writes_only_inside_a_project_or_beside_it_for_worktrees() {
        let project = TempDir::new("gitdest");
        let roots = project.roots();
        let root = project.0.canonicalize().expect("canonical");
        let cwd = root.to_string_lossy().to_string();
        let none = std::collections::HashMap::new();
        let check = |list: &[&str], env: &std::collections::HashMap<String, String>| {
            let args = list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
            check_git_destinations(&roots, &args, Some(&cwd), env)
        };
        let beside = format!("{}-worktrees", root.to_string_lossy());
        let elsewhere = root.parent().expect("parent").join("Documents").join("WindowsPowerShell");
        let elsewhere = elsewhere.to_string_lossy();

        // ADE's own: a branch, in the folder beside the project.
        assert_eq!(check(&["worktree", "add", "-b", "ade/x", &format!("{beside}/x"), "main"], &none), Ok(()));
        assert_eq!(check(&["worktree", "add", "inside"], &none), Ok(()));
        // Anywhere else, refused, however it is spelled.
        for bad in [
            vec!["worktree", "add", &elsewhere],
            vec!["worktree", "add", "-b", "ade/x", &elsewhere, "main"],
            vec!["worktree", "add", "../elsewhere"],
            vec!["worktree", "move", "inside", &elsewhere],
            vec!["worktree", "add", ".git/hooks"],
        ] {
            assert!(check(&bad, &none).is_err(), "{bad:?}");
        }
        // The review's index: in the repository's .git, as `rev-parse --git-path` names it.
        let index = |value: &str| std::collections::HashMap::from([("GIT_INDEX_FILE".to_string(), value.to_string())]);
        assert_eq!(check(&["add", "-A"], &index(".git/ade-review-index")), Ok(()));
        // A project that is a worktree: its git dir is the main repository's.
        let main = root.parent().expect("parent").join("main").join(".git").join("worktrees").join("w");
        assert_eq!(check(&["add", "-A"], &index(&main.join("ade-review-index").to_string_lossy())), Ok(()));
        assert!(check(&["add", "-A"], &index(&format!("{elsewhere}/profile.ps1"))).is_err());
        assert!(check(&["add", "-A"], &index(&format!("{elsewhere}/ade-review-index"))).is_err());
    }

    #[test]
    fn a_multibyte_character_split_by_the_cap_is_still_text() {
        let dir = TempDir::new("utf8");
        let path = dir.join("accents.txt");
        // "è" is two bytes; cutting at 5 lands inside the third one.
        std::fs::write(&path, "aaaaèèè").expect("write");

        let read = read_text(&path.to_string_lossy(), 5)
            .expect("a cut accent is not a binary file");
        assert_eq!(read.text, "aaaa");
        assert!(read.truncated);
        assert_eq!(read.bytes, 10);
    }

    #[test]
    fn a_real_binary_is_still_refused() {
        let dir = TempDir::new("binary");
        let path = dir.join("blob.bin");
        std::fs::write(&path, [0xff, 0xfe, 0x00, 0x01, 0x02]).expect("write");

        let error = read_text(&path.to_string_lossy(), 1024)
            .expect_err("invalid bytes are not a truncated character");
        assert_eq!(error, "file binario, 5 byte");
    }

    #[test]
    fn a_file_under_the_cap_is_not_reported_as_truncated() {
        let dir = TempDir::new("small");
        let path = dir.join("small.txt");
        std::fs::write(&path, "ciao").expect("write");

        let read = read_text(&path.to_string_lossy(), 1024).expect("read");
        assert_eq!(read.text, "ciao");
        assert!(!read.truncated);
        assert_eq!(read.bytes, 4);
    }

    #[test]
    fn frame_src_csp_allows_ade_media() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("app.security.csp");
        let frame_src = csp
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("frame-src"))
            .expect("frame-src directive in CSP");
        let tokens: Vec<&str> = frame_src.split_whitespace().collect();
        assert!(
            tokens.contains(&"ade-media:"),
            "frame-src must contain ade-media:, found: {frame_src}"
        );
    }

    #[test]
    fn on_navigation_is_conditioned_to_windows() {
        let source = include_str!("lib.rs");
        let test_fn_marker = "fn on_navigation_is_conditioned_to_windows()";
        let test_start = source.find(test_fn_marker).expect("test function found");
        let non_test_source = &source[..test_start];

        let nav_call = ".on_navigation(";
        let count = non_test_source.matches(nav_call).count();
        assert_eq!(count, 1, "expected exactly one on_navigation call in lib.rs");

        let nav_idx = non_test_source.find(nav_call).expect("on_navigation call found");
        let before_nav = &non_test_source[..nav_idx];
        let last_cfg = before_nav
            .rfind("#[cfg(windows)]")
            .expect("on_navigation must be preceded by #[cfg(windows)]");
        let between = &before_nav[last_cfg..nav_idx];
        assert!(
            !between.contains("fn ") && !between.contains("struct ") && !between.contains("enum "),
            "#[cfg(windows)] must guard the on_navigation call directly"
        );
    }

    #[test]
    fn safety_timeout_forces_close_when_frontend_does_not_respond() {
        use std::time::Duration;
        let manager = CloseManager::new(Duration::from_millis(50));
        let action = manager.on_close_requested();
        let CloseAction::PreventAndAsk(req_id) = action else {
            panic!("expected PreventAndAsk, got {action:?}");
        };
        std::thread::sleep(Duration::from_millis(60));
        assert!(manager.on_timeout(req_id));
        assert_eq!(manager.on_close_requested(), CloseAction::AllowClose);
    }

    #[test]
    fn ack_disarms_safety_timeout() {
        use std::time::Duration;
        let manager = CloseManager::new(Duration::from_millis(50));
        let action = manager.on_close_requested();
        let CloseAction::PreventAndAsk(req_id) = action else {
            panic!("expected PreventAndAsk, got {action:?}");
        };
        assert!(manager.ack(req_id));
        std::thread::sleep(Duration::from_millis(60));
        assert!(!manager.on_timeout(req_id));
    }

    #[test]
    fn cancel_disarms_safety_timeout_and_leaves_window_open() {
        use std::time::Duration;
        let manager = CloseManager::new(Duration::from_millis(50));
        let action = manager.on_close_requested();
        let CloseAction::PreventAndAsk(req_id) = action else {
            panic!("expected PreventAndAsk, got {action:?}");
        };
        assert!(manager.cancel(Some(req_id)));
        std::thread::sleep(Duration::from_millis(60));
        assert!(!manager.on_timeout(req_id));
        let action2 = manager.on_close_requested();
        assert!(matches!(action2, CloseAction::PreventAndAsk(_)));
    }

    #[test]
    fn confirm_allows_immediate_close() {
        use std::time::Duration;
        let manager = CloseManager::new(Duration::from_millis(50));
        let action = manager.on_close_requested();
        let CloseAction::PreventAndAsk(req_id) = action else {
            panic!("expected PreventAndAsk, got {action:?}");
        };
        assert!(manager.confirm(Some(req_id)));
        assert_eq!(manager.on_close_requested(), CloseAction::AllowClose);
    }
}

/// The voice chords as `toTauriChord` writes them, parsed by the real crate:
/// the same table as `src/voice/any-chord.test.ts`, which checks that what the
/// crate prints back when the hotkey fires is recognised by the page.
#[cfg(all(test, not(target_os = "macos")))]
mod voice_chord_tests {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;

    #[test]
    fn every_kind_of_key_the_recorder_accepts_parses_and_prints_back() {
        for (registered, reported) in [
            ("CommandOrControl+Shift+J", "shift+control+KeyJ"),
            ("CommandOrControl+Shift+1", "shift+control+Digit1"),
            ("CommandOrControl+Alt+NUMPAD1", "control+alt+Numpad1"),
            ("CommandOrControl+Shift+F5", "shift+control+F5"),
            ("CommandOrControl+Shift+ARROWUP", "shift+control+ArrowUp"),
            ("CommandOrControl+Shift+SPACE", "shift+control+Space"),
            ("CommandOrControl+Shift+PAGEUP", "shift+control+PageUp"),
        ] {
            let shortcut = Shortcut::from_str(registered).unwrap_or_else(|e| panic!("{registered}: {e}"));
            assert_eq!(shortcut.to_string(), reported, "{registered}");
        }
    }

    #[test]
    fn the_characters_the_recorder_used_to_store_cannot_be_registered() {
        for character in ["CommandOrControl+Shift+!", "CommandOrControl+Shift+Ò", "CommandOrControl+Alt+€"] {
            assert!(Shortcut::from_str(character).is_err(), "{character}");
        }
    }
}

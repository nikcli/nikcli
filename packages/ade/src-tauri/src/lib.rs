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
mod append;
mod browse;
mod browser_shot;
mod frontend;
mod media;
mod project_bytes;
mod pty;
mod record;
mod secrets;
mod serve;
mod shots;
mod mailbox;
mod stats;
mod tts;
mod usage;
mod vision;
mod update;

use serde::Serialize;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

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
#[derive(Default)]
pub struct WriteRoots(Mutex<Vec<PathBuf>>);

/*
 * Every command in this file is `async`, and none of them awaits anything.
 *
 * That reads like a mistake and is not: a synchronous `#[tauri::command]` is
 * dispatched on the thread that owns the window, so a `read_dir` on a cold
 * network share or a `git status` on a large repository stops the window from
 * drawing until it finishes. Declaring them `async` moves them onto Tauri's
 * async runtime, which is all these need — they are bounded pieces of work,
 * unlike `nikcli_serve_start`, which waits up to forty-five seconds and goes
 * further onto a blocking worker. `pty.rs` reached the same conclusion first
 * and documents it on `pty_write`.
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
    Ok(())
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
        let rest = &names[i + 1..];
        // `.git/worktrees/<name>/config.worktree` is the same file for a worktree.
        let rest = match rest {
            [w, _, tail @ ..] if w == "worktrees" => tail,
            other => other,
        };
        matches!(rest.first().map(String::as_str), Some("hooks"))
            || matches!(rest, [f] if f == "config" || f == "config.worktree")
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
        Err(_) => return Err("file binario".to_string()),
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
///   nikcli models
///   nikcli agent create --path <dir> --description <t> --mode <m> --tools <list> [--model <id>]
///
/// Each option once, each with a value, and `--path` a configuration root the
/// agent file is then written under.
fn check_nikcli_args(roots: &WriteRoots, args: &[String]) -> Result<(), String> {
    match args {
        [only] if only == "models" => Ok(()),
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
    command.args(&args).stdin(std::process::Stdio::null());
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().map_err(|e| format!("nikcli non eseguibile: {e}"))?;
    Ok(ShellOutput {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
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
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<ShellOutput, String> {
    check_git_args(&args)?;

    let mut command = std::process::Command::new("git");
    command.args(&args);
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }
    for (key, value) in env.unwrap_or_default() {
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
    let mut stdout = child.stdout.take()?;
    // Read on a thread so a chatty profile cannot fill the pipe and stall the
    // shell, and so the wait below can give up on one that never exits.
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
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
    let out = reader.join().ok()?;
    let start = out.rfind("__ADE_PATH__")? + "__ADE_PATH__".len();
    let end = out[start..].find("__ADE_END__")? + start;
    let path = out[start..end].trim();
    (!path.is_empty()).then(|| path.to_string())
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
    let mut title = app.config().product_name.clone().unwrap_or_else(|| "ADE".into());
    // `bun run test:app` names the worktree and branch, so with several test
    // instances open the taskbar says which is which.
    if is_test_build(app) {
        if let Ok(label) = std::env::var("ADE_TEST_LABEL") {
            if !label.trim().is_empty() {
                title = format!("{title} · {}", label.trim());
            }
        }
    }
    let builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .title(title)
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .resizable(true)
        .disable_drag_drop_handler()
        // In every frame: Tauri's IPC made inert, and the inspector bridge in
        // a browser pane's frame. See `src/browser/frame-script.ts`.
        .initialization_script_for_all_frames(include_str!("../scripts/browser-frame.js"))
        .center();

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

    #[cfg(windows)]
    allow_own_microphone(&window);

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
fn own_origin(dev_url: Option<&tauri::Url>) -> String {
    dev_url
        .map(|url| url.origin().ascii_serialization())
        .filter(|origin| origin != "null")
        .unwrap_or_else(|| "http://tauri.localhost".to_string())
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

    tauri::Builder::default()
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
        .manage(shots::Watch::default())
        .manage(WriteRoots::default())
        .manage(secrets::SecretsLock::default())
        .manage(stats::Stats::new())
        .manage(tts::Piper::default())
        .manage(usage::UsageCache::default())
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
            media::respond(&roots, &request, origin.as_deref())
        })
        .setup(|app| {
            // Before the window, not after: a webview pointed at a port that
            // is not listening yet shows its own error page and stays on it.
            frontend::ensure(app.handle());
            // Reports nobody came back for, from sessions that are long gone.
            agent_link::sweep(app.handle());
            // `ade-msg` on disk before any session can look for it.
            mailbox::install(app.handle());
            if let Err(error) = open_main_window(app.handle()) {
                eprintln!("ADE: impossibile aprire la finestra: {error}");
                return Err(Box::new(error));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ade_open_release,
            browse::ade_browser_framing,
            browse::ade_open_in_browser,
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
            tts::tts_open_voice_source,
            mailbox::mailbox_receipt,
            mailbox::mailbox_publish,
            mailbox::mailbox_result,
            mailbox::mailbox_result_reclaim,
            mailbox::mailbox_state,
            mailbox::mailbox_inbox_put,
            mailbox::mailbox_dir,
            mailbox::mailbox_inbox_read,
            agent_link::agent_activity_read,
            agent_link::agent_link_read,
            agent_link::agent_link_clear,
            agent_link::agent_hook_read,
            agent_link::agent_hook_write,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_which,
            serve::nikcli_serve_start,
            serve::nikcli_serve_status,
            serve::nikcli_serve_stop,
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
            write_clipboard,
            secrets::secret_list,
            secrets::secret_save,
            secrets::secret_delete,
            secrets::secret_copy,
            secrets::secret_assigned,
            register_global_voice_shortcut,
            unregister_global_voice_shortcuts,
            session_locked,
        ])
        .build(tauri::generate_context!())
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
                app.state::<serve::Server>().shutdown();
                app.state::<frontend::DevServer>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn nikcli_runs_only_the_two_bot_commands() {
        let dir = TempDir::new("bots");
        let roots = dir.roots();
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let home = dir.join(".nikcli").to_string_lossy().into_owned();

        assert!(check_nikcli_args(&roots, &args(&["models"])).is_ok());
        assert!(check_nikcli_args(
            &roots,
            &args(&["agent", "create", "--path", &home, "--description", "a", "--mode", "primary", "--tools", ""])
        )
        .is_ok());
        for bad in [
            &["run", "rm -rf"][..],
            &["models", "--x"],
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
        assert_eq!(error, "file binario");
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
}

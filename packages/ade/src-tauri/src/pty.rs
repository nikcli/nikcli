/// Agent CLIs, run in a real terminal.
///
/// The shell plugin can already start a process and read its pipes, and for git
/// that is exactly right. It is wrong for an agent: every one of these CLIs asks
/// whether it is talking to a terminal, and when the answer is "a pipe" they all
/// change into something else. Claude Code switches itself into `--print`, waits
/// three seconds for piped input and exits 1; the others drop their prompt, or
/// their colours, or their permission questions. A session that cannot be typed
/// into is not a session, so ADE gives each one a pseudo-terminal instead.
///
/// The web side owns the terminal emulator and the session ids. This module owns
/// only the ConPTY (or the unix pty), one reader thread per session, and the
/// registry that lets `write`, `resize` and `kill` find their master again.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::{AppHandle, Emitter, Manager};

/// One live pseudo-terminal, kept only so later calls can reach it.
struct Session {
    /// Absent for a piped process (`pipe`), which has no terminal to resize.
    master: Option<Box<dyn MasterPty + Send>>,
    /*
     * Behind a lock of its own, so writing to one session never holds the lock
     * that every other session's spawn, resize and kill has to take. A write to
     * a pty blocks for as long as the child refuses to read its stdin, and a
     * suspended agent is an ordinary thing rather than a rare one.
     */
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Session>>);

#[derive(Clone, serde::Serialize)]
struct Chunk {
    id: String,
    /// Raw terminal output, escape sequences included: the emulator on the other
    /// side needs them, so nothing here tries to be helpful and strip them.
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct Exit {
    id: String,
    code: Option<i32>,
}

/*
 * What this window is allowed to start.
 *
 * `capabilities/default.json` allowlists the shell plugin and lib.rs calls that
 * allowlist the security model, but none of it reaches this far: a pty is opened
 * by the command below, not by the plugin, so without a list of its own
 * `pty_spawn` starts whatever it is handed. That matters because the caller is
 * not only ADE's own interface — anything running in the browser pane's frame
 * can invoke it, and "whatever it is handed" is then the whole machine.
 *
 * Bare names, matched before the PATH lookup adds a directory or an extension.
 * Keep in step with `src/session-new/agents.ts`, the catalogue the new-session
 * form offers: a name added there and not here cannot start.
 */
const ALLOWED_AGENTS: &[&str] = &[
    "claude", "codex", "opencode", "nikcli", "agy", "kimi", "prime", "pi", "ohmypi",
    "hermes",
];

/// Environment an agent must not inherit from whatever launched ADE.
///
/// Prefixes, matched from the start of the name: a session marker set by one
/// agent CLI is not something the next one should read, and the messaging
/// socket and token under `CLAUDE_CODE_` are credentials scoped to a session
/// that is not this one. `ADE_MAILBOX_ROOT` is `test:app`'s choice for one
/// ADE Test: a `native:dev` started from a session inside it would otherwise
/// share that mailbox.
const INHERITED_SESSION_MARKERS: &[&str] = &["CLAUDE_CODE_", "CLAUDECODE", "CLAUDE_PID", "ADE_MAILBOX_ROOT"];

/// Colour switches that describe the output of whatever launched ADE, not the
/// pty an agent is given.
///
/// Whole names, any case. A shell whose output goes to a pipe — an agent's
/// tool shell, a bench runner — sets these, and ADE inherits them. Claude Code
/// reads `NO_COLOR` without `FORCE_COLOR` as "no colour at all", so a session in
/// a pane that is a real 24-bit terminal came out white on black, logo included.
/// Without them each CLI decides from the terminal it is actually in.
const INHERITED_COLOUR_SWITCHES: &[&str] = &["NO_COLOR", "FORCE_COLOR", "NODE_DISABLE_COLORS"];

fn is_launcher_colour_switch(key: &str) -> bool {
    INHERITED_COLOUR_SWITCHES
        .iter()
        .any(|name| name.eq_ignore_ascii_case(key))
}

/*
 * How often a session's output reaches the window, and how much may wait.
 *
 * Roughly one animation frame. Below this the extra messages are redraws
 * nobody sees; above it a person typing feels the terminal lag behind their
 * keystrokes, which is the one thing a terminal may not do.
 */
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// A burst past this goes out immediately rather than waiting for the tick.
const MAX_PENDING: usize = 256 * 1024;

/**
 * The event a session's output arrives on.
 *
 * One topic per session rather than one shared `pty:data` that every pane
 * filters. With six sessions running, a shared topic meant every chunk woke
 * six listeners so that five of them could compare an id and return — per
 * chunk, per frame, on the thread that draws.
 */
pub fn data_topic(id: &str) -> String {
    format!("pty:data:{id}")
}

/// The shells a terminal pane may open. Named per platform because the list is
/// the point: `$SHELL` is attacker-controllable on a machine already lost, and
/// an arbitrary interpreter is exactly what the allowlist exists to refuse.
#[cfg(windows)]
const ALLOWED_SHELLS: &[&str] = &["cmd", "powershell", "pwsh"];
#[cfg(not(windows))]
const ALLOWED_SHELLS: &[&str] = &["sh", "bash", "zsh", "fish"];

/// The OpenSSH client, for remote Spaces. Its arguments go through `check_args`.
const ALLOWED_REMOTE: &[&str] = &["ssh"];

/// The switches a shell may be started with. Anything else is refused.
///
/// A shell name on the list is not enough: `cmd /c <anything>`,
/// `powershell -EncodedCommand <anything>` and `sh -c <anything>` run a command
/// without ever showing a prompt, and PowerShell also accepts any unambiguous
/// prefix of a parameter (`-enc`, `-comm`) and a bare positional as a command.
/// So shells get a short list of switches that only change how the prompt
/// behaves, compared whole and case-insensitively.
#[cfg(windows)]
const SHELL_SWITCHES: &[(&str, &[&str])] = &[
    ("cmd", &["/q", "/d", "/a", "/u"]),
    ("powershell", &["-nologo", "-noprofile", "-noexit", "-interactive"]),
    ("pwsh", &["-nologo", "-noprofile", "-noexit", "-interactive", "-login", "-l"]),
];
#[cfg(not(windows))]
const SHELL_SWITCHES: &[(&str, &[&str])] = &[
    ("sh", &["-l", "-i", "--login"]),
    ("bash", &["-l", "-i", "--login"]),
    ("zsh", &["-l", "-i", "--login"]),
    ("fish", &["-l", "-i", "--login"]),
];

/// The only CLI that may run without a terminal: see `pipe` in `pty_spawn`.
fn is_pipe_command(command: &str) -> bool {
    command_stem(command).eq_ignore_ascii_case("claude")
}

/// What a started process gives back, whichever way it was started.
struct Spawned {
    child: Box<dyn Child + Send + Sync>,
    master: Option<Box<dyn MasterPty + Send>>,
    reader: Result<Box<dyn Read + Send>, String>,
    writer: Result<Box<dyn Write + Send>, String>,
    errors: Option<Box<dyn Read + Send>>,
}

fn spawn_in_pty(builder: CommandBuilder, rows: u16, cols: u16) -> Result<Spawned, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty non creata: {e}"))?;
    let child = pair.slave.spawn_command(builder).map_err(|e| e.to_string())?;
    // The slave handle has done its job; holding it open would keep the pty
    // alive after the child dies and the reader would never see EOF.
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string());
    let writer = pair.master.take_writer().map_err(|e| e.to_string());
    Ok(Spawned {
        child,
        master: Some(pair.master),
        reader,
        writer,
        errors: None,
    })
}

/// The same command, environment and folder the terminal would have had, on pipes.
fn spawn_piped(program: &str, builder: &CommandBuilder) -> Result<Spawned, String> {
    use std::process::Stdio;
    let mut command = std::process::Command::new(program);
    command.args(builder.get_argv().iter().skip(1));
    if let Some(dir) = builder.get_cwd() {
        command.current_dir(dir);
    }
    command.env_clear();
    command.envs(builder.iter_full_env_as_str());
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let writer = child
        .stdin
        .take()
        .map(|stdin| Box::new(stdin) as Box<dyn Write + Send>)
        .ok_or_else(|| "stdin assente".to_string());
    let reader = child
        .stdout
        .take()
        .map(|stdout| Box::new(stdout) as Box<dyn Read + Send>)
        .ok_or_else(|| "stdout assente".to_string());
    let errors = child.stderr.take().map(|stderr| Box::new(stderr) as Box<dyn Read + Send>);
    Ok(Spawned {
        child: Box::new(child),
        master: None,
        reader,
        writer,
        errors,
    })
}

/// The name `command` is known by: no directory, one executable extension off.
fn command_stem(command: &str) -> &str {
    let name = command.trim();
    match name.rsplit_once('.') {
        Some((head, ext)) if is_executable_extension(ext) => head,
        _ => name,
    }
}

/// A `[user@]host` an ssh session may be opened to, as `~/.ssh/config` and
/// `known_hosts` spell them. Nothing that starts with a dash, so it can never be
/// read as an option.
fn is_ssh_destination(value: &str) -> bool {
    let (user, host) = match value.split_once('@') {
        Some((user, host)) => (Some(user), host),
        None => (None, value),
    };
    let user_ok = user.map_or(true, |u| {
        !u.is_empty() && u.len() <= 64 && u.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    });
    let host_ok = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || "._-:[]%".contains(c));
    user_ok && host_ok && !value.starts_with('-')
}

/// The remote command ADE sends to open a shell in a folder, and nothing else.
///
/// `cd -- '<dir>' && exec "$SHELL" -l`, with the folder free of quotes, so the
/// only thing a caller chooses is a path. Home-relative folders are spelled
/// `cd -- "$HOME"/'<dir>'`, and the home itself `cd -- "$HOME"`, because a
/// quoted `~` does not expand. Mirrors `remoteCd` in `src/remote/ssh.ts`.
fn is_ssh_remote_cd(value: &str) -> bool {
    const SHELL: &str = " && exec \"$SHELL\" -l";
    let Some(cd) = value.strip_prefix("cd -- ").and_then(|rest| rest.strip_suffix(SHELL)) else {
        return false;
    };
    if cd == "\"$HOME\"" {
        return true;
    }
    let quoted = cd.strip_prefix("\"$HOME\"/").unwrap_or(cd);
    let Some(dir) = quoted.strip_prefix('\'').and_then(|d| d.strip_suffix('\'')) else {
        return false;
    };
    !dir.is_empty() && dir.len() <= 1024 && !dir.contains('\'') && !dir.chars().any(|c| c.is_control())
}

/// Whether `args` are ones `command` may be started with.
///
/// Agents keep their arguments: they are the programs the user asked for, and
/// what they do next is already theirs to decide. Shells and ssh do not, because
/// for them an argument is a command to run.
///
/// ssh takes `-p <port>`, `-l <user>`, `-t`/`-T`, `-J <destination>`, then one
/// destination and optionally the folder-changing command above. No `-o`, `-F`
/// or `-L`/`-R`/`-D`: `-o ProxyCommand=` and `-F <file>` run a local command,
/// and forwards open ports nobody asked for.
fn check_args(command: &str, args: &[String]) -> Result<(), String> {
    let stem = command_stem(command).to_ascii_lowercase();
    if stem == "ssh" {
        let mut destination = false;
        let mut i = 0;
        while i < args.len() {
            let arg = args[i].as_str();
            if destination {
                if i + 1 == args.len() && is_ssh_remote_cd(arg) {
                    return Ok(());
                }
                return Err(format!("argomento ssh non consentito: {arg}"));
            }
            match arg {
                "-t" | "-T" | "-tt" => {}
                "-p" => {
                    let port = args.get(i + 1).ok_or("porta ssh mancante")?;
                    if port.parse::<u16>().map_or(true, |p| p == 0) {
                        return Err(format!("porta ssh non valida: {port}"));
                    }
                    i += 1;
                }
                "-l" | "-J" => {
                    let value = args.get(i + 1).ok_or("valore ssh mancante")?;
                    let ok = if arg == "-l" {
                        is_ssh_destination(value) && !value.contains('@')
                    } else {
                        value.split(',').all(is_ssh_destination)
                    };
                    if !ok {
                        return Err(format!("valore ssh non valido: {value}"));
                    }
                    i += 1;
                }
                "--" => {}
                _ if is_ssh_destination(arg) => destination = true,
                _ => return Err(format!("argomento ssh non consentito: {arg}")),
            }
            i += 1;
        }
        return if destination { Ok(()) } else { Err("ssh senza destinazione".to_string()) };
    }
    if let Some((_, switches)) = SHELL_SWITCHES.iter().find(|(shell, _)| *shell == stem) {
        for arg in args {
            let lowered = arg.to_ascii_lowercase();
            if !switches.contains(&lowered.as_str()) {
                return Err(format!("argomento della shell non consentito: {arg}"));
            }
        }
    }
    Ok(())
}

/// What the CLI's reporting hook needs to know about this spawn.
///
/// Only the two identifiers: the directory it writes into is ADE's to choose,
/// and is resolved in `pty_spawn` rather than carried here.
#[derive(serde::Deserialize)]
pub struct SpawnLink {
    pub pane: String,
    pub nonce: String,
}

/// True when `command` names something ADE may start.
///
/// The comparison is against the bare name and is case-insensitive, because on
/// Windows `codex` reaches the disk as `codex.cmd` and the caller may have typed
/// either. A name carrying a path separator is refused outright: spelling a
/// binary by its full path is precisely how you would reach one that is not on
/// the list.
fn is_allowed_command(command: &str) -> bool {
    let name = command.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return false;
    }
    // Strip one trailing executable extension so `cmd.exe` and `cmd` both pass,
    // while `evil.exe.cmd` — two extensions, not a name we know — does not.
    let stem = command_stem(name);
    ALLOWED_AGENTS
        .iter()
        .chain(ALLOWED_SHELLS.iter())
        .chain(ALLOWED_REMOTE.iter())
        .any(|allowed| allowed.eq_ignore_ascii_case(stem))
}

fn is_executable_extension(ext: &str) -> bool {
    ["exe", "cmd", "bat", "com", "ps1"]
        .iter()
        .any(|known| known.eq_ignore_ascii_case(ext))
}

/*
 * The two questions ConPTY asks before it lets a process speak.
 *
 * portable-pty opens the pseudo console with `PSEUDOCONSOLE_INHERIT_CURSOR`,
 * and with it ConPTY starts by asking the terminal where the cursor is
 * (`ESC[6n`) and what it is (`ESC[c`), and holds every byte of the child's
 * output until both are answered or three seconds pass. Nobody answers a voice
 * or bot turn, which has no terminal, and a pane's xterm answers only after
 * the round trip through the window: `cmd /c echo` took 3.04 s to print in a
 * pty and 32 ms once answered here, and a spoken question waited those three
 * seconds before Claude Code even started.
 *
 * So the first of each, within `STARTUP_QUERY_WINDOW` of the spawn, is
 * answered here and taken out of the output: a fresh terminal's cursor is at
 * 1;1. The device attributes must claim VT level 61 or above: xterm's own
 * `ESC[?1;2c` does not release the output (measured, still 3 s), which is why
 * panes waited too although xterm answers. The window never sees the
 * question, so it never sends a second answer into the child's input.
 * Later queries (an agent asking for itself) pass through untouched.
 *
 * Only ConPTY asks these on its own. Elsewhere the same bytes come from the
 * child itself (Codex, nvim asking where the cursor is), and a made-up answer
 * would be a lie told to a program that then draws by it: off Windows
 * nothing is answered. Level 61 with no extensions (`ESC[?61c`) is enough to
 * release ConPTY; claiming sixel (`;4`) would invite an agent to send images
 * the pane may not draw.
 */
const STARTUP_QUERY_WINDOW: Duration = Duration::from_secs(5);
const CURSOR_QUERY: &str = "\x1b[6n";
const CURSOR_REPLY: &str = "\x1b[1;1R";
const DEVICE_QUERY: &str = "\x1b[c";
const DEVICE_REPLY: &str = "\x1b[?61c";

struct StartupQueries {
    cursor_answered: bool,
    device_answered: bool,
}

impl StartupQueries {
    /// `conpty`: whether the pty is ConPTY, whose questions these are. When not,
    /// there is nothing to answer and everything passes through.
    fn new(conpty: bool) -> Self {
        Self {
            cursor_answered: !conpty,
            device_answered: !conpty,
        }
    }

    fn done(&self) -> bool {
        self.cursor_answered && self.device_answered
    }

    /// `text` without the startup questions it answered, and the answer to send.
    fn take(&mut self, text: &str) -> (String, String) {
        let mut forward = text.to_string();
        let mut reply = String::new();
        if !self.cursor_answered {
            if let Some(at) = forward.find(CURSOR_QUERY) {
                forward.replace_range(at..at + CURSOR_QUERY.len(), "");
                reply.push_str(CURSOR_REPLY);
                self.cursor_answered = true;
            }
        }
        if !self.device_answered {
            if let Some(at) = forward.find(DEVICE_QUERY) {
                forward.replace_range(at..at + DEVICE_QUERY.len(), "");
                reply.push_str(DEVICE_REPLY);
                self.device_answered = true;
            }
        }
        (forward, reply)
    }
}

/// Takes everything decodable out of `tail`, leaving at most one incomplete
/// character behind for the next read to finish.
///
/// Two different things make `from_utf8` fail here and they need opposite
/// treatment, which is the whole reason this is a function with tests rather
/// than four lines inside the read loop.
///
/// A read can land in the middle of a multi-byte character — an accented
/// letter, a box-drawing glyph — and that is not an error, it is a boundary:
/// the bytes are kept and the next read completes them. That case was handled.
///
/// A byte that is simply not UTF-8 is a different thing, and it was not. The
/// code drained only up to `valid_up_to()` and never stepped over the bad
/// byte, so with one at the head of the buffer `valid_up_to()` was zero, the
/// drain removed nothing, and every later read failed at the same offset
/// forever: the pane froze on its last frame while the process kept running
/// and burning tokens, and `tail` grew without bound. A `git log` over a
/// latin-1 commit message is enough to do it. Now the bad byte is replaced
/// and skipped — which is what "lossy" was supposed to mean — so the loop
/// always makes progress and `tail` never holds more than three bytes.
fn decode_stream_chunk(tail: &mut Vec<u8>) -> String {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(tail) {
            Ok(whole) => {
                text.push_str(whole);
                tail.clear();
                return text;
            }
            Err(error) => {
                let good = error.valid_up_to();
                text.push_str(&String::from_utf8_lossy(&tail[..good]));
                match error.error_len() {
                    // Truncated at the buffer's edge: keep it for next time.
                    None => {
                        tail.drain(..good);
                        return text;
                    }
                    // Genuinely invalid: mark it, step over it, keep going —
                    // one read can carry more than one bad byte.
                    Some(bad) => {
                        text.push('\u{FFFD}');
                        tail.drain(..good + bad);
                    }
                }
            }
        }
    }
}

/// Starts `command` under a pty and streams it to the window as `pty:data`.
///
/// `id` comes from the caller rather than from here because the pane that will
/// display this session already has one, and matching them means the listener
/// can be attached before the first byte arrives — a CLI that greets you in
/// under a millisecond would otherwise lose its greeting.
///
/// `async` for the reason given on `pty_write`: opening a ConPTY, scanning PATH
/// and starting a process are all blocking, and a synchronous command does them
/// on the thread that draws the window.
#[tauri::command]
/*
 * The arguments are the IPC message, so they are not ours to group.
 *
 * Clippy is right that nine is a lot, and wrong about the remedy here:
 * bundling them into a struct changes the shape of the JSON the frontend
 * sends, for the benefit of a signature nobody calls from Rust.
 */
#[allow(clippy::too_many_arguments)]
pub async fn pty_spawn(
    app: AppHandle,
    registry: tauri::State<'_, Registry>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    /*
     * Which pane this is, and which spawn, for the CLI's own reporting hook.
     *
     * Absent when ADE has no hook installed for this agent, which is the
     * normal case: the variables are then not set at all, and a hook the user
     * installed for some other tool sees nothing of ADE's. See
     * `src/session-new/agent-link.ts`.
     */
    link: Option<SpawnLink>,
    /*
     * The pane this process belongs to, for `ade-msg`. The pty id is ADE's
     * own handle and means nothing to another session; the pane id is what
     * `ade-msg list` shows and what a reply is addressed to.
     */
    pane: Option<String>,
    /*
     * A secret for this spawn, which `ade-msg` sends with every message. The
     * pane id is printed by `ade-msg list` for anyone to copy; the token is
     * only in this process tree's environment, so a message that carries it
     * really comes from this pane.
     */
    pane_token: Option<String>,
    /*
     * API keys for this session, by name. Only names cross the IPC: the values
     * are read here from the system keychain (`secrets.rs`) and go straight
     * into the child's environment. Which keys a session gets is chosen per
     * key, per agent, in Impostazioni › Chiavi API, and checked again here
     * against the agent the command starts; bot turns pass none.
     */
    secrets: Option<Vec<String>>,
    /*
     * Pipes instead of a terminal, for Claude Code only.
     *
     * The top of this file explains why agents get a terminal. The exception
     * is a Claude Code kept running between spoken requests, which reads one
     * JSON message per line on stdin (`--input-format stream-json`) and
     * refuses to when stdin is a terminal. See `src/bots/warm.ts`.
     */
    pipe: Option<bool>,
) -> Result<(), String> {
    if !is_allowed_command(&command) {
        return Err(format!("comando non consentito: {command}"));
    }
    check_args(&command, &args)?;
    let pipe = pipe == Some(true);
    if pipe && !is_pipe_command(&command) {
        return Err(format!("{command} non si avvia senza terminale"));
    }

    /*
     * Resolved here rather than left to the spawner, so the binary that starts
     * is the same one the new-session form said was installed. On Windows that
     * is not a formality: the agent CLIs ship as several files of the same name
     * in the same directory, and only the one PATHEXT picks can actually run.
     */
    let resolved = which_on_path(&command).unwrap_or_else(|| command.clone());
    let mut builder = CommandBuilder::new(&resolved);
    for arg in &args {
        builder.arg(arg);
    }
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        builder.cwd(dir);
    }
    /*
     * Two variables every one of these CLIs reads before deciding how to draw.
     * Without TERM the fancier ones fall back to a dumb line mode that renders
     * as a wall of escape codes in the pane; without COLORTERM the ones that do
     * detect truecolour give up on it and the output looks nothing like the same
     * agent run from a real terminal.
     */
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    /*
     * The user's keys, before ADE's own variables so those always win. A key
     * that cannot be read fails the launch: an agent started without the key
     * it was meant to have fails later, somewhere less obvious.
     */
    for (name, value) in crate::secrets::env_for(&app, &command, secrets.as_deref().unwrap_or_default())? {
        builder.env(name, value);
    }

    /*
     * Somebody else's session does not come along.
     *
     * ADE can be started from a terminal that already belongs to an agent
     * session, and `CommandBuilder` inherits the environment it finds. The
     * child then reads the parent's markers and behaves as a continuation of
     * it rather than as a new session: Claude Code turns transcript saving off
     * on seeing CLAUDE_CODE_CHILD_SESSION and prints a banner saying so, and
     * every agent ADE starts is handed the parent's live IPC socket and its
     * token — a session-scoped credential, given to processes that have no
     * business with it.
     *
     * The contract at the top of this file is that an agent starts bare, "in a
     * real terminal, exactly as the user would start it themselves". These are
     * the variables that made that untrue.
     */
    for (key, _) in std::env::vars() {
        let is_session_marker = INHERITED_SESSION_MARKERS
            .iter()
            .any(|marker| key == *marker || key.starts_with(marker));

        /*
         * The colour switches belong in the same sweep, and were not in it.
         *
         * `INHERITED_COLOUR_SWITCHES` and `is_launcher_colour_switch` were
         * written for this loop, documented the exact symptom — a session in
         * a real 24-bit pane rendering white on black, logo included — and
         * were then never called from anywhere. The compiler said so, twice,
         * as a `dead_code` warning that had become part of the scenery.
         *
         * They matter because of how ADE is launched: from a shell whose own
         * output goes to a pipe, or from a bench runner, both of which set
         * `NO_COLOR`. The pane is not that pipe.
         */
        if is_session_marker || is_launcher_colour_switch(&key) {
            builder.env_remove(&key);
        }
    }

    /*
     * How the CLI reports which conversation it opened.
     *
     * Set last, after the scrub above, so the loop cannot take them back out.
     * All three or none: the script installed in the CLI's own configuration
     * exits on the first one it does not find, which is what makes it safe to
     * leave installed while the user runs that CLI from an ordinary terminal.
     *
     * The directory is resolved here rather than sent by the frontend, so the
     * only place a hook can write is ADE's own application data.
     */
    /*
     * Messages between sessions: `ade-msg` first on PATH, the mailbox, and
     * who this session is. Also after the scrub, for the same reason as the
     * hook variables below. See `mailbox.rs`.
     */
    if let (Some(pane), Some(bin), Some(box_dir)) = (
        pane.as_ref().filter(|p| !p.is_empty()),
        crate::mailbox::bin_dir(&app),
        crate::mailbox::mailbox_path(&app),
    ) {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut parts = vec![bin];
        parts.extend(std::env::split_paths(&path));
        if let Ok(joined) = std::env::join_paths(parts) {
            builder.env("PATH", joined);
        }
        builder.env("ADE_PANE_ID", pane);
        builder.env("ADE_MAILBOX", box_dir.as_os_str());
        if let Some(token) = pane_token.as_ref().filter(|t| !t.is_empty()) {
            builder.env("ADE_PANE_TOKEN", token);
        }
    }

    if let Some(link) = link.as_ref() {
        if let Some(dir) = crate::agent_link::link_dir(&app) {
            builder.env("ADE_PANE_ID", &link.pane);
            builder.env("ADE_SPAWN_NONCE", &link.nonce);
            builder.env("ADE_SESSION_DIR", dir.as_os_str());
        }
    }

    let spawned = if pipe {
        spawn_piped(&resolved, &builder).map_err(|e| format!("{command} non parte: {e}"))?
    } else {
        spawn_in_pty(builder, rows, cols).map_err(|e| format!("{command} non parte: {e}"))?
    };
    let Spawned { mut child, master, reader, writer, errors } = spawned;

    /*
     * The process is running now, so every failure below has to take it with
     * it. Returning early would drop the handle without ending the process, and
     * dropping a handle does not kill anything on Windows: the child would stay
     * alive with no way to reach it, because the registry never learned its id.
     */
    macro_rules! abort_with {
        ($message:expr) => {{
            let _ = child.kill();
            let _ = child.wait();
            return Err($message);
        }};
    }

    let (mut reader, writer) = match (reader, writer) {
        (Ok(reader), Ok(writer)) => (reader, Arc::new(Mutex::new(writer))),
        (Err(e), _) => abort_with!(format!("uscita non leggibile: {e}")),
        (_, Err(e)) => abort_with!(format!("ingresso non scrivibile: {e}")),
    };
    // The reader answers ConPTY's startup questions with it: see `StartupQueries`.
    let answerer = Arc::clone(&writer);
    let spawned_at = Instant::now();

    {
        let mut sessions = match registry.0.lock() {
            Ok(sessions) => sessions,
            Err(_) => abort_with!("registro bloccato".to_string()),
        };
        sessions.insert(
            id.clone(),
            Session {
                master,
                writer,
                child,
            },
        );
    }

    /*
     * Two threads, not one: a reader that never waits, and a sender that
     * decides how often the window hears about it.
     *
     * One thread emitting per read was one IPC message per 8 KB, and a
     * full-screen agent redrawing its frame produces those faster than the
     * webview can take them: every message is serialised, crosses the
     * boundary, wakes JavaScript, and is written into xterm — for frames the
     * user never sees, because the next one lands in the same animation
     * frame. Coalescing them costs a few milliseconds of latency and takes
     * the flood down to sixty messages a second whatever the agent does.
     *
     * The split is what makes the coalescing safe. A single thread would have
     * to decide whether to flush *before* its next blocking read, and an
     * agent that prints one line and falls silent would leave that line sitting
     * in the buffer until it spoke again. The sender's `recv_timeout` has no
     * such problem: the wait ends on its own.
     */
    let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<String>();
    // A piped process's errors go to the same stream: that is where a terminal would have shown them.
    if let Some(mut errors) = errors {
        let error_tx = chunk_tx.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut tail: Vec<u8> = Vec::new();
            while let Ok(n) = errors.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buffer[..n]);
                let text = decode_stream_chunk(&mut tail);
                if !text.is_empty() && error_tx.send(text).is_err() {
                    break;
                }
            }
        });
    }
    std::thread::spawn(move || {
        // See `decode_stream_chunk`.
        let mut buffer = [0u8; 8192];
        /*
         * Output is forwarded as lossy UTF-8 rather than bytes. A read can split
         * a multi-byte character, and `from_utf8_lossy` would then plant a
         * replacement character in the middle of a word that the next read
         * completes. Carrying the tail over keeps the split invisible.
         */
        let mut tail: Vec<u8> = Vec::new();
        // Only ConPTY asks its startup questions; a pipe has nobody to ask.
        let mut queries = StartupQueries::new(cfg!(windows) && !pipe);
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    tail.extend_from_slice(&buffer[..n]);
                    let mut text = decode_stream_chunk(&mut tail);
                    if !queries.done() && spawned_at.elapsed() < STARTUP_QUERY_WINDOW {
                        let (forward, reply) = queries.take(&text);
                        if !reply.is_empty() {
                            if let Ok(mut writer) = answerer.lock() {
                                let _ = writer.write_all(reply.as_bytes()).and_then(|_| writer.flush());
                            }
                        }
                        text = forward;
                    }
                    if text.is_empty() {
                        continue;
                    }
                    // The channel closing means the sender is gone, which only
                    // happens when the window is going away.
                    if chunk_tx.send(text).is_err() {
                        break;
                    }
                }
            }
        }
        // Dropping `chunk_tx` here is what tells the sender the pty reached
        // EOF, so it can flush the last frame and report the exit.
    });

    // For the waiter thread below; taken before `app` moves into the sender.
    let waiter = app.clone();
    let waited_id = id.clone();

    let emitter = app.clone();
    let stream_id = id.clone();
    std::thread::spawn(move || {
        let topic = data_topic(&stream_id);

        // Returns once the reader has hung up and the last frame is out.
        pump(&chunk_rx, |data| {
            let _ = emitter.emit(
                &topic,
                Chunk {
                    id: stream_id.clone(),
                    data,
                },
            );
        });

        let taken = app
            .state::<Registry>()
            .0
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&stream_id));

        /*
         * Nothing left to report: the waiter below already took the session
         * and said the exit — that is what let this reader reach EOF at all —
         * or `pty_kill` did. One exit per session, from whoever saw it first.
         */
        let Some(mut session) = taken else {
            return;
        };
        let code = session.child.wait().ok().map(|status| status.exit_code() as i32);

        let _ = emitter.emit(
            "pty:exit",
            Exit {
                id: stream_id,
                code,
            },
        );
    });

    /*
     * A third thread: the one that notices the process is gone.
     *
     * On Windows the reader above does not see EOF when the child exits.
     * ConPTY keeps its console host — OpenConsole.exe — alive until the pseudo
     * console is closed, and the pseudo console is closed by dropping the
     * master, which the registry holds until the exit is known: each wait
     * depends on the other, and a `nikcli run` that printed its answer and
     * exited left a pane that said "working" forever, with an OpenConsole
     * process for every turn. So the child is asked directly, twice a second;
     * once it has gone the session is dropped — which is what lets the
     * reader finish — and the exit is reported from here with the real code.
     * On unix this is merely redundant: EOF arrives first, the reader takes
     * the session, and this thread finds nothing and stops.
     */
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let code = {
            let registry = waiter.state::<Registry>();
            let Ok(mut sessions) = registry.0.lock() else {
                break;
            };
            let Some(session) = sessions.get_mut(&waited_id) else {
                break;
            };
            match session.child.try_wait() {
                Ok(None) => continue,
                Ok(Some(status)) => {
                    sessions.remove(&waited_id);
                    Some(status.exit_code() as i32)
                }
                Err(_) => {
                    sessions.remove(&waited_id);
                    None
                }
            }
        };
        let _ = waiter.emit(
            "pty:exit",
            Exit {
                id: waited_id,
                code,
            },
        );
        break;
    });

    Ok(())
}

/*
 * The sender's loop: coalesces what the reader hands over into at most one
 * `emit` per `FLUSH_INTERVAL`, and returns when the reader hangs up.
 *
 * It sleeps in `recv()` while nothing is waiting to go out. The loop it
 * replaced called `recv_timeout(16ms)` whatever the buffer held, so a silent
 * session — most of them, most of the time — woke sixty times a second to
 * find nothing to flush, and ten panes were six hundred wakeups a second of
 * an idle window. The timeout is only needed once there is something to send.
 *
 * The timeout now runs to a deadline set by the first byte waiting, rather
 * than restarting on every chunk. Restarting it meant an agent that printed
 * a token every ten milliseconds never left a sixteen-millisecond gap, so
 * nothing reached the pane until the 256 KB cap: the stream stalled for as
 * long as it was streaming. "One frame, at most, behind" is the promise the
 * comment on `FLUSH_INTERVAL` makes, and a deadline is what keeps it.
 *
 * Split out of `pty_spawn` so the rules can be tested with a channel and a
 * closure, without a window to emit into.
 */
fn pump(chunks: &Receiver<String>, mut emit: impl FnMut(String)) {
    let mut pending = String::new();
    // Set while `pending` holds something; the moment it must go out.
    let mut deadline: Option<Instant> = None;

    let mut flush = |pending: &mut String, deadline: &mut Option<Instant>| {
        *deadline = None;
        if !pending.is_empty() {
            emit(std::mem::take(pending));
        }
    };

    loop {
        let received = match deadline {
            None => chunks.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(at) => chunks.recv_timeout(at.saturating_duration_since(Instant::now())),
        };
        match received {
            Ok(text) => {
                pending.push_str(&text);
                // A burst larger than the cap goes out without waiting:
                // holding megabytes to save a message helps nobody, and a
                // `cat` of a large file is exactly that case.
                if pending.len() >= MAX_PENDING {
                    flush(&mut pending, &mut deadline);
                    continue;
                }
                match deadline {
                    None if !pending.is_empty() => deadline = Some(Instant::now() + FLUSH_INTERVAL),
                    // A queue that is never empty would otherwise keep
                    // `recv_timeout` answering `Ok` past the deadline.
                    Some(at) if Instant::now() >= at => flush(&mut pending, &mut deadline),
                    _ => {}
                }
            }
            Err(RecvTimeoutError::Timeout) => flush(&mut pending, &mut deadline),
            Err(RecvTimeoutError::Disconnected) => {
                // The last thing it said, before the exit is announced.
                flush(&mut pending, &mut deadline);
                return;
            }
        }
    }
}

/// Types `data` into the session exactly as given.
///
/// No newline is appended. What reaches a pty is keystrokes, and an agent's
/// menu answers "y", arrow keys and Ctrl-C are all keystrokes that would be
/// ruined by a helpful terminator: deciding when a line ends belongs to whoever
/// is typing.
///
/// `async` because a synchronous `#[tauri::command]` is dispatched on the
/// thread that owns the window. The write below blocks for as long as the child
/// refuses to read, so on that thread a single suspended agent stopped the
/// whole interface from repainting — every pane, not only its own.
#[tauri::command]
pub async fn pty_write(
    registry: tauri::State<'_, Registry>,
    id: String,
    data: String,
) -> Result<(), String> {
    /*
     * The registry lock is taken to find the writer and released before using
     * it. `write_all` on a pty blocks for as long as the child is not reading
     * its stdin — suspended, or sitting on a prompt nobody answered — and
     * holding the global lock across that would freeze spawn, resize and kill
     * for every other session in the window.
     *
     * The guard lives in a block of its own rather than being dropped by hand:
     * an early `?` between the lookup and the write must release it too.
     */
    let writer = {
        let sessions = registry.0.lock().map_err(|_| "registro bloccato")?;
        let session = sessions.get(&id).ok_or("sessione non trovata")?;
        Arc::clone(&session.writer)
    };

    let mut writer = writer.lock().map_err(|_| "scrittore bloccato")?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("scrittura fallita: {e}"))?;
    writer.flush().map_err(|e| format!("flush fallito: {e}"))
}

/// Tells the session how big its terminal is now.
///
/// A CLI that draws a full-screen interface reads this and nothing else: leave
/// it at the size the pane happened to be when it started and every redraw wraps
/// against a width that stopped being true the moment the user dragged anything.
///
/// `async` like the rest: a resize arrives on every frame of a drag, and it
/// asks the registry for a lock that a write may be holding.
#[tauri::command]
pub async fn pty_resize(
    registry: tauri::State<'_, Registry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = registry.0.lock().map_err(|_| "registro bloccato")?;
    let session = sessions.get(&id).ok_or("sessione non trovata")?;
    let Some(master) = session.master.as_ref() else {
        return Ok(());
    };
    master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize fallito: {e}"))
}

/// One row of the process table, as far as walking a tree needs.
#[derive(Clone, Copy)]
struct ProcRow {
    pid: u32,
    parent: Option<u32>,
    /// Seconds since the epoch.
    started: u64,
}

/// `root` and every process below it, children before their parents.
///
/// Walked down from `root`, and a child counts only if it started no earlier
/// than its parent. Windows reuses pids and keeps a dead parent's id in its
/// children's records, so a process whose recorded parent id is ours but which
/// predates that parent is someone else's — `taskkill /T` follows the id alone
/// and could take an unrelated tree with it, ADE's own included.
fn tree_of(root: u32, rows: &[ProcRow]) -> Vec<u32> {
    let started = |pid: u32| rows.iter().find(|row| row.pid == pid).map(|row| row.started);
    let Some(_) = started(root) else { return Vec::new() };
    let mut order = vec![root];
    let mut next = 0;
    while next < order.len() {
        let parent = order[next];
        let parent_started = started(parent).unwrap_or(u64::MAX);
        for row in rows {
            if row.parent == Some(parent) && row.pid != parent && row.started >= parent_started && !order.contains(&row.pid) {
                order.push(row.pid);
            }
        }
        next += 1;
    }
    order.reverse();
    order
}

/// Kills `pid` and the processes it started, one by one (see `tree_of`).
///
/// A CLI turn that runs past its time has children of its own — a shell, an
/// `ade-msg ask` waiting, a node process — and killing only the CLI leaves them
/// running, holding the turn's mailbox identity and its files.
fn kill_tree(pid: u32) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let rows: Vec<ProcRow> = sys
        .processes()
        .values()
        .map(|process| ProcRow {
            pid: process.pid().as_u32(),
            parent: process.parent().map(|parent| parent.as_u32()),
            started: process.start_time(),
        })
        .collect();
    for member in tree_of(pid, &rows) {
        if let Some(process) = sys.process(Pid::from_u32(member)) {
            process.kill();
        }
    }
}

/// Ends the session. Safe to call on one that already ended.
///
/// With `tree`, the processes the child started go too (see `kill_tree`).
/// Panes do not ask for it: closing a pane has always ended the agent, not a
/// dev server it left running on purpose.
///
/// `async` because `wait()` below is exactly as blocking as the write is: a
/// child that takes its time dying would otherwise take the window with it.
#[tauri::command]
pub async fn pty_kill(registry: tauri::State<'_, Registry>, id: String, tree: Option<bool>) -> Result<(), String> {
    let mut session = {
        let mut sessions = registry.0.lock().map_err(|_| "registro bloccato")?;
        sessions.remove(&id)
    };
    if let Some(session) = session.as_mut() {
        if tree == Some(true) {
            if let Some(pid) = session.child.process_id() {
                // Reading the process table takes a moment: off the async worker.
                let _ = tauri::async_runtime::spawn_blocking(move || kill_tree(pid)).await;
            }
        }
        let _ = session.child.kill();
        /*
         * Reaped here rather than left to the reader thread, which cannot do it:
         * removing the session above is what makes that thread's own lookup miss,
         * so nobody else will ever wait on this child and on unix it stays a
         * zombie until ADE itself exits.
         */
        let _ = session.child.wait();
    }
    Ok(())
}

/// Reports whether `command` can be found and started at all.
///
/// Kept separate from `pty_spawn` because "is this agent installed" is a
/// question the new-session form asks about every agent at once, and doing it by
/// opening ten pseudo-terminals would be an absurd way to find out.
///
/// `async` for the same reason as the others, and here the cost is multiplied:
/// the form asks about every agent in the catalogue at once, so a synchronous
/// version walked the whole of PATH ten times over on the thread that draws it.
#[tauri::command]
pub async fn pty_which(command: String) -> Option<String> {
    // Same gate as `pty_spawn`: the form only ever asks about the catalogue, and
    // answering for anything else would turn this into a way to probe the disk
    // from a page loaded in the browser pane.
    if !is_allowed_command(&command) {
        return None;
    }
    which_on_path(&command)
}

/// Shared with `serve`, which has to find the same `nikcli` this module would
/// start — on Windows that means honouring PATHEXT rather than guessing `.exe`.
pub(crate) fn which_on_path(command: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    /*
     * On Windows the agent CLIs are npm shims, and only some of them are .exe.
     * PATHEXT is what the shell would consult, so consulting it here is what
     * makes `opencode` resolve to `opencode.cmd` rather than to nothing.
     */
    #[cfg(windows)]
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase())
        .collect();
    #[cfg(not(windows))]
    let extensions: Vec<String> = vec![String::new()];

    for dir in std::env::split_paths(&path) {
        /*
         * Extensions before the bare name, and that order is the whole point on
         * Windows. npm installs a CLI three times over: `codex.cmd`, `codex.ps1`
         * and an extensionless `codex` shell script for Git Bash. Only the first
         * can be started by CreateProcess, but the extensionless one sits in the
         * same directory and matches first if you look for it first — which
         * reports the agent as installed and then fails to run it.
         */
        for extension in &extensions {
            if extension.is_empty() {
                continue;
            }
            let candidate = dir.join(format!("{command}{extension}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        let base = dir.join(command);
        if base.is_file() {
            return Some(base.to_string_lossy().into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claude_runs_on_pipes() {
        assert!(is_pipe_command("claude"));
        assert!(is_pipe_command("claude.exe"));
        assert!(is_pipe_command("CLAUDE.cmd"));
        assert!(!is_pipe_command("codex"));
        assert!(!is_pipe_command("powershell"));
        assert!(!is_pipe_command("claude-evil"));
    }

    #[test]
    fn decodes_a_whole_chunk_and_keeps_nothing() {
        let mut tail = b"ciao\r\n".to_vec();
        assert_eq!(decode_stream_chunk(&mut tail), "ciao\r\n");
        assert!(tail.is_empty());
    }

    #[test]
    fn carries_a_split_character_over_to_the_next_read() {
        // "è" is two bytes; the read landed between them.
        let full = "perché".as_bytes();
        let split = full.len() - 1;

        let mut tail = full[..split].to_vec();
        let first = decode_stream_chunk(&mut tail);
        assert_eq!(first, "perch");
        // The incomplete character is held, not replaced.
        assert_eq!(tail.len(), 1);
        assert!(!first.contains('\u{FFFD}'));

        tail.extend_from_slice(&full[split..]);
        assert_eq!(decode_stream_chunk(&mut tail), "é");
        assert!(tail.is_empty());
    }

    /*
     * The freeze. A byte that is not UTF-8 at the head of the buffer left
     * `valid_up_to()` at zero, so the old code drained nothing and every
     * later read failed at the same offset: the pane stopped updating for
     * good while the process kept running, and the buffer grew without end.
     */
    #[test]
    fn steps_over_an_invalid_byte_instead_of_stalling_on_it() {
        let mut tail = vec![0xFF];
        tail.extend_from_slice(b"dopo");

        let text = decode_stream_chunk(&mut tail);

        assert!(text.contains('\u{FFFD}'), "the bad byte should be marked");
        assert!(text.ends_with("dopo"), "output after it must survive");
        assert!(tail.is_empty(), "the bad byte must not be left behind");
    }

    #[test]
    fn a_lone_invalid_byte_does_not_block_later_reads() {
        let mut tail = vec![0xFE];
        assert!(!decode_stream_chunk(&mut tail).is_empty());
        assert!(tail.is_empty());

        // The next read must behave as though nothing had happened.
        tail.extend_from_slice(b"ok");
        assert_eq!(decode_stream_chunk(&mut tail), "ok");
    }

    #[test]
    fn survives_several_invalid_bytes_in_one_read() {
        let mut tail = b"a".to_vec();
        tail.extend_from_slice(&[0xFF, 0xFE]);
        tail.extend_from_slice("b".as_bytes());

        let text = decode_stream_chunk(&mut tail);

        assert_eq!(text.matches('\u{FFFD}').count(), 2);
        assert!(text.starts_with('a') && text.ends_with('b'));
        assert!(tail.is_empty());
    }

    /*
     * The sender's rules, without a stopwatch. Every chunk is queued and the
     * reader's end dropped before `pump` starts, so what it emits is decided
     * by the cap and the hang-up alone, never by how fast the machine is.
     */
    fn pumped(chunks: &[&str]) -> Vec<String> {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        for chunk in chunks {
            tx.send(chunk.to_string()).unwrap();
        }
        drop(tx);
        let mut emitted = Vec::new();
        pump(&rx, |data| emitted.push(data));
        emitted
    }

    #[test]
    fn a_session_that_says_nothing_emits_nothing() {
        assert!(pumped(&[]).is_empty());
    }

    #[test]
    fn the_last_words_go_out_when_the_reader_hangs_up() {
        // However the chunks were grouped on the way, none is lost or reordered.
        assert_eq!(pumped(&["a", "b", "c"]).concat(), "abc");
    }

    #[test]
    fn a_line_followed_by_silence_still_reaches_the_pane() {
        // The case the two-thread split exists for: output, then nothing, with
        // the reader still connected. Only an upper bound is asserted — two
        // seconds for a sixteen-millisecond deadline — so a slow machine passes.
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (out_tx, out_rx) = std::sync::mpsc::channel::<String>();
        let sender = std::thread::spawn(move || pump(&rx, |data| out_tx.send(data).unwrap()));

        tx.send("prompt> ".to_string()).unwrap();
        assert_eq!(out_rx.recv_timeout(Duration::from_secs(2)).as_deref(), Ok("prompt> "));

        drop(tx);
        sender.join().unwrap();
    }

    #[test]
    fn a_burst_past_the_cap_goes_out_without_waiting() {
        let big = "x".repeat(MAX_PENDING);
        let emitted = pumped(&[&big, "tail"]);
        assert_eq!(emitted, vec![big, "tail".to_string()]);
    }

    #[test]
    fn accepts_every_agent_in_the_catalogue() {
        for agent in ALLOWED_AGENTS {
            assert!(is_allowed_command(agent), "{agent} should be startable");
        }
        for shell in ALLOWED_SHELLS {
            assert!(is_allowed_command(shell), "{shell} should be startable");
        }
    }

    #[test]
    fn accepts_the_windows_spelling_of_an_allowed_name() {
        // What the caller has in hand may already carry the extension PATHEXT
        // would have added, and both spellings name the same binary.
        assert!(is_allowed_command("codex.cmd"));
        assert!(is_allowed_command("CLAUDE.EXE"));
        assert!(is_allowed_command("Claude"));
    }

    #[test]
    fn a_session_listens_on_a_topic_of_its_own() {
        // The shape `host/shell.ts` builds on the other side. A topic that
        // did not match would be a pane that draws nothing, with no error
        // anywhere: the listener simply never fires.
        assert_eq!(data_topic("n1700000000-1"), "pty:data:n1700000000-1");
    }

    #[test]
    fn refuses_a_command_that_is_not_in_the_catalogue() {
        assert!(!is_allowed_command("cmd.exe /c calc"));
        assert!(!is_allowed_command("curl"));
        assert!(!is_allowed_command("node"));
        assert!(!is_allowed_command(""));
        assert!(!is_allowed_command("   "));
    }

    #[test]
    fn refuses_a_path_even_when_it_ends_in_an_allowed_name() {
        // The whole point of naming binaries rather than paths: a page that can
        // write a file anywhere must not be able to name it back for execution.
        assert!(!is_allowed_command("/tmp/claude"));
        assert!(!is_allowed_command("C:\\Users\\Public\\claude.exe"));
        assert!(!is_allowed_command("./claude"));
        assert!(!is_allowed_command("..\\claude"));
    }

    #[test]
    fn the_markers_scrubbed_cover_what_a_parent_session_leaks() {
        // The names seen in the wild when ADE is launched from inside another
        // agent's terminal: the marker that makes the child disable transcript
        // saving, and the socket and token that are credentials for a session
        // this child has nothing to do with.
        for leaked in [
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_TOKEN",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDECODE",
            "CLAUDE_PID",
            "ADE_MAILBOX_ROOT",
        ] {
            assert!(
                INHERITED_SESSION_MARKERS
                    .iter()
                    .any(|marker| leaked == *marker || leaked.starts_with(marker)),
                "{leaked} should not reach a spawned agent"
            );
        }
    }

    #[test]
    fn a_tree_is_walked_down_by_start_time_and_killed_children_first() {
        let row = |pid, parent, started| ProcRow { pid, parent, started };
        let rows = [
            row(100, Some(1), 1_000),
            row(110, Some(100), 1_001),
            row(111, Some(110), 1_002),
            row(120, Some(100), 1_000),
            // Claims 100 as its parent but started before it: an older process
            // whose real parent died and left the id to be reused.
            row(130, Some(100), 900),
            row(131, Some(130), 950),
            // Unrelated.
            row(200, Some(1), 500),
        ];
        let tree = tree_of(100, &rows);
        assert_eq!(tree.len(), 4);
        for pid in [100, 110, 111, 120] {
            assert!(tree.contains(&pid));
        }
        assert!(!tree.contains(&130) && !tree.contains(&131) && !tree.contains(&200));
        let at = |pid| tree.iter().position(|p| *p == pid).unwrap();
        assert!(at(111) < at(110) && at(110) < at(100) && at(120) < at(100));
        assert!(tree_of(999, &rows).is_empty());
    }

    #[test]
    fn scrubbing_leaves_the_rest_of_the_environment_alone() {
        // An agent needs the environment it would have had in a terminal —
        // PATH above all, plus whatever the user configured for it.
        for kept in ["PATH", "HOME", "USERPROFILE", "ANTHROPIC_API_KEY", "TERM", "ADE_MAILBOX", "ADE_PANE_ID"] {
            assert!(
                !INHERITED_SESSION_MARKERS
                    .iter()
                    .any(|marker| kept == *marker || kept.starts_with(marker)),
                "{kept} must still be inherited"
            );
        }
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn a_shell_cannot_be_handed_a_command() {
        #[cfg(windows)]
        {
            assert!(check_args("cmd", &strings(&[])).is_ok());
            assert!(check_args("cmd.exe", &strings(&["/Q"])).is_ok());
            assert!(check_args("powershell", &strings(&["-NoLogo"])).is_ok());
            for bad in [&["/c", "calc"][..], &["/K", "calc"], &["/ccalc"]] {
                assert!(check_args("cmd", &strings(bad)).is_err(), "{bad:?}");
            }
            for bad in [&["-enc", "AAAA"][..], &["-Comm", "calc"], &["calc"], &["-File", "x.ps1"]] {
                assert!(check_args("powershell", &strings(bad)).is_err(), "{bad:?}");
                assert!(check_args("pwsh", &strings(bad)).is_err(), "{bad:?}");
            }
        }
        #[cfg(not(windows))]
        {
            assert!(check_args("zsh", &strings(&["-l"])).is_ok());
            assert!(check_args("sh", &strings(&["-c", "id"])).is_err());
            assert!(check_args("bash", &strings(&["script.sh"])).is_err());
        }
    }

    #[test]
    fn agents_keep_their_arguments() {
        assert!(check_args("claude", &strings(&["--model", "opus", "--resume", "x"])).is_ok());
    }

    #[test]
    fn ssh_opens_a_session_to_a_host_and_nothing_else() {
        assert!(check_args("ssh", &strings(&["devbox"])).is_ok());
        assert!(check_args("ssh", &strings(&["-p", "2222", "-l", "niko", "10.0.0.5"])).is_ok());
        assert!(check_args("ssh", &strings(&["-J", "bastion", "niko@host.example.com"])).is_ok());
        assert!(check_args(
            "ssh.exe",
            &strings(&["-t", "devbox", "cd -- '/srv/app' && exec \"$SHELL\" -l"])
        )
        .is_ok());
        assert!(check_args("ssh", &strings(&["-t", "devbox", "cd -- \"$HOME\"/'app' && exec \"$SHELL\" -l"])).is_ok());
        assert!(check_args("ssh", &strings(&["-t", "devbox", "cd -- \"$HOME\" && exec \"$SHELL\" -l"])).is_ok());

        for bad in [
            &["devbox", "cd -- \"$HOME\"/$(calc) && exec \"$SHELL\" -l"][..],
            &["devbox", "cd -- \"$(calc)\" && exec \"$SHELL\" -l"],
            &[][..],
            &["-o", "ProxyCommand=calc", "devbox"],
            &["-oProxyCommand=calc", "devbox"],
            &["-F", "evil.conf", "devbox"],
            &["-L", "8080:localhost:80", "devbox"],
            &["devbox", "rm -rf ~"],
            &["devbox", "cd -- '/x'; rm -rf ~; ' && exec \"$SHELL\" -l"],
            &["-p", "nope", "devbox"],
            &["-J", "-oProxyCommand=calc", "devbox"],
        ] {
            assert!(check_args("ssh", &strings(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn refuses_a_name_that_only_borrows_an_allowed_one() {
        assert!(!is_allowed_command("claude-evil"));
        assert!(!is_allowed_command("notclaude"));
        assert!(!is_allowed_command("evil.exe.cmd"));
        // Stripping one known extension must not uncover a second name.
        assert!(!is_allowed_command("claude.evil"));
    }

    #[test]
    fn conpty_startup_questions_are_answered_once_and_kept_from_the_window() {
        let mut queries = StartupQueries::new(true);
        let (forward, reply) = queries.take("\x1b[1t\x1b[6n\x1b[c\x1b[?1004h");
        assert_eq!(forward, "\x1b[1t\x1b[?1004h");
        assert_eq!(reply, "\x1b[1;1R\x1b[?61c");
        assert!(queries.done());
        // An agent asking later gets its question through, to the real terminal.
        let (forward, reply) = queries.take("\x1b[6n");
        assert_eq!((forward.as_str(), reply.as_str()), ("\x1b[6n", ""));
        // A secondary device-attributes query is not the startup one.
        let mut fresh = StartupQueries::new(true);
        let (forward, reply) = fresh.take("\x1b[>c");
        assert_eq!((forward.as_str(), reply.as_str()), ("\x1b[>c", ""));
    }

    #[test]
    fn without_conpty_a_child_asking_for_the_cursor_gets_the_real_terminal() {
        // On unix the question is Codex's or nvim's own, not the pty's.
        let mut queries = StartupQueries::new(false);
        assert!(queries.done());
        let (forward, reply) = queries.take("\x1b[6n\x1b[c");
        assert_eq!((forward.as_str(), reply.as_str()), ("\x1b[6n\x1b[c", ""));
    }

    /// How long a process in a pty takes to print, answering the startup questions as
    /// `pty_spawn` does or not. `cargo test --lib pty::tests::startup_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn startup_probe() {
        for answer in [false, true] {
            let pty = native_pty_system();
            let pair = pty.openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 }).unwrap();
            let mut cmd = if cfg!(windows) { CommandBuilder::new("cmd") } else { CommandBuilder::new("sh") };
            // PROBE_CMD: another command whose output ends in "pronto", e.g. `claude --version & echo pronto`.
            let line = std::env::var("PROBE_CMD").unwrap_or_else(|_| "echo pronto".into());
            if cfg!(windows) {
                cmd.args(["/c", &line]);
            } else {
                cmd.args(["-c", &line]);
            }
            let start = Instant::now();
            let mut child = pair.slave.spawn_command(cmd).unwrap();
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().unwrap();
            let mut writer = pair.master.take_writer().unwrap();
            let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            let mut queries = StartupQueries::new(true);
            let mut seen = String::new();
            while let Ok(chunk) = rx.recv_timeout(Duration::from_secs(10)) {
                let text = String::from_utf8_lossy(&chunk).into_owned();
                if answer {
                    let (_, reply) = queries.take(&text);
                    if !reply.is_empty() {
                        writer.write_all(reply.as_bytes()).unwrap();
                        writer.flush().unwrap();
                    }
                }
                seen.push_str(&text);
                if seen.contains("pronto") {
                    break;
                }
            }
            println!("answer={answer} pronto={:?}", start.elapsed());
            let _ = child.kill();
        }
    }
}

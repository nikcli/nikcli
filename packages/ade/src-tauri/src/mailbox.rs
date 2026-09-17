//! Sessions talking to each other, whatever CLI each one runs.
//!
//! No CLI has a way to talk to another CLI, and ADE cannot add one to each of
//! them. What they all have is a shell tool and a terminal, so the channel is
//! built from exactly those two things:
//!
//! - every session ADE starts finds `ade-msg` on its PATH, with its own pane id
//!   in `ADE_PANE_ID`, the secret that proves it in `ADE_PANE_TOKEN`, and the
//!   mailbox in `ADE_MAILBOX`;
//! - `ade-msg send|ask|spawn|reply` drops a JSON file in `outbox/` and waits
//!   for a receipt; `ade-msg list` and `agents` print what ADE last published;
//! - the frontend takes the outbox, types each message into the target pane's
//!   terminal as if the user had, and writes the receipt;
//! - `ask` and `spawn` then keep waiting, the way a subagent call does, for
//!   `results/<id>.txt`, which ADE writes when the other session runs
//!   `ade-msg reply <id>`. The waiter claims it by renaming it; one that is
//!   still there a moment later had nobody waiting, and ADE takes it back
//!   (`<id>.typed`) and types it into the caller instead;
//! - for orchestration, `--no-wait` returns the id at once and `wait` takes
//!   several; ADE writes `results/<id>.state` when what a request waits on
//!   changes (a permission prompt, say) and publishes `requests.txt` for
//!   `status`. `cancel`, `close` and `spawn --close` are messages like the rest.
//!
//! This side only moves files. Deciding who a message is for, and what it
//! looks like when it lands, is `src/session/mailbox.ts`, where it is tested.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::Manager;

const MAILBOX_SUBDIR: &str = "mailbox";

/// Receipts and results nobody collected are removed after this long.
const LEFTOVER_TTL: Duration = Duration::from_secs(60 * 60 * 24);

/// A message larger than this is not a message; the file is dropped unread and its sender told.
///
/// Room for the longest text the frontend accepts (40,000 characters) even
/// when every one is four bytes of UTF-8, plus the JSON around it.
const MAX_MESSAGE_BYTES: u64 = 256 * 1024;

/// Set by `bun run test:app` to give each worktree's ADE Test its own mailbox.
const MAILBOX_ROOT_ENV: &str = "ADE_MAILBOX_ROOT";

/// Where the mailbox is: the app's data directory, or for a test build the
/// absolute folder in `ADE_MAILBOX_ROOT`.
///
/// Every ADE Test shares one identifier, so without this two of them, from
/// two worktrees, shared a mailbox: each took the other's messages and the
/// last one started rewrote `ade-msg` with its own version (S25). The
/// official ADE never reads the variable, so a session that inherits it
/// cannot move the user's mailbox.
fn choose_root(test_build: bool, env: Option<std::ffi::OsString>, default: Option<PathBuf>) -> Option<PathBuf> {
    let custom = env.map(PathBuf::from).filter(|path| path.is_absolute());
    match (test_build, custom) {
        (true, Some(path)) => Some(path),
        _ => default,
    }
}

pub fn mailbox_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = choose_root(
        crate::is_test_build(app),
        std::env::var_os(MAILBOX_ROOT_ENV),
        app.path().app_local_data_dir().ok().map(|data| data.join(MAILBOX_SUBDIR)),
    )?;
    for sub in ["outbox", "receipts", "results", "bin"] {
        fs::create_dir_all(dir.join(sub)).ok()?;
    }
    Some(dir)
}

/// The directory prepended to every session's PATH.
pub fn bin_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    mailbox_path(app).map(|dir| dir.join("bin"))
}

/// Writes the `ade-msg` scripts and clears old leftovers. Called at startup.
///
/// Rewritten every launch rather than only when missing, so a session always
/// runs the version that matches the ADE that will read its messages.
pub fn install(app: &tauri::AppHandle) {
    let Some(dir) = mailbox_path(app) else { return };
    let bin = dir.join("bin");
    let _ = fs::write(bin.join("ade-msg.ps1"), PS1);
    let _ = fs::write(bin.join("ade-msg.cmd"), CMD);
    let _ = fs::write(bin.join("ade-msg"), SH);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(bin.join("ade-msg"), fs::Permissions::from_mode(0o755));
    }

    let now = SystemTime::now();
    // Read messages are kept a day, like receipts, then go.
    let handled = fs::read_dir(dir.join("inbox"))
        .map(|panes| panes.flatten().map(|pane| pane.path().join("handled")).collect::<Vec<_>>())
        .unwrap_or_default();
    for sub in ["receipts".into(), "results".into()].into_iter().chain(handled) {
        let sub: PathBuf = sub;
        let Ok(entries) = fs::read_dir(dir.join(sub)) else { continue };
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age > LEFTOVER_TTL);
            if old {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// A message id names a file, so it is held to a shape that cannot be a path.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Writes `dir/<name>` whole: a reader polling for the final name never sees half of it.
fn write_whole(dir: PathBuf, name: &str, text: &str) -> Result<(), String> {
    let part = dir.join(format!("{name}.part"));
    fs::write(&part, text).map_err(|e| format!("scrittura fallita: {e}"))?;
    fs::rename(&part, dir.join(name)).map_err(|e| format!("scrittura fallita: {e}"))
}

#[derive(Serialize)]
pub struct Outgoing {
    id: String,
    /// The JSON the script wrote, unparsed: judging it is the frontend's job.
    body: String,
}

/// Takes every complete message out of the outbox.
///
/// Only `*.json`: the scripts write `*.part` and rename, so a file with the
/// final name is always whole. Each one is removed as it is read, which is
/// what makes a message delivered at most once.
#[tauri::command]
pub async fn mailbox_take(app: tauri::AppHandle) -> Result<Vec<Outgoing>, String> {
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?;
    take_outbox(&dir.join("outbox"), &dir.join("receipts"))
}

/// The outbox read, and a receipt for every message refused for its size.
///
/// A refused message used to vanish: the sender waited for a receipt that
/// never came and printed "ADE non ha ancora confermato", as if it would.
/// The receipt for a message not read because of its size. A size that could
/// not be read is said as such, not as "0 KiB".
fn too_big_receipt(size: Option<u64>) -> String {
    let max = MAX_MESSAGE_BYTES / 1024;
    let why = match size {
        Some(len) => format!("messaggio troppo grande ({} KiB, massimo {max} KiB)", len / 1024),
        None => format!("dimensione del messaggio non leggibile (massimo {max} KiB)"),
    };
    format!("errore: {why}: mandalo come file con --file o scrivilo in un file e manda il percorso")
}

fn take_outbox(outbox: &std::path::Path, receipts: &std::path::Path) -> Result<Vec<Outgoing>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(outbox).map_err(|e| format!("casella non leggibile: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        let size = entry.metadata().map(|m| m.len()).ok();
        let too_big = size.map_or(true, |len| len > MAX_MESSAGE_BYTES);
        let body = if too_big { None } else { fs::read_to_string(&path).ok() };
        let _ = fs::remove_file(&path);
        if !valid_id(&id) {
            continue;
        }
        match body {
            Some(body) => out.push(Outgoing { id, body }),
            None if too_big => {
                let said = too_big_receipt(size);
                let _ = write_whole(receipts.to_path_buf(), &format!("{id}.txt"), &said);
            }
            None => {
                let _ = write_whole(receipts.to_path_buf(), &format!("{id}.txt"), "errore: messaggio non leggibile (non è UTF-8)");
            }
        }
    }
    Ok(out)
}

/// The mailbox folder, for the frontend code that writes to it directly (the voice outbox).
#[tauri::command]
pub async fn mailbox_dir(app: tauri::AppHandle) -> Result<String, String> {
    mailbox_path(&app)
        .map(|dir| dir.to_string_lossy().into_owned())
        .ok_or_else(|| "casella non disponibile".into())
}

/// Tells the waiting `ade-msg` what happened to its message.
#[tauri::command]
pub async fn mailbox_receipt(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("id messaggio non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("receipts");
    write_whole(dir, &format!("{id}.txt"), &text)
}

/// The answer to request `id`, for the `ade-msg ask|spawn|wait` blocked on it.
#[tauri::command]
pub async fn mailbox_result(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("id richiesta non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("results");
    write_whole(dir, &format!("{id}.txt"), &text)
}

/// Takes back an answer nobody claimed, and returns it to be typed instead.
///
/// A rename, like the waiter's claim, so exactly one of the two wins. The
/// file is removed once read: the answer is now in the caller's terminal, and
/// a later `ade-msg wait` printing it a second time only doubled its cost.
#[tauri::command]
///
/// `kind: "update"` does the same for an `ade-msg update` no waiter woke on;
/// that one is not kept, since a later `wait` should wait for the answer.
pub async fn mailbox_result_reclaim(app: tauri::AppHandle, id: String, kind: Option<String>) -> Result<Option<String>, String> {
    if !valid_id(&id) {
        return Err("id richiesta non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("results");
    if kind.as_deref() == Some("update") {
        let taken = dir.join(format!("{id}.update-typed"));
        if fs::rename(dir.join(format!("{id}.update")), &taken).is_err() {
            return Ok(None);
        }
        let text = fs::read_to_string(&taken).ok();
        let _ = fs::remove_file(&taken);
        return Ok(text);
    }
    let typed = dir.join(format!("{id}.typed"));
    if fs::rename(dir.join(format!("{id}.txt")), &typed).is_err() {
        return Ok(None);
    }
    let text = fs::read_to_string(&typed).ok();
    let _ = fs::remove_file(&typed);
    Ok(text)
}

/// What request `id` is waiting on, for the `ade-msg wait` blocked on it to
/// print when it changes ("attende un permesso"). Empty text removes it.
#[tauri::command]
///
/// `kind: "update"` writes `<id>.update` instead: an `ade-msg update` from the
/// answering session, which wakes the waiter rather than being printed beside it.
pub async fn mailbox_state(app: tauri::AppHandle, id: String, text: String, kind: Option<String>) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("id richiesta non valido".into());
    }
    let ext = match kind.as_deref() {
        None | Some("state") => "state",
        Some("update") => "update",
        Some(_) => return Err("tipo di stato sconosciuto".into()),
    };
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("results");
    if text.is_empty() {
        let _ = fs::remove_file(dir.join(format!("{id}.{ext}")));
        return Ok(());
    }
    write_whole(dir, &format!("{id}.{ext}"), &text)
}

/// Leaves a long message in `inbox/<pane>/<name>.msg`, for `ade-msg inbox` to print.
///
/// Typed into a terminal, a long message was taken for a paste and its Enter
/// lost (S17); here only a short bell is typed, and the text waits as a file.
#[tauri::command]
pub async fn mailbox_inbox_put(app: tauri::AppHandle, pane: String, name: String, text: String) -> Result<(), String> {
    if !valid_id(&pane) || !valid_id(&name) {
        return Err("id non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("inbox").join(&pane);
    fs::create_dir_all(dir.join("handled")).map_err(|e| format!("inbox non creata: {e}"))?;
    write_whole(dir, &format!("{name}.msg"), &text)
}

/// Whether the message was read: `ade-msg inbox` moves what it prints to `handled/`.
#[tauri::command]
pub async fn mailbox_inbox_read(app: tauri::AppHandle, pane: String, name: String) -> Result<bool, String> {
    if !valid_id(&pane) || !valid_id(&name) {
        return Err("id non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("inbox").join(&pane);
    Ok(!dir.join(format!("{name}.msg")).exists())
}

/// Publishes a list `ade-msg` prints: `sessions` for `list`, `agents` for
/// `agents`, `requests` for `status`, `usage` for the help text.
#[tauri::command]
pub async fn mailbox_publish(app: tauri::AppHandle, name: Option<String>, text: String) -> Result<(), String> {
    let name = match name.as_deref() {
        None | Some("sessions") => "sessions",
        Some("agents") => "agents",
        Some("requests") => "requests",
        Some("usage") => "usage",
        Some("stats") => "stats",
        Some(_) => return Err("elenco sconosciuto".into()),
    };
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?;
    write_whole(dir, &format!("{name}.txt"), &text)
}

/// Windows: the implementation. Plain PowerShell 5.1, no modules.
///
/// `$args`, not a `param` block: with named parameters a message containing
/// `-To` or `-Command` would be bound as one of them.
const PS1: &str = r#"# ade-msg — talk to the other ADE sessions. Written by ADE; do not edit.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$utf8 = New-Object Text.UTF8Encoding $false
$box = $env:ADE_MAILBOX
if (-not $box -or -not (Test-Path $box)) { [Console]::Error.WriteLine('ade-msg: questa shell non e'' una sessione avviata da ADE (ADE_MAILBOX mancante).'); exit 2 }

function Usage {
  $f = Join-Path $box 'usage.txt'
  if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'uso: ade-msg list | send | ask | spawn | reply | wait | status | cancel | close | agents | whoami' }
  exit 1
}
function Fail($message) { [Console]::Error.WriteLine("ade-msg: $message"); exit 1 }
# A probe that cannot fail. Under 'Stop' a denied Test-Path (a caller at a
# lower integrity level than the mailbox) was a screenful of PowerShell error.
function Has($path) { try { return [IO.File]::Exists($path) } catch { return $false } }

$all = @($args | ForEach-Object { [string]$_ })
$cmd = if ($all.Count -gt 0) { $all[0] } else { '' }
$timeout = 110
$noWait = $false
$any = $false
$close = $false
$worktree = $false
$force = $false
$fresh = $false
$fork = $false
$ttl = 0
$name = $null
$model = $null
$base = $null
$note = $null
$effort = $null
$profile = $null
$file = $null
# update takes an id and a state before its text, kv an operation and a key, memory an operation and a type; everything else one word.
$lead = if ($cmd -eq 'update' -or $cmd -eq 'kv' -or $cmd -eq 'memory') { 2 } else { 1 }
$pos = New-Object System.Collections.Generic.List[string]
for ($i = 1; $i -lt $all.Count; $i++) {
  $a = $all[$i]
  # Options anywhere: agents write them after the text as often as before it.
  if ($true) {
    $hasNext = ($i + 1) -lt $all.Count
    if ($a -eq '--timeout' -and $hasNext) { try { $timeout = [int]$all[$i + 1] } catch { Usage }; $i++; continue }
    elseif ($a -eq '--file' -and $hasNext) { $file = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--name' -and $hasNext) { $name = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--model' -and $hasNext) { $model = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--base' -and $hasNext) { $base = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--note' -and $hasNext) { $note = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--effort' -and $hasNext) { $effort = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--profile' -and $hasNext) { $profile = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--no-wait') { $noWait = $true; continue }
    elseif ($a -eq '--any') { $any = $true; continue }
    elseif ($a -eq '--close') { $close = $true; continue }
    elseif ($a -eq '--worktree') { $worktree = $true; continue }
    elseif ($a -eq '--force') { $force = $true; continue }
    elseif ($a -eq '--fresh') { $fresh = $true; continue }
    elseif ($a -eq '--fork') { $fork = $true; continue }
    elseif ($a -eq '--ttl' -and $hasNext) { try { $ttl = [int]$all[$i + 1] } catch { Usage }; $i++; continue }
  }
  $pos.Add($a)
}
$head = if ($pos.Count -gt 0) { $pos[0] } else { '' }
$second = if ($pos.Count -gt 1) { $pos[1] } else { '' }
$text = if ($pos.Count -gt $lead) { ($pos.GetRange($lead, $pos.Count - $lead)) -join ' ' } else { '' }

# --file: the text is the file. One too big for a message is sent as its path and its beginning.
if ($file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Fail "file non trovato: $file" }
  $item = Get-Item -LiteralPath $file
  $content = [IO.File]::ReadAllText($item.FullName, $utf8)
  if ($content.Length -gt 40000) {
    $content = "Il contenuto completo e' nel file $($item.FullName) ($($item.Length) byte); leggilo da li'. Inizio:`n" + $content.Substring(0, 1500)
  }
  $text = if ($text) { "$text`n`n$content" } else { $content }
}

function Post($fields) {
  $id = ('{0}-{1}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), ([guid]::NewGuid().ToString('N').Substring(0, 8)))
  # Past one message ADE would cut the text; the whole of it goes to a file the recipient can read.
  $long = [string]$fields['text']
  if ($long.Length -gt 40000) {
    $path = Join-Path (Join-Path $box 'results') "$id.long.txt"
    [IO.File]::WriteAllText($path, $long, $utf8)
    $fields['text'] = "Testo completo ($($long.Length) caratteri) in $path, leggilo da li'. Inizio: " + $long.Substring(0, 1500)
  }
  $fields['from'] = $env:ADE_PANE_ID
  $fields['token'] = $env:ADE_PANE_TOKEN
  $json = $fields | ConvertTo-Json -Compress
  $out = Join-Path $box 'outbox'
  $part = Join-Path $out "$id.part"
  [IO.File]::WriteAllText($part, $json, $utf8)
  Move-Item -LiteralPath $part -Destination (Join-Path $out "$id.json")
  return $id
}

# The receipt: what ADE did with the message. $null when ADE has not answered yet.
function Receipt($id) {
  $receipt = Join-Path (Join-Path $box 'receipts') "$id.txt"
  for ($i = 0; $i -lt 50; $i++) {
    if (Test-Path $receipt) {
      $r = [IO.File]::ReadAllText($receipt, $utf8)
      Remove-Item -LiteralPath $receipt -ErrorAction SilentlyContinue
      return $r.Trim()
    }
    Start-Sleep -Milliseconds 200
  }
  return $null
}

# Posts and prints the receipt; exits 1 when ADE refused.
function PostAndConfirm($fields) {
  $id = Post $fields
  $r = Receipt $id
  if ($null -eq $r) { Write-Output 'in coda: ADE non ha ancora confermato'; exit 0 }
  Write-Output $r
  if ($r.StartsWith('ok')) { exit 0 } else { exit 1 }
}

# Posts and prints what ADE answered after its first line: the value, not the receipt.
function PostAndPrint($fields) {
  $id = Post $fields
  $r = Receipt $id
  if ($null -eq $r) { Fail 'ADE non ha risposto: riprova tra poco' }
  if (-not $r.StartsWith('ok')) { Write-Output $r; exit 1 }
  $nl = $r.IndexOf("`n")
  if ($nl -ge 0) { Write-Output $r.Substring($nl + 1) } else { Write-Output $r }
  exit 0
}

# The answer to $id if it is there, claimed so nobody else takes it; $null if not yet.
function TakeResult($id) {
  $dir = Join-Path $box 'results'
  $ready = Join-Path $dir "$id.txt"
  $taken = Join-Path $dir "$id.taken"
  $typed = Join-Path $dir "$id.typed"
  if (Has $ready) {
    $claimed = $true
    try { Move-Item -LiteralPath $ready -Destination $taken -Force } catch { $claimed = $false }
    if ($claimed) {
      $r = [IO.File]::ReadAllText($taken, $utf8)
      Remove-Item -LiteralPath $taken -ErrorAction SilentlyContinue
      return $r
    }
  }
  if (Has $typed) {
    $r = [IO.File]::ReadAllText($typed, $utf8)
    Remove-Item -LiteralPath $typed -ErrorAction SilentlyContinue
    return $r
  }
  return $null
}

# Blocks until the answers arrive (all of them, or the first with --any) and prints them.
function AwaitIds([string[]]$ids) {
  $dir = Join-Path $box 'results'
  $pending = New-Object System.Collections.Generic.List[string]
  foreach ($id in $ids) { $pending.Add($id) }
  $multi = $ids.Count -gt 1
  $seen = @{}
  $deadline = [DateTime]::UtcNow.AddSeconds($timeout)
  while ($pending.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    foreach ($id in @($pending)) {
      # An update is not an answer, but it is the caller's turn: wake with it.
      $updateFile = Join-Path $dir "$id.update"
      if (Has $updateFile) {
        $claimed = Join-Path $dir "$id.update-taken"
        $ok = $true
        try { Move-Item -LiteralPath $updateFile -Destination $claimed -Force } catch { $ok = $false }
        if ($ok) {
          $u = [IO.File]::ReadAllText($claimed, $utf8)
          Remove-Item -LiteralPath $claimed -ErrorAction SilentlyContinue
          Write-Output $u
          $others = @($pending | Where-Object { $_ -ne $id })
          if ($others.Count -gt 0) { Write-Output "(ancora in attesa anche di: $($others -join ' '))" }
          exit 0
        }
      }
      $r = TakeResult $id
      $stateFile = Join-Path $dir "$id.state"
      if ($null -ne $r) {
        [void]$pending.Remove($id)
        Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue
        if ($multi) { Write-Output "=== risposta $id ===" }
        Write-Output $r
        if ($any) {
          if ($pending.Count -gt 0) { Write-Output "`n(ancora in attesa: $($pending -join ' ') - riprendi con: ade-msg wait $($pending -join ' '))" }
          exit 0
        }
        continue
      }
      if (Has $stateFile) {
        $s = $null
        try { $s = [IO.File]::ReadAllText($stateFile, $utf8).Trim() } catch {}
        if ($s -and $seen[$id] -ne $s) { $seen[$id] = $s; [Console]::Error.WriteLine("ade-msg: richiesta $id - $s") }
      }
    }
    if ($pending.Count -gt 0) { Start-Sleep -Milliseconds 250 }
  }
  if ($pending.Count -eq 0) { exit 0 }
  Write-Output "in corso: $($pending -join ' '). Non ripetere wait: la risposta ti arriva da sola nel terminale."
  exit 0
}

switch ($cmd) {
  'list' { $f = Join-Path $box 'sessions.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessuna sessione pubblicata' }; exit 0 }
  'agents' { $f = Join-Path $box 'agents.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessun agente pubblicato' }; exit 0 }
  'help' { $f = Join-Path $box 'usage.txt'; if (Has $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'uso: ade-msg list | send | ask | spawn | reply | wait | status | cancel | close | agents | whoami' }; exit 0 }
  'status' { $f = Join-Path $box 'requests.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessuna richiesta in corso' }; exit 0 }
  'whoami' { Write-Output $env:ADE_PANE_ID; exit 0 }
  'inbox' {
    # Prints the long messages left for this session, oldest first, and moves each to handled/: that move tells ADE it was read.
    if (-not $env:ADE_PANE_ID) { Fail 'ADE_PANE_ID mancante' }
    $dir = Join-Path (Join-Path $box 'inbox') $env:ADE_PANE_ID
    $files = @()
    try { $files = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction Stop | Where-Object { $_.Extension -eq '.msg' } | Sort-Object Name) } catch {}
    if ($files.Count -eq 0) { Write-Output 'nessun messaggio in attesa'; exit 0 }
    $done = Join-Path $dir 'handled'
    if (-not (Test-Path -LiteralPath $done)) { [void](New-Item -ItemType Directory -Path $done) }
    foreach ($f in $files) {
      Write-Output ([IO.File]::ReadAllText($f.FullName, $utf8))
      Write-Output ''
      Move-Item -LiteralPath $f.FullName -Destination (Join-Path $done $f.Name) -Force
    }
    exit 0
  }
  'who-owns' { if (-not $head) { Usage }; PostAndPrint ([ordered]@{ kind = 'whoowns'; text = (@($pos) -join ' ') }) }
  'stats' { $f = Join-Path $box 'stats.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessun dato di consumo ancora' }; exit 0 }
  'kv' {
    $op = $head
    switch ($op) {
      'get' { if (-not $second) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'get'; key = $second }) }
      'del' { if (-not $second) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'del'; key = $second }) }
      'list' { PostAndPrint ([ordered]@{ kind = 'kv'; op = 'list'; key = $second }) }
      'set' { if (-not $second -or -not $text) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'set'; key = $second; text = $text }) }
      'lock' { if (-not $second) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'lock'; key = $second; ttl = $ttl; text = $text }) }
      'unlock' { if (-not $second) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'unlock'; key = $second; force = $force }) }
      default { Usage }
    }
  }
  'memory' {
    switch ($head) {
      'add' { if (-not $second -or -not $text) { Usage }; PostAndPrint ([ordered]@{ kind = 'memory'; op = 'add'; type = $second; text = $text }) }
      'show' { PostAndPrint ([ordered]@{ kind = 'memory'; op = 'show' }) }
      default { Usage }
    }
  }
  'send' {
    if (-not $head -or -not $text) { Usage }
    PostAndConfirm ([ordered]@{ kind = 'send'; to = $head; text = $text })
  }
  'reply' {
    if (-not $head -or -not $text) { Usage }
    PostAndConfirm ([ordered]@{ kind = 'reply'; ref = $head; text = $text })
  }
  'cancel' {
    if ($head -notmatch '^[A-Za-z0-9_-]{1,80}$') { Usage }
    PostAndConfirm ([ordered]@{ kind = 'cancel'; ref = $head })
  }
  'update' {
    if ($head -notmatch '^[A-Za-z0-9_-]{1,80}$' -or ($second -ne 'bloccata' -and $second -ne 'decisione') -or -not $text) { Usage }
    PostAndConfirm ([ordered]@{ kind = 'update'; ref = $head; state = $second; text = $text })
  }
  'interrupt' {
    if (-not $head) { Usage }
    PostAndConfirm ([ordered]@{ kind = 'interrupt'; to = $head })
  }
  'close' {
    if (-not $head) { Usage }
    PostAndConfirm ([ordered]@{ kind = 'close'; to = $head; force = $force })
  }
  'relaunch' {
    if (-not $head) { Usage }
    $fields = [ordered]@{ kind = 'relaunch'; to = $head; fresh = $fresh; note = $(if ($note) { $note } else { $text }) }
    if ($model) { $fields['model'] = $model }
    if ($effort) { $fields['effort'] = $effort }
    PostAndConfirm $fields
  }
  { $_ -eq 'ask' -or $_ -eq 'spawn' } {
    if (-not $head -or -not $text) { Usage }
    if ($cmd -eq 'ask') {
      $fields = [ordered]@{ kind = 'ask'; to = $head; text = $text }
      if ($effort) { $fields['effort'] = $effort }
    } else {
      $fields = [ordered]@{ kind = 'spawn'; agent = $head; close = $close; worktree = $worktree; fork = $fork }
      if ($name) { $fields['name'] = $name }
      if ($model) { $fields['model'] = $model }
      if ($base) { $fields['base'] = $base }
      if ($effort) { $fields['effort'] = $effort }
      if ($profile) { $fields['profile'] = $profile }
      $fields['text'] = $text
    }
    $id = Post $fields
    $r = Receipt $id
    if ($null -ne $r -and -not $r.StartsWith('ok')) { Write-Output $r; exit 1 }
    $said = if ($null -eq $r) { 'in coda, ADE non l''ha ancora consegnata' } else { $r }
    if ($noWait) { Write-Output "id: $id - $said - attendi con: ade-msg wait $id"; exit 0 }
    [Console]::Error.WriteLine("ade-msg: $said (richiesta $id), in attesa della risposta...")
    AwaitIds @($id)
  }
  'wait' {
    if ($pos.Count -eq 0) { Usage }
    foreach ($id in $pos) { if ($id -notmatch '^[A-Za-z0-9_-]{1,80}$') { Fail "id non valido: $id" } }
    AwaitIds $pos.ToArray()
  }
  default { Usage }
}
"#;

/// Windows, for shells that look for `.cmd` (cmd, PowerShell via PATHEXT).
const CMD: &str = "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0ade-msg.ps1\" %*\r\n";

/// Git Bash on Windows (Claude Code's shell there) forwards to the PowerShell
/// script; on macOS and Linux it is the implementation.
const SH: &str = r#"#!/bin/sh
# ade-msg — talk to the other ADE sessions. Written by ADE; do not edit.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$(dirname "$0")/ade-msg.ps1" 2>/dev/null || echo "$(dirname "$0")/ade-msg.ps1")" "$@" ;;
esac
box="$ADE_MAILBOX"
if [ -z "$box" ] || [ ! -d "$box" ]; then echo "ade-msg: questa shell non e' una sessione avviata da ADE (ADE_MAILBOX mancante)." >&2; exit 2; fi
usage() { if [ -f "$box/usage.txt" ]; then cat "$box/usage.txt"; else echo "uso: ade-msg list | send | ask | spawn | reply | wait | status | cancel | close | agents | whoami"; fi; exit 1; }
fail() { echo "ade-msg: $1" >&2; exit 1; }
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r/\\r/g' | awk 'BEGIN{ORS="\\n"} {print}' | sed 's/\\n$//'; }
valid_id() { case "$1" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac; return 0; }

cmd="$1"; [ $# -gt 0 ] && shift
timeout=110; nowait=0; any=0; close=false; worktree=false; force=false; fresh=false; fork=false; ttl=0; name=""; model=""; base=""; note=""; effort=""; profile=""; file=""
lead=1; case "$cmd" in update|kv|memory) lead=2 ;; esac
n=0; head=""; second=""; text=""; ids=""
while [ $# -gt 0 ]; do
  a="$1"
  # Options anywhere: agents write them after the text as often as before it.
  if true; then
    case "$a" in
      --timeout) [ $# -ge 2 ] && { timeout="$2"; shift 2; continue; } ;;
      --file) [ $# -ge 2 ] && { file="$2"; shift 2; continue; } ;;
      --name) [ $# -ge 2 ] && { name="$2"; shift 2; continue; } ;;
      --model) [ $# -ge 2 ] && { model="$2"; shift 2; continue; } ;;
      --base) [ $# -ge 2 ] && { base="$2"; shift 2; continue; } ;;
      --note) [ $# -ge 2 ] && { note="$2"; shift 2; continue; } ;;
      --effort) [ $# -ge 2 ] && { effort="$2"; shift 2; continue; } ;;
      --profile) [ $# -ge 2 ] && { profile="$2"; shift 2; continue; } ;;
      --no-wait) nowait=1; shift; continue ;;
      --any) any=1; shift; continue ;;
      --close) close=true; shift; continue ;;
      --worktree) worktree=true; shift; continue ;;
      --force) force=true; shift; continue ;;
      --fresh) fresh=true; shift; continue ;;
      --fork) fork=true; shift; continue ;;
      --ttl) [ $# -ge 2 ] && { ttl="$2"; shift 2; continue; } ;;
    esac
  fi
  if [ $n -eq 0 ]; then head="$a"; elif [ $n -eq 1 ] && [ $lead -eq 2 ]; then second="$a"; else text="${text:+$text }$a"; fi
  ids="${ids:+$ids }$a"
  n=$((n+1)); shift
done

if [ -n "$file" ]; then
  [ -f "$file" ] || fail "file non trovato: $file"
  size=$(wc -c < "$file" | tr -d ' ')
  full="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  if [ "$size" -gt 40000 ]; then
    content="Il contenuto completo e' nel file $full ($size byte); leggilo da li'. Inizio:
$(head -c 1500 "$file")"
  else
    content="$(cat "$file")"
  fi
  if [ -n "$text" ]; then text="$text

$content"; else text="$content"; fi
fi

post() {
  id="$(date +%s)000-$$"
  if [ "${#text}" -gt 40000 ]; then
    long="$box/results/$id.long.txt"; printf '%s' "$text" > "$long"
    text="Testo completo (${#text} caratteri) in $long, leggilo da li'. Inizio: $(printf '%s' "$text" | head -c 1500)"
  fi
  printf '{"from":"%s","token":"%s",%s,"text":"%s"}' "$(esc "$ADE_PANE_ID")" "$(esc "$ADE_PANE_TOKEN")" "$1" "$(esc "$text")" > "$box/outbox/$id.part"
  mv "$box/outbox/$id.part" "$box/outbox/$id.json"
}
receipt() {
  r=""; i=0
  while [ $i -lt 50 ]; do
    if [ -f "$box/receipts/$id.txt" ]; then r="$(cat "$box/receipts/$id.txt")"; rm -f "$box/receipts/$id.txt"; return 0; fi
    sleep 0.2; i=$((i+1))
  done
  return 1
}
confirm() {
  post "$1"
  if receipt; then echo "$r"; case "$r" in ok*) exit 0 ;; *) exit 1 ;; esac; fi
  echo "in coda: ADE non ha ancora confermato"; exit 0
}
# Prints what ADE answered after its first line: the value, not the receipt.
show() {
  post "$1"
  receipt || fail "ADE non ha risposto: riprova tra poco"
  case "$r" in
    ok*) case "$r" in *"
"*) printf '%s\n' "${r#*
}" ;; *) printf '%s\n' "$r" ;; esac; exit 0 ;;
    *) echo "$r"; exit 1 ;;
  esac
}
take() {
  got=""
  if [ -f "$box/results/$1.txt" ] && mv "$box/results/$1.txt" "$box/results/$1.taken" 2>/dev/null; then
    got="$(cat "$box/results/$1.taken")"; rm -f "$box/results/$1.taken"; return 0
  fi
  if [ -f "$box/results/$1.typed" ]; then got="$(cat "$box/results/$1.typed")"; rm -f "$box/results/$1.typed"; return 0; fi
  return 1
}
await() {
  end=$(( $(date +%s) + timeout ))
  multi=0; [ $# -gt 1 ] && multi=1
  pending="$*"
  while [ -n "$pending" ] && [ "$(date +%s)" -lt "$end" ]; do
    still=""
    for rid in $pending; do
      if [ -f "$box/results/$rid.update" ] && mv "$box/results/$rid.update" "$box/results/$rid.update-taken" 2>/dev/null; then
        cat "$box/results/$rid.update-taken"; echo; rm -f "$box/results/$rid.update-taken"
        rest=""; for o in $pending; do [ "$o" != "$rid" ] && rest="${rest:+$rest }$o"; done
        [ -n "$rest" ] && echo "(ancora in attesa anche di: $rest)"
        exit 0
      fi
      if take "$rid"; then
        rm -f "$box/results/$rid.state"
        [ $multi = 1 ] && echo "=== risposta $rid ==="
        printf '%s\n' "$got"
        if [ $any = 1 ]; then
          rest=""; for o in $pending; do [ "$o" != "$rid" ] && rest="${rest:+$rest }$o"; done
          [ -n "$rest" ] && printf '\n(ancora in attesa: %s - riprendi con: ade-msg wait %s)\n' "$rest" "$rest"
          exit 0
        fi
      else
        still="${still:+$still }$rid"
        if [ -f "$box/results/$rid.state" ]; then
          s="$(cat "$box/results/$rid.state")"; key="seen_$(printf '%s' "$rid" | tr -c 'A-Za-z0-9_' '_')"
          eval "old=\"\${$key}\""
          if [ "$s" != "$old" ]; then eval "$key=\"\$s\""; echo "ade-msg: richiesta $rid - $s" >&2; fi
        fi
      fi
    done
    pending="$still"
    [ -n "$pending" ] && sleep 0.25
  done
  [ -z "$pending" ] && exit 0
  echo "in corso: $pending. Non ripetere wait: la risposta ti arriva da sola nel terminale."
  exit 0
}

case "$cmd" in
  list) if [ -f "$box/sessions.txt" ]; then cat "$box/sessions.txt"; else echo "nessuna sessione pubblicata"; fi ;;
  agents) if [ -f "$box/agents.txt" ]; then cat "$box/agents.txt"; else echo "nessun agente pubblicato"; fi ;;
  help) if [ -f "$box/usage.txt" ]; then cat "$box/usage.txt"; else echo "uso: ade-msg list | send | ask | spawn | reply | wait | status | cancel | close | agents | whoami"; fi ;;
  status) if [ -f "$box/requests.txt" ]; then cat "$box/requests.txt"; else echo "nessuna richiesta in corso"; fi ;;
  whoami) echo "$ADE_PANE_ID" ;;
  inbox)
    [ -n "$ADE_PANE_ID" ] || fail "ADE_PANE_ID mancante"
    dir="$box/inbox/$ADE_PANE_ID"; found=0
    for f in "$dir"/*.msg; do
      [ -f "$f" ] || continue
      found=1; mkdir -p "$dir/handled"; cat "$f"; printf '\n\n'; mv -f "$f" "$dir/handled/"
    done
    [ $found = 1 ] || echo "nessun messaggio in attesa" ;;
  who-owns) [ -n "$head" ] || usage; text="$head${text:+ $text}"; show "\"kind\":\"whoowns\"" ;;
  stats) if [ -f "$box/stats.txt" ]; then cat "$box/stats.txt"; else echo "nessun dato di consumo ancora"; fi ;;
  kv)
    key="\"key\":\"$(esc "$second")\""
    case "$head" in
      get|del) [ -n "$second" ] || usage; show "\"kind\":\"kv\",\"op\":\"$head\",$key" ;;
      list) show "\"kind\":\"kv\",\"op\":\"list\",$key" ;;
      set) [ -n "$second" ] && [ -n "$text" ] || usage; show "\"kind\":\"kv\",\"op\":\"set\",$key" ;;
      lock) [ -n "$second" ] || usage; show "\"kind\":\"kv\",\"op\":\"lock\",$key,\"ttl\":$(printf '%d' "$ttl" 2>/dev/null || echo 0)" ;;
      unlock) [ -n "$second" ] || usage; show "\"kind\":\"kv\",\"op\":\"unlock\",$key,\"force\":$force" ;;
      *) usage ;;
    esac ;;
  memory)
    case "$head" in
      add) [ -n "$second" ] && [ -n "$text" ] || usage; show "\"kind\":\"memory\",\"op\":\"add\",\"type\":\"$(esc "$second")\"" ;;
      show) show "\"kind\":\"memory\",\"op\":\"show\"" ;;
      *) usage ;;
    esac ;;
  send) [ -n "$head" ] && [ -n "$text" ] || usage; confirm "\"kind\":\"send\",\"to\":\"$(esc "$head")\"" ;;
  reply) [ -n "$head" ] && [ -n "$text" ] || usage; confirm "\"kind\":\"reply\",\"ref\":\"$(esc "$head")\"" ;;
  cancel) valid_id "$head" || usage; confirm "\"kind\":\"cancel\",\"ref\":\"$head\"" ;;
  update)
    valid_id "$head" || usage
    case "$second" in bloccata|decisione) ;; *) usage ;; esac
    [ -n "$text" ] || usage
    confirm "\"kind\":\"update\",\"ref\":\"$head\",\"state\":\"$second\"" ;;
  interrupt) [ -n "$head" ] || usage; confirm "\"kind\":\"interrupt\",\"to\":\"$(esc "$head")\"" ;;
  close) [ -n "$head" ] || usage; confirm "\"kind\":\"close\",\"to\":\"$(esc "$head")\",\"force\":$force" ;;
  relaunch)
    [ -n "$head" ] || usage
    extra=""; [ -n "$model" ] && extra=",\"model\":\"$(esc "$model")\""
    [ -n "$effort" ] && extra="$extra,\"effort\":\"$(esc "$effort")\""
    [ -n "$note" ] || note="$text"
    confirm "\"kind\":\"relaunch\",\"to\":\"$(esc "$head")\",\"fresh\":$fresh,\"note\":\"$(esc "$note")\"$extra" ;;
  ask|spawn)
    [ -n "$head" ] && [ -n "$text" ] || usage
    if [ "$cmd" = ask ]; then
      extra=""; [ -n "$effort" ] && extra=",\"effort\":\"$(esc "$effort")\""
      post "\"kind\":\"ask\",\"to\":\"$(esc "$head")\"$extra"
    else
      extra=""
      [ -n "$name" ] && extra="$extra,\"name\":\"$(esc "$name")\""
      [ -n "$model" ] && extra="$extra,\"model\":\"$(esc "$model")\""
      [ -n "$base" ] && extra="$extra,\"base\":\"$(esc "$base")\""
      [ -n "$effort" ] && extra="$extra,\"effort\":\"$(esc "$effort")\""
      [ -n "$profile" ] && extra="$extra,\"profile\":\"$(esc "$profile")\""
      post "\"kind\":\"spawn\",\"agent\":\"$(esc "$head")\",\"close\":$close,\"worktree\":$worktree,\"fork\":$fork$extra"
    fi
    if receipt; then
      case "$r" in ok*) said="$r" ;; *) echo "$r"; exit 1 ;; esac
    else
      said="in coda, ADE non l'ha ancora consegnata"
    fi
    if [ $nowait = 1 ]; then echo "id: $id - $said - attendi con: ade-msg wait $id"; exit 0; fi
    echo "ade-msg: $said (richiesta $id), in attesa della risposta..." >&2
    await "$id" ;;
  wait)
    [ -n "$ids" ] || usage
    for rid in $ids; do valid_id "$rid" || fail "id non valido: $rid"; done
    await $ids ;;
  *) usage ;;
esac
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * The whole channel rests on this: the PATH set on the builder is the one
     * the child sees. On Windows the inherited variable is spelled `Path`, and
     * a second `PATH` entry beside it would be a coin toss for the child.
     */
    #[cfg(windows)]
    #[test]
    fn a_session_finds_ade_msg_on_its_path() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;

        let bin = std::env::temp_dir().join(format!("ade-msg-path-{}", std::process::id()));
        fs::create_dir_all(&bin).expect("a directory");
        fs::write(bin.join("ade-msg-probe.cmd"), "@echo off\r\necho found-it\r\n").expect("a script");

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: 24, cols: 200, pixel_width: 0, pixel_height: 0 })
            .expect("a pty");
        let mut builder = CommandBuilder::new("cmd.exe");
        builder.args(["/c", "ade-msg-probe"]);
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut parts = vec![bin.clone()];
        parts.extend(std::env::split_paths(&path));
        builder.env("PATH", std::env::join_paths(parts).expect("a PATH"));

        let mut child = pair.slave.spawn_command(builder).expect("cmd starts");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("a reader");
        let collector = std::thread::spawn(move || {
            let mut out = String::new();
            let mut buf = [0u8; 4096];
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(10) {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        out.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if out.contains("found-it") {
                            break;
                        }
                    }
                }
            }
            out
        });
        let _ = child.wait();
        drop(pair.master);
        let out = collector.join().expect("output");
        let _ = fs::remove_dir_all(&bin);
        assert!(out.contains("found-it"), "the child did not find the script: {out}");
    }

    #[test]
    fn who_owns_takes_the_whole_path_in_both_scripts() {
        // A path with a space, unquoted, arrives as two words: both must reach the lookup.
        assert!(SH.contains("who-owns) [ -n \"$head\" ] || usage; text=\"$head${text:+ $text}\""));
        assert!(PS1.contains("text = (@($pos) -join ' ')"));
    }

    #[test]
    fn a_long_multibyte_message_passes_and_an_oversized_one_is_answered() {
        let base = std::env::current_dir().unwrap().join("target").join("mailbox-take-test");
        let _ = fs::remove_dir_all(&base);
        let (outbox, receipts) = (base.join("outbox"), base.join("receipts"));
        fs::create_dir_all(&outbox).unwrap();
        fs::create_dir_all(&receipts).unwrap();

        // 40,000 characters of four bytes each: the longest the frontend accepts, 160 KiB on disk.
        let text: String = std::iter::repeat('\u{1F600}').take(40_000).collect();
        fs::write(outbox.join("1757860000000-aaaa.json"), format!("{{\"kind\":\"send\",\"to\":\"1\",\"text\":\"{text}\"}}")).unwrap();
        fs::write(outbox.join("1757860000000-bbbb.json"), "x".repeat(MAX_MESSAGE_BYTES as usize + 1)).unwrap();

        let taken = take_outbox(&outbox, &receipts).unwrap();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].id, "1757860000000-aaaa");
        assert!(taken[0].body.contains(&text));
        let receipt = fs::read_to_string(receipts.join("1757860000000-bbbb.txt")).unwrap();
        assert!(receipt.starts_with("errore: messaggio troppo grande"));
        assert!(!receipts.join("1757860000000-aaaa.txt").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_size_that_cannot_be_read_is_not_said_as_zero() {
        assert!(too_big_receipt(Some(300 * 1024)).contains("(300 KiB, massimo 256 KiB)"));
        let unknown = too_big_receipt(None);
        assert!(unknown.starts_with("errore: dimensione del messaggio non leggibile"));
        assert!(!unknown.contains("0 KiB,"));
    }

    #[test]
    fn only_a_test_build_moves_the_mailbox_and_only_to_an_absolute_folder() {
        let default = Some(PathBuf::from("default"));
        let absolute = if cfg!(windows) { "C:\\w\\.ade-test\\mailbox" } else { "/w/.ade-test/mailbox" };
        let env = || Some(std::ffi::OsString::from(absolute));
        assert_eq!(choose_root(true, env(), default.clone()), Some(PathBuf::from(absolute)));
        assert_eq!(choose_root(false, env(), default.clone()), default);
        assert_eq!(choose_root(true, Some("relativa".into()), default.clone()), default);
        assert_eq!(choose_root(true, None, default.clone()), default);
    }

    #[test]
    fn both_scripts_read_the_inbox_and_move_what_they_print() {
        assert!(PS1.contains("'inbox' {") && PS1.contains("Join-Path $dir 'handled'"));
        assert!(SH.contains("  inbox)") && SH.contains("mv -f \"$f\" \"$dir/handled/\""));
        assert!(!PS1.contains("3800") && !SH.contains("3800"));
        assert!(PS1.contains("kind = 'interrupt'") && SH.contains("interrupt) [ -n"));
        assert!(PS1.contains("$fields['effort'] = $effort") && SH.contains("--effort)") && SH.contains("--profile)"));
        assert!(PS1.contains("--note") && SH.contains("\\\"note\\\":"));
    }

    #[test]
    fn a_message_id_cannot_become_a_path() {
        assert!(valid_id("1757860000000-ab12cd34"));
        assert!(valid_id("1757860000000-4242"));
        for bad in ["", "../x", "a/b", "a\\b", "a.json", &"1".repeat(81)] {
            assert!(!valid_id(bad), "{bad} was accepted");
        }
    }
}

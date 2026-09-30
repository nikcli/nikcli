use crate::repo;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};

#[derive(Default)]
pub struct Tasks(pub Arc<Mutex<HashMap<String, u32>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTask {
    pub id: String,
    /// Repo-relative working directory, e.g. `packages/nikcli`.
    pub cwd: String,
    /// Always run through bun; the first arg is the bun subcommand (`test`, `run`, ...).
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Serialize, Clone)]
pub struct Line {
    pub stream: &'static str,
    pub line: String,
}

/// Streamed to the webview over a dedicated IPC channel: ordered, and lines are
/// delivered in batches so a chatty test run does not flood the bridge.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskEvent {
    Lines {
        lines: Vec<Line>,
    },
    #[serde(rename_all = "camelCase")]
    Exit {
        code: Option<i32>,
        duration_ms: u64,
        cancelled: bool,
    },
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SUBCOMMANDS: &[&str] = &["test", "run", "x"];
const BATCH: usize = 400;

fn pump<R: AsyncRead + Unpin + Send + 'static>(
    reader: R,
    stream: &'static str,
    tx: mpsc::UnboundedSender<Line>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(Line { stream, line }).is_err() {
                break;
            }
        }
    })
}

#[tauri::command]
pub async fn task_start(
    tasks: State<'_, Tasks>,
    req: StartTask,
    on_event: Channel<TaskEvent>,
) -> Result<u32, String> {
    if req.args.first().map(|a| SUBCOMMANDS.contains(&a.as_str())) != Some(true) {
        return Err("only `bun test`, `bun run` and `bun x` are allowed".into());
    }
    let cwd = repo::resolve(&req.cwd)?;
    // Scratch space for run artefacts (junit reports, perf probes, playground scripts).
    let _ = std::fs::create_dir_all(repo::root()?.join(".devhub"));
    let mut cmd = Command::new("bun");
    cmd.args(&req.args)
        .current_dir(cwd)
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in &req.env {
        if k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            cmd.env(k, v);
        }
    }
    #[cfg(unix)]
    cmd.process_group(0);
    // A GUI app must not flash a console window for every `bun` it starts.
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start bun: {e}"))?;
    let pid = child.id().ok_or("process exited immediately")?;
    tasks.0.lock().await.insert(req.id.clone(), pid);

    let registry = tasks.0.clone();
    let id = req.id.clone();
    let (tx, mut rx) = mpsc::unbounded_channel::<Line>();
    let readers: Vec<_> = [
        child.stdout.take().map(|r| pump(r, "stdout", tx.clone())),
        child.stderr.take().map(|r| pump(r, "stderr", tx.clone())),
    ]
    .into_iter()
    .flatten()
    .collect();
    drop(tx);

    // Forwarder: block for one line, then drain whatever else is already queued.
    let lines_channel = on_event.clone();
    let forward = tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut batch = vec![first];
            while batch.len() < BATCH {
                match rx.try_recv() {
                    Ok(l) => batch.push(l),
                    Err(_) => break,
                }
            }
            if lines_channel
                .send(TaskEvent::Lines { lines: batch })
                .is_err()
            {
                break;
            }
        }
    });

    tokio::spawn(async move {
        let started = Instant::now();
        let status = child.wait().await.ok();
        for r in readers {
            let _ = r.await;
        }
        let _ = forward.await;
        let cancelled = registry.lock().await.remove(&id).is_none();
        let _ = on_event.send(TaskEvent::Exit {
            code: status.and_then(|s| s.code()),
            duration_ms: started.elapsed().as_millis() as u64,
            cancelled,
        });
    });
    Ok(pid)
}

/// Stops the task and everything it spawned (bun runs in its own process group).
#[tauri::command]
pub async fn task_cancel(tasks: State<'_, Tasks>, id: String) -> Result<(), String> {
    let pid = tasks
        .0
        .lock()
        .await
        .remove(&id)
        .ok_or("task is not running")?;
    #[cfg(unix)]
    {
        let status = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("kill failed".into());
        }
    }
    #[cfg(windows)]
    {
        Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

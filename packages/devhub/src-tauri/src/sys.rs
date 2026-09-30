use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use sysinfo::{
    Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, Signal, System, UpdateKind,
};
use tauri::ipc::Channel;
use tauri::Manager;

pub struct SysState(pub Mutex<System>);

impl SysState {
    pub fn new() -> Self {
        let mut sys = System::new_with_specifics(RefreshKind::everything());
        sys.refresh_all();
        Self(Mutex::new(sys))
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub exe: Option<String>,
    pub cmd: String,
    pub cwd: Option<String>,
    pub category: &'static str,
    pub cpu: f32,
    pub rss: u64,
    pub virt: u64,
    pub runtime: u64,
    pub started: u64,
    pub status: String,
    pub read_bytes: u64,
    pub written_bytes: u64,
    pub threads: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub at: u64,
    pub host: Option<String>,
    pub os: Option<String>,
    pub uptime: u64,
    pub cpu_count: usize,
    pub cpu_usage: f32,
    pub load: [f64; 3],
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub procs: Vec<ProcInfo>,
}

fn basename(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

/// Which part of nikcli (if any) a process belongs to. Being *inside the repo directory* is not
/// enough — Vite, esbuild or an editor helper running there are not nikcli processes.
fn classify(name: &str, cmd: &str, exe: &str, cwd: &str) -> Option<&'static str> {
    // Windows paths use backslashes and `.exe`; match on one normalised form.
    let norm = |s: &str| s.replace('\\', "/").to_lowercase();
    let (low_cmd, exe, cwd) = (norm(cmd), norm(exe), norm(cwd));
    let first = low_cmd.split_whitespace().next().unwrap_or("");
    let bin = basename(if exe.is_empty() { first } else { exe.as_str() })
        .trim_end_matches(".exe")
        .to_string();
    let mentions = format!("{low_cmd} {exe} {cwd}").contains("nikcli");
    if !mentions && bin != "nikcli" {
        return None;
    }
    if bin.starts_with("nikcli-devhub")
        || low_cmd.contains("packages/devhub")
        || cwd.contains("packages/devhub")
    {
        return Some("devhub");
    }
    let hay = format!("{} {low_cmd}", name.to_lowercase());
    if hay.contains("helper")
        && (hay.contains("cursor") || hay.contains("code") || hay.contains("electron"))
        || hay.contains("extension-host")
    {
        return Some("editor");
    }
    let serves = low_cmd.split_whitespace().any(|t| t == "serve");
    if bin == "nikcli" || bin.starts_with("nikcli-") {
        return Some(if serves {
            if low_cmd.contains("--service") {
                "service"
            } else {
                "server"
            }
        } else {
            "cli"
        });
    }
    if bin == "bun" || bin.starts_with("bun-") {
        if serves {
            return Some(if low_cmd.contains("--service") {
                "service"
            } else {
                "server"
            });
        }
        let args: Vec<&str> = low_cmd.split_whitespace().collect();
        if args.iter().any(|t| *t == "test" || t.contains("bench")) {
            return Some("test");
        }
        return Some("dev");
    }
    Some("other")
}

fn collect(sys: &System) -> Vec<ProcInfo> {
    let mut base: HashMap<u32, (&'static str, ProcInfo)> = HashMap::new();
    let mut all: HashMap<u32, Option<u32>> = HashMap::new();
    for (pid, p) in sys.processes() {
        all.insert(pid.as_u32(), p.parent().map(|x| x.as_u32()));
        let name = p.name().to_string_lossy().to_string();
        let cmd = p
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let exe = p.exe().map(|e| e.to_string_lossy().to_string());
        let cwd = p.cwd().map(|c| c.to_string_lossy().to_string());
        let Some(cat) = classify(
            &name,
            &cmd,
            exe.as_deref().unwrap_or(""),
            cwd.as_deref().unwrap_or(""),
        ) else {
            continue;
        };
        let du = p.disk_usage();
        base.insert(
            pid.as_u32(),
            (
                cat,
                ProcInfo {
                    pid: pid.as_u32(),
                    parent: p.parent().map(|x| x.as_u32()),
                    name,
                    exe,
                    cmd,
                    cwd,
                    category: cat,
                    cpu: p.cpu_usage(),
                    rss: p.memory(),
                    virt: p.virtual_memory(),
                    runtime: p.run_time(),
                    started: p.start_time(),
                    status: format!("{:?}", p.status()),
                    read_bytes: du.total_read_bytes,
                    written_bytes: du.total_written_bytes,
                    threads: p.tasks().map(|t| t.len() as u32),
                },
            ),
        );
    }
    // Descendants of service/server/cli/test/dev processes (MCP servers, LSPs, shells) are nikcli's too.
    let roots: HashSet<u32> = base
        .iter()
        .filter(|(_, (c, _))| matches!(*c, "service" | "server" | "cli" | "test" | "dev"))
        .map(|(pid, _)| *pid)
        .collect();
    let mut children: Vec<u32> = vec![];
    for (pid, parent) in &all {
        if base.contains_key(pid) {
            continue;
        }
        let mut cur = *parent;
        let mut hops = 0;
        while let Some(pp) = cur {
            if roots.contains(&pp) {
                children.push(*pid);
                break;
            }
            hops += 1;
            if hops > 32 {
                break;
            }
            cur = all.get(&pp).copied().flatten();
        }
    }
    let mut out: Vec<ProcInfo> = base.into_values().map(|(_, p)| p).collect();
    for pid in children {
        let Some(p) = sys.process(Pid::from_u32(pid)) else {
            continue;
        };
        let du = p.disk_usage();
        out.push(ProcInfo {
            pid,
            parent: p.parent().map(|x| x.as_u32()),
            name: p.name().to_string_lossy().to_string(),
            exe: p.exe().map(|e| e.to_string_lossy().to_string()),
            cmd: p
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            cwd: p.cwd().map(|c| c.to_string_lossy().to_string()),
            category: "child",
            cpu: p.cpu_usage(),
            rss: p.memory(),
            virt: p.virtual_memory(),
            runtime: p.run_time(),
            started: p.start_time(),
            status: format!("{:?}", p.status()),
            read_bytes: du.total_read_bytes,
            written_bytes: du.total_written_bytes,
            threads: p.tasks().map(|t| t.len() as u32),
        });
    }
    out.sort_by(|a, b| b.rss.cmp(&a.rss));
    out
}

fn refresh(sys: &mut System) {
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_disk_usage()
            .with_cmd(UpdateKind::Always)
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet),
    );
}

fn build_snapshot(sys: &mut System) -> Snapshot {
    refresh(sys);
    let load = System::load_average();
    Snapshot {
        at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        host: System::host_name(),
        os: System::long_os_version(),
        uptime: System::uptime(),
        cpu_count: sys.cpus().len(),
        cpu_usage: sys.global_cpu_usage(),
        load: [load.one, load.five, load.fifteen],
        mem_total: sys.total_memory(),
        mem_used: sys.used_memory(),
        swap_total: sys.total_swap(),
        swap_used: sys.used_swap(),
        procs: collect(sys),
    }
}

#[tauri::command]
pub fn system_snapshot(state: tauri::State<SysState>) -> Snapshot {
    build_snapshot(&mut state.0.lock().unwrap())
}

const OWN: &[&str] = &["service", "server", "cli", "test", "dev", "child"];

fn fmt_bytes(n: u64) -> String {
    let mb = n as f64 / 1_048_576.0;
    if mb >= 1024.0 {
        format!("{:.1} GB", mb / 1024.0)
    } else {
        format!("{:.0} MB", mb)
    }
}

/// Streams a fresh snapshot over `on_snapshot` every `interval_ms` until the webview drops the channel.
/// One native sampler replaces per-tick IPC polling, and keeps the tray title live.
#[tauri::command]
pub fn system_subscribe(app: tauri::AppHandle, on_snapshot: Channel<Snapshot>, interval_ms: u64) {
    let every = std::time::Duration::from_millis(interval_ms.clamp(500, 30_000));
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(every);
        loop {
            ticker.tick().await;
            let snap = {
                let state = app.state::<SysState>();
                let mut sys = state.0.lock().unwrap();
                build_snapshot(&mut sys)
            };
            let (n, rss) = snap
                .procs
                .iter()
                .filter(|p| OWN.contains(&p.category))
                .fold((0usize, 0u64), |(n, r), p| (n + 1, r + p.rss));
            if let Some(tray) = app.tray_by_id("main") {
                let _ =
                    tray.set_tooltip(Some(format!("nikcli · {n} processes · {}", fmt_bytes(rss))));
                #[cfg(target_os = "macos")]
                let _ = tray.set_title(Some(fmt_bytes(rss)));
            }
            if on_snapshot.send(snap).is_err() {
                break;
            }
        }
    });
}

/// Only processes classified as nikcli's (or their descendants) can be signalled.
#[tauri::command]
pub fn kill_process(state: tauri::State<SysState>, pid: u32, force: bool) -> Result<(), String> {
    let mut sys = state.0.lock().unwrap();
    refresh(&mut sys);
    if !collect(&sys)
        .iter()
        .any(|p| p.pid == pid && p.category != "editor" && p.category != "devhub")
    {
        return Err("not a nikcli process".into());
    }
    let proc = sys.process(Pid::from_u32(pid)).ok_or("process is gone")?;
    let sent = if force {
        proc.kill()
    } else {
        proc.kill_with(Signal::Term).unwrap_or_else(|| proc.kill())
    };
    if sent {
        Ok(())
    } else {
        Err("signal was not delivered".into())
    }
}

#[cfg(test)]
mod tests {
    use super::classify;

    const REPO: &str = "/Volumes/SSD/Projects/nikcli";

    #[test]
    fn classifies_real_world_processes() {
        // the installed background service
        assert_eq!(
            classify(
                "nikcli",
                "/Users/u/.nikcli/bin/nikcli serve --service --port 49374 --hostname 127.0.0.1",
                "/Users/u/.nikcli/bin/nikcli",
                "/"
            ),
            Some("service")
        );
        // the TUI
        assert_eq!(
            classify("nikcli", "nikcli", "/Users/u/.nikcli/bin/nikcli", REPO),
            Some("cli")
        );
        // a dev run from source and a test run
        assert_eq!(
            classify(
                "bun",
                "bun run --cwd packages/nikcli src/index.ts",
                "/Users/u/.bun/bin/bun",
                REPO
            ),
            Some("dev")
        );
        assert_eq!(
            classify(
                "bun",
                "bun test --timeout 30000 test/a.test.ts",
                "/Users/u/.bun/bin/bun",
                "/Volumes/SSD/Projects/nikcli/packages/nikcli"
            ),
            Some("test")
        );
        assert_eq!(
            classify("bun", "bun serve", "/Users/u/.bun/bin/bun", REPO),
            Some("server")
        );
    }

    #[test]
    fn repo_location_alone_is_not_nikcli() {
        // esbuild / vite running inside the repo are tooling, not nikcli
        assert_eq!(
            classify("esbuild", "/Volumes/SSD/Projects/nikcli/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25 --ping", "/Volumes/SSD/Projects/nikcli/node_modules/@esbuild/darwin-arm64/bin/esbuild", REPO),
            Some("other")
        );
        // editor helpers with the repo open
        assert_eq!(
            classify(
                "Cursor Helper (Plugin)",
                "Cursor Helper (Plugin): extension-host (user) nikcli [1-1]",
                "/Applications/Cursor.app/x",
                "/"
            ),
            Some("editor")
        );
        // unrelated processes
        assert_eq!(
            classify(
                "Finder",
                "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
                "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
                "/"
            ),
            None
        );
    }

    #[test]
    fn windows_paths_and_exe_suffix_classify_the_same() {
        assert_eq!(
            classify(
                "nikcli.exe",
                r"C:\Users\u\.nikcli\bin\nikcli.exe serve --service --port 49374",
                r"C:\Users\u\.nikcli\bin\nikcli.exe",
                r"C:\"
            ),
            Some("service")
        );
        assert_eq!(
            classify(
                "nikcli-devhub.exe",
                r"C:\src\nikcli\packages\devhub\src-tauri\target\debug\nikcli-devhub.exe",
                r"C:\src\nikcli\packages\devhub\src-tauri\target\debug\nikcli-devhub.exe",
                r"C:\src\nikcli"
            ),
            Some("devhub")
        );
        assert_eq!(
            classify(
                "bun.exe",
                r"bun.exe test --timeout 30000",
                r"C:\Users\u\.bun\bin\bun.exe",
                r"C:\src\nikcli\packages\nikcli"
            ),
            Some("test")
        );
    }

    #[test]
    fn devhub_own_processes_are_separate() {
        assert_eq!(
            classify(
                "nikcli-devhub",
                "target/debug/nikcli-devhub",
                "/Volumes/SSD/Projects/nikcli/packages/devhub/src-tauri/target/debug/nikcli-devhub",
                REPO
            ),
            Some("devhub")
        );
        assert_eq!(
            classify(
                "node",
                "node /Volumes/SSD/Projects/nikcli/packages/devhub/node_modules/.bin/vite",
                "/usr/local/bin/node",
                "/Volumes/SSD/Projects/nikcli/packages/devhub"
            ),
            Some("devhub")
        );
    }
}

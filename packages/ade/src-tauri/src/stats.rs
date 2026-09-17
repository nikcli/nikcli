//! What the machine is spending, for the strip at the foot of the sidebar.
//!
//! Three numbers: the CPU in use across all cores, the RAM in use on the
//! machine, and the memory ADE itself holds — the app, its webview and every
//! agent it started, because those are what a user closes panes to get back.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/*
 * How long the list of ADE's processes is trusted before it is rebuilt.
 *
 * The strip asks every two seconds, and finding out which processes are ADE's
 * means refreshing every process on the machine and walking each one's parent
 * chain — several hundred processes, each opened and queried, to report on the
 * dozen that matter. Between rebuilds only that dozen is refreshed.
 *
 * The cost of the wait is a pane opened a moment ago that is not in the count
 * yet. Ten seconds is short enough that nobody watching the strip for it will
 * still be watching, and long enough that four calls in five are cheap.
 */
const RESCAN_EVERY: Duration = Duration::from_secs(10);

/// One `System` for the life of the app: CPU usage is a difference between
/// two refreshes, so a fresh instance per call would always read zero.
pub struct Stats(Mutex<Sampler>);

struct Sampler {
    sys: System,
    /// ADE's processes as of the last full scan, `me` included.
    family: Vec<Pid>,
    /// When that scan ran; `None` until the first call.
    scanned_at: Option<Instant>,
}

impl Stats {
    pub fn new() -> Self {
        Stats(Mutex::new(Sampler {
            sys: System::new(),
            family: Vec::new(),
            scanned_at: None,
        }))
    }
}

/// Only ADE: this process and everything it started — the webview, the
/// agents in the panes, their own children. The machine's totals appear
/// only as the denominator for the percentages.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// CPU used by ADE's processes, 0–100 of the whole machine's capacity.
    cpu: f32,
    /// Resident memory of ADE's processes, in bytes.
    app_mem: u64,
    /// The machine's RAM, in bytes — what `app_mem` is a share of.
    ram_total: u64,
    /// How many processes belong to ADE right now.
    processes: u32,
}

#[tauri::command]
pub fn system_stats(stats: tauri::State<'_, Stats>) -> Result<SystemStats, String> {
    let mut sampler = stats.0.lock().map_err(|_| "statistiche bloccate")?;
    let sampler = &mut *sampler;
    sampler.sys.refresh_memory();

    let me = Pid::from_u32(std::process::id());
    let kind = ProcessRefreshKind::nothing().with_memory().with_cpu();
    let now = Instant::now();

    if rescan_due(sampler.scanned_at, now) {
        // Per-process CPU is a difference between this refresh and the
        // previous one, which is why the `System` lives in managed state.
        sampler.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        sampler.family = family_of(&sampler.sys, me);
        sampler.scanned_at = Some(now);
    } else {
        /*
         * Only the processes already known to be ADE's. Their CPU reading is
         * still a difference against their own previous refresh — every one of
         * them was refreshed on the last call too, cheap or full — so the
         * number means the same thing on both paths. A pid in the list that
         * has exited is dropped by the refresh and simply not found below.
         */
        sampler
            .sys
            .refresh_processes_specifics(ProcessesToUpdate::Some(&sampler.family), true, kind);
    }

    let mut cpu = 0.0_f32;
    let mut app_mem = 0_u64;
    let mut processes = 0_u32;
    for pid in &sampler.family {
        let Some(process) = sampler.sys.process(*pid) else {
            continue;
        };
        cpu += process.cpu_usage();
        app_mem += process.memory();
        processes += 1;
    }

    // `cpu_usage` is per core: a process saturating two cores reads 200.
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;

    Ok(SystemStats {
        cpu: (cpu / cores).clamp(0.0, 100.0),
        app_mem,
        ram_total: sampler.sys.total_memory(),
        processes,
    })
}

/// True when the list of ADE's processes is missing or old enough to rebuild.
fn rescan_due(scanned_at: Option<Instant>, now: Instant) -> bool {
    match scanned_at {
        None => true,
        Some(at) => now.saturating_duration_since(at) >= RESCAN_EVERY,
    }
}

/// Every process in `sys` that is `root` or was started under it.
fn family_of(sys: &System, root: Pid) -> Vec<Pid> {
    sys.processes()
        .keys()
        .copied()
        .filter(|pid| descends_from(sys, *pid, root))
        .collect()
}

/// True for `root` itself and anything started under it, however deep.
fn descends_from(sys: &System, pid: Pid, root: Pid) -> bool {
    let mut current = Some(pid);
    // Bounded: a pid reused by an unrelated process can make a parent chain
    // loop, and a loop here would hang the command.
    for _ in 0..64 {
        match current {
            Some(p) if p == root => return true,
            Some(p) => current = sys.process(p).and_then(|process| process.parent()),
            None => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_call_always_scans() {
        // Nothing is known yet, so a cheap pass would report zero processes.
        assert!(rescan_due(None, Instant::now()));
    }

    #[test]
    fn a_recent_scan_is_trusted_and_an_old_one_is_not() {
        let at = Instant::now();
        assert!(!rescan_due(Some(at), at));
        assert!(!rescan_due(Some(at), at + Duration::from_secs(2)));
        assert!(rescan_due(Some(at), at + RESCAN_EVERY));
    }

    #[test]
    fn the_family_includes_this_process() {
        // Not a race: whatever else the machine is running, this test's own
        // process exists for as long as the test does.
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        let me = Pid::from_u32(std::process::id());
        assert!(family_of(&sys, me).contains(&me));
    }
}

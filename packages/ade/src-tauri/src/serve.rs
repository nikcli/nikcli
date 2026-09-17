/// The nikcli server ADE talks to.
///
/// ADE drives agent CLIs through a pty, which is right for a terminal and
/// useless for anything that needs structure: the chat section and the voice
/// assistant both want sessions, messages, models and permissions as data, not
/// as bytes on a screen. nikcli already serves exactly that over HTTP, so ADE
/// starts one and uses the SDK against it.
///
/// This lives in Rust because the obvious alternative does not work. The SDK's
/// own `createNikcliServer` spawns with `node:child_process`, and there is no
/// such thing inside a WebView2 renderer. The renderer gets a URL from here and
/// speaks plain `fetch` to it from then on.
///
/// One server per window, owned by the window: started on demand, killed when
/// ADE exits. It is deliberately not the `pty_spawn` path — that one hands a
/// terminal to a human, and this one is a background service whose stdout is a
/// protocol.
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Condvar, Mutex, MutexGuard,
    mpsc::{RecvTimeoutError, channel},
};
use std::time::Duration;

use tauri::Manager;

use crate::pty::which_on_path;

/*
 * How long to wait for the server to announce itself.
 *
 * Generous, and it has to be: `nikcli serve` loads the config chain, the
 * project and the provider list before it binds, and on a cold start with a
 * large workspace that is comfortably past ten seconds. A timeout that fires
 * early does not fail safely — it leaves an orphan server running on a port
 * nobody recorded.
 */
const READY_TIMEOUT: Duration = Duration::from_secs(45);

/// The line `serve` prints once it is actually listening.
const READY_PREFIX: &str = "nikcli server listening";

struct Serving {
    url: String,
    child: Child,
}

/*
 * Three states, not two, because starting takes time.
 *
 * With a plain `Option<Serving>` the only way to keep two callers from
 * starting two servers was to hold the mutex for the whole start-up — the
 * forty-five second wait included. `Starting` says "one is on its way" out
 * loud, so the second caller waits on the condvar with the lock released
 * instead of blocking every other command behind it.
 */
enum Slot {
    Idle,
    Starting,
    Running(Serving),
}

pub struct Server {
    slot: Mutex<Slot>,
    /// Signalled whenever the slot stops being `Starting`.
    settled: Condvar,
}

impl Default for Server {
    fn default() -> Self {
        Self {
            slot: Mutex::new(Slot::Idle),
            settled: Condvar::new(),
        }
    }
}

impl Server {
    /// The slot, taking the guard even from a poisoned lock.
    ///
    /// A poisoned lock means a thread panicked while holding it. The child on
    /// the other side still has to be reachable — refusing the guard would
    /// leave a live server nobody can stop.
    fn lock(&self) -> MutexGuard<'_, Slot> {
        match self.slot.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Kills the server, if one is running. Safe to call more than once.
    ///
    /// A start in flight is cancelled rather than waited for: the slot goes
    /// back to `Idle`, and the starter — which checks that its claim survived
    /// before installing anything — kills the child it just started.
    pub fn shutdown(&self) {
        {
            let mut slot = self.lock();
            if let Slot::Running(mut serving) = std::mem::replace(&mut *slot, Slot::Idle) {
                let _ = serving.child.kill();
                let _ = serving.child.wait();
            }
        }
        self.settled.notify_all();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.slot.lock() {
            if let Slot::Running(mut serving) = std::mem::replace(&mut *slot, Slot::Idle) {
                let _ = serving.child.kill();
                let _ = serving.child.wait();
            }
        }
    }
}

/// Releases the `Starting` claim however the start-up ends, exception or
/// early return included. Without it one failed attempt would leave every
/// later caller waiting on a server nobody is starting.
struct Claim<'a>(&'a Server);

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        {
            let mut slot = self.0.lock();
            if matches!(*slot, Slot::Starting) {
                *slot = Slot::Idle;
            }
        }
        self.0.settled.notify_all();
    }
}

/// Reads `url` out of the readiness line, which carries it whole.
fn parse_ready_line(line: &str) -> Option<String> {
    if !line.starts_with(READY_PREFIX) {
        return None;
    }
    let start = line.find("http://").or_else(|| line.find("https://"))?;
    let url = line[start..].split_whitespace().next()?;
    Some(url.trim_end_matches('/').to_string())
}

/// True when the child is still running, rather than merely still in the map.
fn still_alive(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

/// Takes the right to start a server, or reports what is already there.
///
/// Returns `Ok(Some(url))` when a live server answers the question outright
/// and `Ok(None)` when the caller now holds the `Starting` claim and must go
/// on to spawn one. The lock is held only while deciding; the wait for
/// somebody else's start-up happens on the condvar, with the lock released.
fn claim_start(server: &Server) -> Result<Option<String>, String> {
    enum Step {
        Ready(String),
        Reap,
        Wait,
        Claim,
    }

    let mut slot = server.lock();
    loop {
        // Decided first and acted on after, so the borrow of the slot ends
        // before an arm that moves out of it or hands the guard to the condvar.
        let step = match &mut *slot {
            Slot::Running(serving) => {
                if still_alive(&mut serving.child) {
                    Step::Ready(serving.url.clone())
                } else {
                    Step::Reap
                }
            }
            Slot::Starting => Step::Wait,
            Slot::Idle => Step::Claim,
        };

        match step {
            Step::Ready(url) => return Ok(Some(url)),
            // A dead child left behind: reap it before starting another.
            Step::Reap => {
                if let Slot::Running(mut dead) = std::mem::replace(&mut *slot, Slot::Idle) {
                    let _ = dead.child.wait();
                }
            }
            Step::Claim => {
                *slot = Slot::Starting;
                return Ok(None);
            }
            Step::Wait => {
                let (next, timeout) = server
                    .settled
                    .wait_timeout(slot, READY_TIMEOUT)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                slot = next;
                if timeout.timed_out() {
                    return Err(format!(
                        "nikcli serve non ha risposto entro {} secondi.",
                        READY_TIMEOUT.as_secs()
                    ));
                }
            }
        }
    }
}

/// Puts a started server in the slot, if the claim on it still stands.
fn install(server: &Server, url: String, mut child: Child) -> Result<String, String> {
    let mut slot = server.lock();
    if !matches!(*slot, Slot::Starting) {
        /*
         * The claim is gone, so `nikcli_serve_stop` ran — or the window closed
         * — while this server was starting. Killing it is the only safe move:
         * the alternative is a server listening on a port nobody recorded.
         */
        drop(slot);
        let _ = child.kill();
        let _ = child.wait();
        return Err("nikcli serve è stato fermato durante l'avvio.".to_string());
    }
    *slot = Slot::Running(Serving {
        url: url.clone(),
        child,
    });
    Ok(url)
}

/// Starts `nikcli serve`, or returns the URL of the one already running.
///
/// Idempotent on purpose: both the chat section and the voice assistant ask
/// for a server, they mount independently, and neither should have to know
/// whether the other got there first.
///
/// Blocking from beginning to end, and therefore never called on the thread
/// that draws the window — see `nikcli_serve_start`, which is the command.
fn start_blocking(server: &Server, directory: Option<String>) -> Result<String, String> {
    if let Some(url) = claim_start(server)? {
        return Ok(url);
    }
    // From here on the slot says `Starting`, and this guard is what puts it
    // back however the function leaves.
    let _claim = Claim(server);

    let program = which_on_path("nikcli")
        .ok_or_else(|| "nikcli non è nel PATH: installalo per usare chat e assistente.".to_string())?;

    let mut command = Command::new(program);
    command
        .arg("serve")
        .arg("--hostname=127.0.0.1")
        // Port 0 asks the OS for a free one; the readiness line reports which.
        // A fixed port would collide with a nikcli the user started themselves.
        .arg("--port=0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(dir) = directory.as_deref().filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }

    #[cfg(windows)]
    {
        // No console window for a background service.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("nikcli serve non è partito: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "nikcli serve non ha uno stdout leggibile".to_string())?;
    let stderr = child.stderr.take();

    let (ready_tx, ready_rx) = channel::<Result<String, String>>();

    /*
     * One thread reads stdout for the whole life of the server, not just until
     * it is ready.
     *
     * Stopping at the readiness line would leave nobody draining the pipe, and
     * a pipe nobody drains fills and blocks the writer — so the server would
     * wedge partway through its first busy minute, looking like a hang with no
     * error anywhere.
     */
    std::thread::spawn(move || {
        let mut announced = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if !announced {
                if let Some(url) = parse_ready_line(&line) {
                    announced = true;
                    let _ = ready_tx.send(Ok(url));
                }
            }
        }
        if !announced {
            let _ = ready_tx.send(Err("nikcli serve è uscito senza annunciare una porta".into()));
        }
    });

    // stderr drained too, and kept: it is the only place a start-up failure
    // explains itself, and the message is what the user is shown.
    let (err_tx, err_rx) = channel::<String>();
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let mut collected = String::new();
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if collected.len() < 4096 {
                    collected.push_str(&line);
                    collected.push('\n');
                }
            }
            let _ = err_tx.send(collected);
        });
    }

    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(url)) => install(server, url, child),
        Ok(Err(reason)) => {
            let _ = child.kill();
            let _ = child.wait();
            let detail = err_rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default();
            Err(if detail.trim().is_empty() {
                reason
            } else {
                format!("{reason}: {}", detail.trim())
            })
        }
        Err(RecvTimeoutError::Timeout) => {
            // Killed rather than left behind: an unreachable server holding a
            // port is worse than no server at all.
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "nikcli serve non ha risposto entro {} secondi.",
                READY_TIMEOUT.as_secs()
            ))
        }
        Err(RecvTimeoutError::Disconnected) => {
            let _ = child.kill();
            let _ = child.wait();
            Err("nikcli serve è terminato durante l'avvio.".into())
        }
    }
}

/*
 * All three commands are `async`, and the two that block go further and run
 * on a blocking worker.
 *
 * A synchronous `#[tauri::command]` is dispatched on the thread that owns the
 * window — the same lesson `pty.rs` learned and documents three times. Here it
 * was the worst case in the crate: `recv_timeout(45s)` on that thread, with
 * the mutex held, so a cold start froze the whole window and even asking for
 * the server's status queued behind it. `async` alone would only move it to an
 * async worker, where a forty-five second block still holds a slot the rest of
 * the runtime wants; `spawn_blocking` is the thread pool meant for exactly
 * this.
 */

/// Starts the server if it is not running, and returns its URL.
#[tauri::command]
pub async fn nikcli_serve_start(
    app: tauri::AppHandle,
    directory: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let server = app.state::<Server>();
        start_blocking(&server, directory)
    })
    .await
    .map_err(|_| "avvio del server interrotto".to_string())?
}

/// The URL of the running server, or nothing. Never starts one.
#[tauri::command]
pub async fn nikcli_serve_status(state: tauri::State<'_, Server>) -> Result<Option<String>, String> {
    let mut slot = state.lock();
    let Slot::Running(serving) = &mut *slot else {
        return Ok(None);
    };
    Ok(still_alive(&mut serving.child).then(|| serving.url.clone()))
}

#[tauri::command]
pub async fn nikcli_serve_stop(app: tauri::AppHandle) {
    // `kill` and `wait` both block, briefly but really.
    let _ = tauri::async_runtime::spawn_blocking(move || app.state::<Server>().shutdown()).await;
}

#[cfg(test)]
mod tests {
    use super::{Claim, Server, Serving, Slot, claim_start, install, parse_ready_line};
    use std::process::{Child, Command, Stdio};
    use std::time::Duration;

    /// A child that stays up long enough to be looked at, on either platform.
    fn sleeper() -> Child {
        let mut command = if cfg!(windows) {
            let mut it = Command::new("cmd");
            it.args(["/C", "ping -n 20 127.0.0.1"]);
            it
        } else {
            let mut it = Command::new("sh");
            it.args(["-c", "sleep 20"]);
            it
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("il processo di prova non è partito")
    }

    /// A child that has already exited and been reaped by nobody.
    fn finished() -> Child {
        let mut command = if cfg!(windows) {
            let mut it = Command::new("cmd");
            it.args(["/C", "exit 0"]);
            it
        } else {
            let mut it = Command::new("sh");
            it.args(["-c", "exit 0"]);
            it
        };
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("il processo di prova non è partito");
        let _ = child.wait();
        child
    }

    fn running(server: &Server, url: &str, child: Child) {
        *server.lock() = Slot::Running(Serving {
            url: url.to_string(),
            child,
        });
    }

    #[test]
    fn a_live_server_answers_without_a_second_one_being_started() {
        let server = Server::default();
        running(&server, "http://127.0.0.1:1", sleeper());

        assert_eq!(
            claim_start(&server).unwrap(),
            Some("http://127.0.0.1:1".to_string())
        );
        // Still running: the caller was answered, not handed a claim.
        assert!(matches!(*server.lock(), Slot::Running(_)));
        server.shutdown();
    }

    #[test]
    fn a_dead_child_is_reaped_and_the_slot_is_claimed() {
        let server = Server::default();
        running(&server, "http://127.0.0.1:2", finished());

        assert_eq!(claim_start(&server).unwrap(), None);
        assert!(matches!(*server.lock(), Slot::Starting));
    }

    #[test]
    fn giving_up_the_claim_leaves_the_slot_free_for_the_next_caller() {
        let server = Server::default();
        assert_eq!(claim_start(&server).unwrap(), None);
        {
            let _claim = Claim(&server);
        }
        assert!(matches!(*server.lock(), Slot::Idle));
        // And the next caller can claim it in turn.
        assert_eq!(claim_start(&server).unwrap(), None);
    }

    #[test]
    fn a_second_caller_waits_for_the_start_instead_of_starting_another() {
        let server = Server::default();
        assert_eq!(claim_start(&server).unwrap(), None);

        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| claim_start(&server));
            // Long enough for the other thread to reach the condvar; if it
            // raced ahead instead it would have claimed the slot and returned
            // None, which is what the assertion below rules out.
            std::thread::sleep(Duration::from_millis(80));
            install(&server, "http://127.0.0.1:3".to_string(), sleeper()).unwrap();
            server.settled.notify_all();

            assert_eq!(
                waiting.join().unwrap().unwrap(),
                Some("http://127.0.0.1:3".to_string())
            );
        });

        server.shutdown();
    }

    #[test]
    fn a_server_stopped_while_it_was_starting_is_killed_rather_than_installed() {
        let server = Server::default();
        assert_eq!(claim_start(&server).unwrap(), None);
        // `nikcli_serve_stop` arriving mid-start: the claim is dropped.
        server.shutdown();

        let child = sleeper();
        let id = child.id();
        assert!(install(&server, "http://127.0.0.1:4".to_string(), child).is_err());
        assert!(matches!(*server.lock(), Slot::Idle));

        // The child install refused is not left listening on a port nobody
        // recorded. It was killed and waited for inside `install`.
        let mut probe = if cfg!(windows) {
            let mut it = Command::new("cmd");
            it.args(["/C", &format!("tasklist /FI \"PID eq {id}\" | find \"{id}\"")]);
            it
        } else {
            let mut it = Command::new("sh");
            it.args(["-c", &format!("kill -0 {id}")]);
            it
        };
        let gone = probe
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| !status.success())
            .unwrap_or(true);
        assert!(gone, "il processo {id} è rimasto in vita");
    }

    #[test]
    fn shutdown_during_a_start_cancels_the_claim() {
        let server = Server::default();
        assert_eq!(claim_start(&server).unwrap(), None);
        server.shutdown();
        assert!(matches!(*server.lock(), Slot::Idle));
    }

    #[test]
    fn reads_the_url_out_of_the_readiness_line() {
        assert_eq!(
            parse_ready_line("nikcli server listening on http://127.0.0.1:52341"),
            Some("http://127.0.0.1:52341".to_string())
        );
    }

    #[test]
    fn drops_a_trailing_slash_so_the_sdk_does_not_double_it() {
        assert_eq!(
            parse_ready_line("nikcli server listening on http://127.0.0.1:4096/"),
            Some("http://127.0.0.1:4096".to_string())
        );
    }

    #[test]
    fn accepts_https_and_trailing_words() {
        assert_eq!(
            parse_ready_line("nikcli server listening on https://127.0.0.1:8443 (mdns)"),
            Some("https://127.0.0.1:8443".to_string())
        );
    }

    #[test]
    fn ignores_every_other_line() {
        // The server prints plenty before it binds; none of it is a URL to
        // connect to, and treating one as such would point the SDK at nothing.
        assert_eq!(parse_ready_line("loading config from ~/.config/nikcli"), None);
        assert_eq!(parse_ready_line(""), None);
        assert_eq!(parse_ready_line("see http://127.0.0.1:1234 for details"), None);
    }

    #[test]
    fn refuses_a_readiness_line_with_no_url() {
        assert_eq!(parse_ready_line("nikcli server listening"), None);
    }
}

/// The page ADE shows, in a build that does not carry it.
///
/// A release build bundles the frontend into the binary, so there is nothing
/// to start and this module does nothing. A debug build does not: `devUrl` is
/// baked in, and the window loads `http://localhost:5177` from a Vite server
/// somebody else was supposed to have started. `tauri dev` does start one —
/// but the executable it leaves behind in `target/debug` is the thing on the
/// user's taskbar, and launching *that* shows "localhost refused to connect"
/// with no explanation and nothing to click.
///
/// So the window makes sure the server is there before it opens one, and
/// starts it itself if it is not: no console window, no second thing to
/// remember to run, and killed again when ADE exits.
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long to wait for Vite to bind before giving up and opening anyway.
///
/// A cold Vite on this workspace is a few seconds; the ceiling is generous
/// because opening early is the failure this module exists to prevent, and
/// a window that appears two seconds late is not a failure at all.
const START_TIMEOUT: Duration = Duration::from_secs(40);

/// How long a single connection attempt is allowed to hang.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// Gap between attempts while waiting. Short: the wait ends on the first
/// success, so this is only how quickly that success is noticed.
const PROBE_GAP: Duration = Duration::from_millis(120);

/// The Vite server this window started, if it started one.
///
/// `None` when the frontend is bundled, or when a server was already
/// answering — one somebody started by hand, or `tauri dev`'s own. Killing a
/// server this window did not start would take down the terminal the
/// developer is working in.
#[derive(Default)]
pub struct DevServer(Mutex<Option<Child>>);

impl DevServer {
    /// Kills the server, if this window started one. Safe to call twice.
    pub fn shutdown(&self) {
        let mut slot = match self.0.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for DevServer {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// True when something is listening on that address.
fn answers(address: &SocketAddr) -> bool {
    TcpStream::connect_timeout(address, PROBE_TIMEOUT).is_ok()
}

/// The addresses a dev URL could mean.
///
/// Plural, and that is the whole point on this machine: Vite binds `::1` and
/// `localhost` resolves to both `::1` and `127.0.0.1`, so probing one of them
/// says the server is down while the browser reaches it perfectly well.
fn addresses(url: &str) -> Vec<SocketAddr> {
    let Some(rest) = url.split("://").nth(1) else {
        return Vec::new();
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    authority.to_socket_addrs().map(|it| it.collect()).unwrap_or_default()
}

/// Makes sure the dev server is up, starting one if it is not.
///
/// Never fails the launch: if Vite cannot be started the window still opens,
/// because an empty window with an error in it is something the developer can
/// read, and no window at all is not.
#[cfg(debug_assertions)]
pub fn ensure(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(url) = app.config().build.dev_url.as_ref().map(|it| it.to_string()) else {
        return;
    };
    let targets = addresses(&url);
    if targets.is_empty() {
        eprintln!("ADE: non so a quale indirizzo corrisponde {url}");
        return;
    }
    if targets.iter().any(answers) {
        return;
    }

    let Some(child) = spawn_vite() else {
        eprintln!(
            "ADE: nessun server su {url} e non sono riuscito ad avviarlo. \
             Avvia `bun run --cwd packages/ade dev` a mano."
        );
        return;
    };
    *app.state::<DevServer>()
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(child);

    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if targets.iter().any(answers) {
            return;
        }
        std::thread::sleep(PROBE_GAP);
    }
    eprintln!("ADE: il server di sviluppo non ha risposto entro {START_TIMEOUT:?}.");
}

/// Nothing to do: the page is inside the binary.
#[cfg(not(debug_assertions))]
pub fn ensure(_app: &tauri::AppHandle) {}

/// Starts Vite in the frontend package, with no window and no terminal.
#[cfg(debug_assertions)]
fn spawn_vite() -> Option<Child> {
    /*
     * The frontend package, found at compile time.
     *
     * The executable lives four directories below it and can be launched from
     * anywhere — a taskbar shortcut has no useful working directory — so
     * resolving this from `current_dir` would work exactly when it did not
     * matter. This path is only ever used by a debug build, which by
     * definition was compiled on the machine it runs on.
     */
    let package = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let bun = crate::pty::which_on_path("bun")?;

    let mut command = Command::new(bun);
    command
        .arg("x")
        .arg("vite")
        .current_dir(package)
        .stdin(Stdio::null())
        /*
         * Discarded rather than piped. A pipe nobody reads fills and blocks
         * the writer, and Vite writes on every rebuild — so piping without a
         * reader thread would wedge the dev server partway through the first
         * afternoon of work.
         */
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        // The reason this is hidden at all: without the flag a console window
        // opens behind ADE every time the app is launched.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn().ok()
}

#[cfg(test)]
mod tests {
    use super::addresses;

    #[test]
    fn a_dev_url_resolves_to_every_address_localhost_means() {
        // The bug this guards: probing one address and declaring the server
        // down while the browser reaches it on the other.
        let found = addresses("http://localhost:5177");
        assert!(!found.is_empty(), "localhost non risolve");
        assert!(found.iter().all(|address| address.port() == 5177));
    }

    #[test]
    fn a_url_with_a_path_still_gives_the_authority() {
        let found = addresses("http://127.0.0.1:5177/index.html");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].to_string(), "127.0.0.1:5177");
    }

    #[test]
    fn nonsense_gives_nothing_rather_than_panicking() {
        assert!(addresses("").is_empty());
        assert!(addresses("not a url").is_empty());
        assert!(addresses("http://").is_empty());
    }
}

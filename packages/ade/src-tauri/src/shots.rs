/// Screenshots, noticed rather than asked for.
///
/// The user presses the key their operating system gives them and the picture
/// lands in a folder; ADE's job is to see it arrive. Nothing here takes a
/// screenshot, and nothing here asks the user where to put one — a tool that
/// made you save the file somewhere special before it would look at it would be
/// slower than dragging the file yourself.
///
/// Polled rather than hooked into the filesystem's change notifications. The
/// folder gains a file every few minutes at most, a poll costs one metadata
/// read and, when the folder changed, one directory listing, and ReadDirectoryChangesW brings a watcher handle, a cancellation
/// path and a class of missed-event bugs that this does not have.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

/// Extensions worth showing. A screenshot folder collects other things —
/// thumbnails databases, the odd stray download — and a tray full of them is
/// worse than an empty one.
const IMAGES: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

#[derive(Default)]
pub struct Watch {
    dir: Mutex<Option<PathBuf>>,
    /*
     * Bumped every time a different folder is watched, and read by the polling
     * thread on each pass. Without it the thread started for the previous
     * folder keeps running for as long as the window is open, announcing
     * `shot:new` for a folder nobody is looking at any more — the "don't start
     * a second thread" guard below only ever compared the current path.
     */
    generation: Arc<AtomicUsize>,
}

#[derive(Clone, serde::Serialize)]
pub struct Shot {
    path: String,
    name: String,
    /// Milliseconds since the epoch, so the tray can order without re-reading.
    modified_ms: u64,
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGES.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn describe(path: &Path) -> Option<Shot> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(Shot {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        modified_ms: modified,
    })
}

/// Where this machine puts screenshots.
///
/// The folder's *display* name is translated — Italian Windows shows
/// "Immagini\Schermate" — but the name on disk is not, which is why this looks
/// for the English one and does not try to guess a localised spelling.
/*
 * `async` throughout, for the reason spelled out in `lib.rs`: a synchronous
 * command runs on the thread that draws the window, and every command here
 * touches the disk. `shot_bytes` is the sharp one — a 4K screenshot is several
 * megabytes read from a folder that is often a OneDrive mount, and the tray
 * asks for one per thumbnail.
 */
#[tauri::command]
pub async fn shots_dir() -> Option<String> {
    default_dir()
}

/// The same answer, callable from Rust: an `async` command is a future, and
/// `check_shot` needs the folder now.
fn default_dir() -> Option<String> {
    let candidates = [
        dirs::picture_dir().map(|p| p.join("Screenshots")),
        dirs::home_dir().map(|p| p.join("OneDrive").join("Pictures").join("Screenshots")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
}

/// The images already there, newest first, capped at `limit`.
///
/// Read once when the tray opens so it is not empty until the next screenshot:
/// the one the user took a moment before switching to ADE is the one they came
/// to use.
#[tauri::command]
pub async fn shots_recent(dir: String, limit: usize) -> Vec<Shot> {
    let mut found: Vec<Shot> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_image(path))
        .filter_map(|path| describe(&path))
        .collect();
    found.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    found.truncate(limit);
    found
}

/// Starts watching `dir`, emitting `shot:new` for each image that appears.
///
/// Only what arrives from now on. The folder already holds months of pictures,
/// and announcing all of them would bury whatever the user just took.
#[tauri::command]
pub async fn shots_watch(
    app: AppHandle,
    watch: tauri::State<'_, Watch>,
    dir: String,
) -> Result<(), String> {
    let path = PathBuf::from(&dir);
    if !path.is_dir() {
        return Err(format!("{dir} non è una cartella"));
    }

    let Some(generation) = claim(&watch, &path)? else {
        return Ok(());
    };
    let mine = Arc::clone(&watch.generation);

    std::thread::spawn(move || {
        // Read before the listing, never after: a file that lands between the
        // two moves the folder's time past this value, and the next pass lists.
        let mut listed_mtime = dir_modified(&path);
        let mut listed_at = Instant::now();
        let mut seen: HashSet<PathBuf> = std::fs::read_dir(&path)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        // An image found but not yet settled, which a skipped pass would strand.
        let mut unsettled = false;

        loop {
            std::thread::sleep(POLL_INTERVAL);

            // The window is gone: stop, rather than poll a folder for a page
            // that will never be told about it.
            if app.webview_windows().is_empty() {
                return;
            }

            // Someone asked for a different folder: that call started its own
            // thread, and this one has nothing left to report.
            if !is_current(&mine, generation) {
                return;
            }

            let mtime = dir_modified(&path);
            if !needs_listing(listed_mtime, mtime, unsettled, listed_at.elapsed()) {
                continue;
            }

            let entries: HashSet<PathBuf> = match std::fs::read_dir(&path) {
                Ok(read) => read.flatten().map(|entry| entry.path()).collect(),
                Err(_) => {
                    // Not listed, so nothing is known: the next pass tries again.
                    listed_mtime = None;
                    continue;
                }
            };
            listed_mtime = mtime;
            listed_at = Instant::now();
            unsettled = false;

            for entry in &entries {
                if seen.contains(entry) || !entry.is_file() || !is_image(entry) {
                    continue;
                }
                /*
                 * A screenshot tool writes the file before it finishes writing
                 * the file: read too eagerly and the tray shows half an image,
                 * or none. Waiting for the size to stop moving is cruder than
                 * asking the writer, and it works for every tool.
                 *
                 * Marked as seen only once it has settled. Marking first meant
                 * that a capture slower than one pass — a 4K shot, a folder
                 * being synced to the cloud — was written off on the single
                 * pass that arrived too early, and never looked at again.
                 */
                if !settled(entry) {
                    unsettled = true;
                    continue;
                }
                seen.insert(entry.clone());
                if let Some(shot) = describe(entry) {
                    let _ = app.emit("shot:new", shot);
                }
            }

            forget_missing(&mut seen, &entries);
        }
    });

    Ok(())
}

/*
 * How often the folder is looked at, and how long it may go unlisted.
 *
 * Two and a half seconds: a screenshot is taken to be pasted somewhere, and
 * the time it takes a person to switch to ADE and look for it is longer than
 * that. Most passes list nothing at all — see `needs_listing`.
 */
const POLL_INTERVAL: Duration = Duration::from_millis(2500);
const FULL_RELIST: Duration = Duration::from_secs(30);

/// The folder's own modified time, which moves when a file is added, removed
/// or renamed in it.
fn dir_modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/*
 * Whether this pass has to list the folder.
 *
 * A folder of months of screenshots is thousands of entries, and listing it
 * every pass to find that nothing arrived was the whole cost of the watcher.
 * NTFS and APFS move a directory's modified time whenever a file is created
 * in it, so an unchanged time means an unchanged listing — on those, which are
 * the two this is written for.
 *
 * Three reasons to list anyway. An image seen but not settled on the last pass
 * has to be looked at again, and its growing does not touch the folder's time.
 * A time that cannot be read is no evidence of anything. And some mounts —
 * network shares, cloud-synced folders, filesystems with two-second times —
 * do not keep the folder's time honestly, so every thirty seconds the folder
 * is listed whatever its time says: a late screenshot, not a lost one.
 */
fn needs_listing(
    listed: Option<SystemTime>,
    current: Option<SystemTime>,
    unsettled: bool,
    since_listing: Duration,
) -> bool {
    unsettled || since_listing >= FULL_RELIST || current.is_none() || listed != current
}

/// Files deleted outside ADE should be forgotten, or the set grows for as long
/// as the window is open and a re-created name is missed.
///
/// Both sides are sets: with a `Vec` of entries this was a scan of the whole
/// folder for every file already seen, on every pass.
fn forget_missing(seen: &mut HashSet<PathBuf>, entries: &HashSet<PathBuf>) {
    seen.retain(|known| entries.contains(known));
}

/// Takes the next generation for `path`, or `None` when that folder is already
/// the one being watched.
///
/// Split out of `shots_watch` because it is the whole of the duplicate guard
/// and the whole of the stop signal, and neither could be exercised while it
/// sat inside a command that wants an `AppHandle` and a real folder.
fn claim(watch: &Watch, path: &Path) -> Result<Option<usize>, String> {
    let mut current = watch.dir.lock().map_err(|_| "watch bloccato")?;
    // Re-watching the same folder must not start a second thread: both would
    // announce every screenshot, and the tray would show each one twice.
    if current.as_deref() == Some(path) {
        return Ok(None);
    }
    *current = Some(path.to_path_buf());
    // Bumped under the same lock that swaps the folder, so the thread being
    // replaced can see it is no longer the current one.
    Ok(Some(watch.generation.fetch_add(1, Ordering::SeqCst) + 1))
}

/// True while `mine` is still the generation the watcher is on.
fn is_current(shared: &AtomicUsize, mine: usize) -> bool {
    shared.load(Ordering::SeqCst) == mine
}

/// Two readings that agree on a size that is not zero: the writer has stopped.
///
/// Zero is the case worth naming. `size_of` below reports it both for a file
/// that is not there and for one the screenshot tool has created but not
/// written into yet, and calling either of those "unchanged, therefore
/// finished" would announce an empty placeholder as a screenshot.
fn size_is_stable(previous: u64, current: u64) -> bool {
    current == previous && current > 0
}

/// Waits, briefly, for a file to stop growing.
fn settled(path: &Path) -> bool {
    let size_of = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let mut last = size_of(path);
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(120));
        let now = size_of(path);
        if size_is_stable(last, now) {
            return true;
        }
        last = now;
    }
    false
}

/*
 * Which files these two commands will touch.
 *
 * "Has an image extension" was the only check, and it is not one: every page
 * loaded in the browser pane can invoke these, so it made `shot_delete` a way
 * to remove any picture anywhere on the disk, and `shot_bytes` a way to read
 * one. The tray only ever names files it found by listing the screenshots
 * folder, so that folder — plus whichever one is being watched, if the user
 * pointed the tray elsewhere — is the entire legitimate range.
 */
fn is_in_shots_dir(watch: &Watch, path: &Path) -> bool {
    // Canonicalised on both sides: the point is to catch a link planted in the
    // screenshots folder and aimed somewhere else, which a textual prefix
    // check would wave straight through.
    let Ok(resolved) = path.canonicalize() else {
        return false;
    };

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = default_dir() {
        roots.push(PathBuf::from(dir));
    }
    if let Ok(current) = watch.dir.lock() {
        if let Some(dir) = current.as_ref() {
            roots.push(dir.clone());
        }
    }

    roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| resolved.starts_with(root))
}

fn check_shot(watch: &Watch, path: &str) -> Result<PathBuf, String> {
    let file = PathBuf::from(path);
    if !is_image(&file) {
        return Err("non è un'immagine".into());
    }
    if !is_in_shots_dir(watch, &file) {
        return Err("non è nella cartella degli screenshot".into());
    }
    Ok(file)
}

/// The image itself, for the tray's thumbnail.
///
/// Handed over as bytes rather than as a path the page could load directly: the
/// webview has no access to the filesystem, and opening one up so it could read
/// a picture would be a far larger grant than reading the picture.
#[tauri::command]
pub async fn shot_bytes(watch: tauri::State<'_, Watch>, path: String) -> Result<Vec<u8>, String> {
    let file = check_shot(&watch, &path)?;
    std::fs::read(&file).map_err(|e| format!("non leggibile: {e}"))
}

/// Removes a screenshot from disk. Used by the tray's own delete, never by the
/// dismiss — closing a thumbnail hides it, it does not throw the file away.
#[tauri::command]
pub async fn shot_delete(watch: tauri::State<'_, Watch>, path: String) -> Result<(), String> {
    let file = check_shot(&watch, &path)?;
    std::fs::remove_file(&file).map_err(|e| format!("non eliminabile: {e}"))
}

/*
 * What is tested here, and what is deliberately not.
 *
 * The two rules that had the bugs — "seen only once settled" and "stop when a
 * newer watcher exists" — are tested through the functions that decide them.
 * The loop that applies them is not: it needs an `AppHandle` to emit through
 * and a folder that gains a file while it is polling, and a test that wrote a
 * screenshot slowly enough to span a pass would be deciding by stopwatch which
 * of two threads wins. That is the flaky test this deliberately does not have.
 */
#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of our own under the system temp folder. Named after the
    /// test, so two of them running at once never share a file.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ade-shots-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("cartella temporanea");
        dir
    }

    #[test]
    fn only_pictures_are_worth_announcing() {
        assert!(is_image(Path::new("Screenshot 2026-09-11.png")));
        // Whatever case the tool felt like using.
        assert!(is_image(Path::new("shot.JPG")));
        assert!(!is_image(Path::new("Thumbs.db")));
        assert!(!is_image(Path::new("note.txt")));
        assert!(!is_image(Path::new("Screenshots")));
    }

    #[test]
    fn a_size_that_stopped_moving_means_the_write_finished() {
        assert!(size_is_stable(4096, 4096));
    }

    #[test]
    fn a_file_still_growing_has_not_finished() {
        assert!(!size_is_stable(2048, 4096));
        // Shrinking counts as movement too: some tools write a header last.
        assert!(!size_is_stable(4096, 2048));
    }

    #[test]
    fn nothing_on_disk_is_never_a_finished_screenshot() {
        // Both readings are zero for a file that does not exist and for one
        // created but not written into. "Unchanged" must not win here.
        assert!(!size_is_stable(0, 0));
    }

    #[test]
    fn a_file_already_written_settles_on_the_first_pass() {
        // Not a race: nothing writes to this file while `settled` watches it,
        // so the first two readings agree whatever the machine is doing.
        let dir = scratch("settled");
        let file = dir.join("shot.png");
        std::fs::write(&file, b"not really a png, but it has a size").expect("scrittura");

        assert!(settled(&file));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_file_never_settles() {
        // The regression this guards: an empty file has an unchanging size, and
        // treating that as finished announced a placeholder as a screenshot.
        // Costs the full ten passes by design — there is nothing to wait for.
        let dir = scratch("empty");
        let file = dir.join("shot.png");
        std::fs::write(&file, b"").expect("scrittura");

        assert!(!settled(&file));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_whose_time_did_not_move_is_not_listed() {
        let t = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let later = t + Duration::from_millis(1);
        let soon = Duration::from_secs(3);

        assert!(!needs_listing(Some(t), Some(t), false, soon));
        // A file arrived, or left.
        assert!(needs_listing(Some(t), Some(later), false, soon));
        // A time that cannot be read, now or last time, proves nothing.
        assert!(needs_listing(Some(t), None, false, soon));
        assert!(needs_listing(None, Some(t), false, soon));
    }

    #[test]
    fn a_screenshot_still_being_written_keeps_the_folder_listed() {
        // Its growing does not touch the folder's time, and skipping the pass
        // would leave it unannounced until the fallback relist.
        let t = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        assert!(needs_listing(Some(t), Some(t), true, Duration::from_secs(3)));
    }

    #[test]
    fn the_folder_is_relisted_now_and_then_whatever_its_time_says() {
        let t = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        assert!(needs_listing(Some(t), Some(t), false, FULL_RELIST));
    }

    #[test]
    fn files_gone_from_the_folder_are_forgotten_and_the_rest_kept() {
        let mut seen: HashSet<PathBuf> = ["a.png", "b.png", "c.png"].iter().map(PathBuf::from).collect();
        let entries: HashSet<PathBuf> = ["b.png", "c.png", "d.png"].iter().map(PathBuf::from).collect();

        forget_missing(&mut seen, &entries);

        let expected: HashSet<PathBuf> = ["b.png", "c.png"].iter().map(PathBuf::from).collect();
        // `d.png` is not added: only a settled file is marked as seen.
        assert_eq!(seen, expected);
    }

    #[test]
    fn watching_the_same_folder_twice_starts_nothing_new() {
        let watch = Watch::default();
        let dir = Path::new("C:/Users/x/Pictures/Screenshots");

        assert_eq!(claim(&watch, dir), Ok(Some(1)));
        // Second call finds the folder unchanged and declines to hand out a
        // generation, which is what stops a duplicate thread being spawned.
        assert_eq!(claim(&watch, dir), Ok(None));
    }

    #[test]
    fn a_new_folder_retires_the_watcher_of_the_old_one() {
        let watch = Watch::default();

        let first = claim(&watch, Path::new("/pictures/one")).unwrap().unwrap();
        assert!(is_current(&watch.generation, first));

        let second = claim(&watch, Path::new("/pictures/two")).unwrap().unwrap();
        assert_ne!(first, second);
        // The old thread's next pass reads this and returns; before the counter
        // existed it kept polling its folder and kept emitting `shot:new` for
        // pictures nobody was looking at any more.
        assert!(!is_current(&watch.generation, first));
        assert!(is_current(&watch.generation, second));
    }

    #[test]
    fn going_back_to_the_first_folder_is_a_new_generation_too() {
        // Not the same as "already watching it": the thread for that folder has
        // been retired by the folder in between, so one has to be started again.
        let watch = Watch::default();

        let first = claim(&watch, Path::new("/pictures/one")).unwrap().unwrap();
        claim(&watch, Path::new("/pictures/two")).unwrap().unwrap();
        let again = claim(&watch, Path::new("/pictures/one")).unwrap().unwrap();

        assert_ne!(again, first);
        assert!(is_current(&watch.generation, again));
    }
}

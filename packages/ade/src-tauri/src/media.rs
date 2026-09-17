//! Serving a project's own media files to the window.
//!
//! The video panel plays a file that is on disk, and a `<video>` element cannot
//! be handed a path: it needs a URL, and it needs that URL to answer range
//! requests, because seeking is the whole point of a player. Reading the file
//! into a blob would work for a clip and fail for a screen recording — the
//! files this panel is for are the ones a session just produced, and those are
//! measured in hundreds of megabytes.
//!
//! So this registers a scheme of its own. Tauri's built-in asset protocol would
//! do the same job, but it comes with a second scope to configure and keep in
//! step with the one the window already has; here the answer to "may this file
//! be read" is the set of roots the user has actually opened, which is the
//! registry `allow_write_root` already maintains. One rule, one place.
//!
//! The confinement is not decoration. Anything running in the browser pane's
//! frame can reach a URL, so a scheme that served an arbitrary path would be a
//! way to read the user's whole disk through an `<video>` tag.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{Request, Response, StatusCode};

/// The scheme name. Reachable as `ade-media://localhost/<path>`, which Windows
/// rewrites to `http://ade-media.localhost/<path>` — both arrive here.
pub const SCHEME: &str = "ade-media";

/// How much of a file one range request may return.
///
/// A `<video>` asks for what it needs and asks again; answering an open-ended
/// range with the whole file would put a 700 MB recording through the IPC
/// boundary in one piece the first time the element probes it.
const MAX_CHUNK: u64 = 4 * 1024 * 1024;

/// Builds the URL the frontend puts in `<video src>`.
///
/// Nothing in Rust calls it, and that is the point: the page builds the URL
/// itself in `video/video.ts`, and this is the half the tests below check the
/// encoding against. A wrong encoding is a silent 404 inside a media element
/// — a player that never starts, with nothing on any console — so the two
/// implementations are held to the same cases rather than to a comment.
#[cfg_attr(not(test), allow(dead_code))]
pub fn url_for(path: &str) -> String {
    format!("{SCHEME}://localhost/{}", urlencoding(path))
}

#[cfg_attr(not(test), allow(dead_code))]
fn urlencoding(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn urldecode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The content type, from the extension. Only the ones the panel offers.
fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

/// Parses `bytes=start-end`, returning the start and the inclusive end.
///
/// Only the single-range form, which is the only one a media element sends.
/// An open-ended range is capped rather than refused, so the element gets its
/// first bytes immediately and asks for the rest as it plays.
fn parse_range(header: &str, length: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (from, to) = spec.split_once('-')?;

    if from.is_empty() {
        // `bytes=-500`: the last 500 bytes. MP4 metadata at the tail is read
        // this way, so it is not a theoretical form.
        let count: u64 = to.parse().ok()?;
        if count == 0 || length == 0 {
            return None;
        }
        let start = length.saturating_sub(count);
        return Some((start, length - 1));
    }

    let start: u64 = from.parse().ok()?;
    if start >= length {
        return None;
    }
    let end = if to.is_empty() {
        length - 1
    } else {
        to.parse::<u64>().ok()?.min(length - 1)
    };
    if end < start {
        return None;
    }
    Some((start, start.max(end).min(start + MAX_CHUNK - 1)))
}

/// Whether `path` sits inside one of the roots the user has opened.
fn within(roots: &[PathBuf], path: &Path) -> bool {
    let Ok(resolved) = path.canonicalize() else {
        return false;
    };
    roots.iter().any(|root| resolved.starts_with(root))
}

fn deny(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("risposta statica")
}

/// Answers one request for a media file.
///
/// Split from the registration below so the parts that can be wrong — the
/// range arithmetic and the confinement — are reachable from a test.
///
/// `app_origin` is the origin of the page that asked, as the webview itself
/// reports it. A request whose `Origin` header matches it gets that origin
/// back as allowed, which is what lets the recording export draw a take into
/// a canvas and still record the canvas: a frame drawn without CORS leaves the
/// canvas unclean and `MediaRecorder` writes nothing.
///
/// Any other origin gets no CORS header at all. Not `null`: the browser pane
/// is a sandbox without `allow-same-origin`, so every page in it sends
/// `Origin: null`, and `Access-Control-Allow-Origin: null` is exactly the
/// answer that lets such a page read the file.
pub fn respond(roots: &[PathBuf], request: &Request<Vec<u8>>, app_origin: Option<&str>) -> Response<Vec<u8>> {
    let raw = request.uri().path().trim_start_matches('/');
    if raw.is_empty() {
        return deny(StatusCode::BAD_REQUEST);
    }
    let path = PathBuf::from(urldecode(raw));

    if !within(roots, &path) {
        // Not "not found": the file may well exist. It is outside every
        // project this window has opened, and that is the whole rule.
        return deny(StatusCode::FORBIDDEN);
    }

    let Ok(mut file) = File::open(&path) else {
        return deny(StatusCode::NOT_FOUND);
    };
    let Ok(meta) = file.metadata() else {
        return deny(StatusCode::NOT_FOUND);
    };
    let length = meta.len();

    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(|header| parse_range(header, length));

    let (start, end) = match range {
        Some(pair) => pair,
        // No range header: hand over the first chunk and advertise that
        // ranges work, so the element knows it may seek.
        None => (0, length.saturating_sub(1).min(MAX_CHUNK - 1)),
    };

    if file.seek(SeekFrom::Start(start)).is_err() {
        return deny(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let count = (end - start + 1) as usize;
    let mut body = vec![0u8; count];
    let read = match file.read(&mut body) {
        Ok(read) => read,
        Err(_) => return deny(StatusCode::INTERNAL_SERVER_ERROR),
    };
    body.truncate(read);
    let last = start + read as u64 - 1;

    let allowed = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .filter(|origin| *origin != "null" && Some(*origin) == app_origin);

    let mut response = Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", mime_of(&path))
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{last}/{length}"))
        .header("Content-Length", read.to_string())
        .header("Vary", "Origin");
    if let Some(origin) = allowed {
        response = response.header("Access-Control-Allow-Origin", origin);
    }
    response
        .body(body)
        .unwrap_or_else(|_| deny(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn request(uri: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder().uri(uri);
        if let Some(value) = range {
            builder = builder.header("range", value);
        }
        builder.body(Vec::new()).expect("richiesta")
    }

    fn fixture(bytes: &[u8]) -> (tempdir::Dir, PathBuf) {
        let dir = tempdir::Dir::new("ade-media");
        let path = dir.path().join("clip.mp4");
        let mut file = File::create(&path).expect("file");
        file.write_all(bytes).expect("scrittura");
        (dir, path)
    }

    /// A temporary directory, without pulling in a crate for four lines.
    mod tempdir {
        use std::path::{Path, PathBuf};
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new(tag: &str) -> Self {
                let base = std::env::temp_dir().join(format!(
                    "{tag}-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ));
                std::fs::create_dir_all(&base).expect("cartella temporanea");
                Self(base)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn serves_a_file_inside_an_open_project() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(&roots, &request(&url_for(&path.to_string_lossy()), None), None);

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"0123456789");
        assert_eq!(
            response.headers().get("Content-Range").unwrap(),
            "bytes 0-9/10"
        );
    }

    #[test]
    fn a_file_outside_every_open_project_is_refused() {
        let (dir, path) = fixture(b"segreto");
        // A root that exists but does not contain the file.
        let other = tempdir::Dir::new("ade-media-altro");
        let roots = vec![other.path().canonicalize().expect("radice")];

        let response = respond(&roots, &request(&url_for(&path.to_string_lossy()), None), None);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.body().is_empty());
        drop(dir);
    }

    #[test]
    fn with_no_project_open_nothing_is_served() {
        let (_dir, path) = fixture(b"x");
        let response = respond(&[], &request(&url_for(&path.to_string_lossy()), None), None);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_path_that_climbs_out_does_not_escape() {
        let (dir, _path) = fixture(b"x");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let outside = dir.path().join("..").join("..").join("windows");

        let response = respond(&roots, &request(&url_for(&outside.to_string_lossy()), None), None);
        assert_ne!(response.status(), StatusCode::PARTIAL_CONTENT);
    }

    #[test]
    fn honours_a_range_the_element_asked_for() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(
            &roots,
            &request(&url_for(&path.to_string_lossy()), Some("bytes=3-5")),
            None,
        );

        assert_eq!(response.body(), b"345");
        assert_eq!(
            response.headers().get("Content-Range").unwrap(),
            "bytes 3-5/10"
        );
    }

    #[test]
    fn honours_a_suffix_range_which_is_how_mp4_metadata_is_read() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(
            &roots,
            &request(&url_for(&path.to_string_lossy()), Some("bytes=-3")),
            None,
        );
        assert_eq!(response.body(), b"789");
    }

    #[test]
    fn an_open_ended_range_is_answered_from_the_start_requested() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(
            &roots,
            &request(&url_for(&path.to_string_lossy()), Some("bytes=7-")),
            None,
        );
        assert_eq!(response.body(), b"789");
    }

    #[test]
    fn a_path_with_spaces_and_accents_survives_the_url() {
        let dir = tempdir::Dir::new("ade-media-acc");
        let path = dir.path().join("clip finale è.mp4");
        std::fs::write(&path, b"ok").expect("scrittura");
        let roots = vec![dir.path().canonicalize().expect("radice")];

        let response = respond(&roots, &request(&url_for(&path.to_string_lossy()), None), None);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"ok");
    }

    #[test]
    fn the_content_type_follows_the_extension() {
        assert_eq!(mime_of(Path::new("a.mp4")), "video/mp4");
        assert_eq!(mime_of(Path::new("a.WEBM")), "video/webm");
        assert_eq!(mime_of(Path::new("a.mov")), "video/quicktime");
        assert_eq!(mime_of(Path::new("a.txt")), "application/octet-stream");
    }

    #[test]
    fn a_range_past_the_end_is_not_honoured() {
        assert_eq!(parse_range("bytes=20-30", 10), None);
        assert_eq!(parse_range("bytes=5-3", 10), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 10), None);
        assert_eq!(parse_range("righe=0-1", 10), None);
    }

    #[test]
    fn a_huge_range_is_capped_rather_than_read_whole() {
        let length = 100 * 1024 * 1024;
        let (start, end) = parse_range("bytes=0-", length).expect("intervallo");
        assert_eq!(start, 0);
        assert_eq!(end - start + 1, MAX_CHUNK);
    }

    #[test]
    fn an_empty_path_is_a_bad_request() {
        let response = respond(&[], &request("ade-media://localhost/", None), None);
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    fn with_origin(uri: &str, origin: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(uri)
            .header("origin", origin)
            .body(Vec::new())
            .expect("richiesta")
    }

    #[test]
    fn the_window_itself_is_allowed_by_its_own_origin() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let url = url_for(&path.to_string_lossy());
        let response = respond(&roots, &with_origin(&url, "http://tauri.localhost"), Some("http://tauri.localhost"));
        assert_eq!(
            response.headers().get("Access-Control-Allow-Origin").unwrap(),
            "http://tauri.localhost"
        );
    }

    #[test]
    fn another_origin_is_not_allowed_to_read() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let url = url_for(&path.to_string_lossy());
        let response = respond(&roots, &with_origin(&url, "https://example.com"), Some("http://tauri.localhost"));
        assert!(response.headers().get("Access-Control-Allow-Origin").is_none());
    }

    #[test]
    fn the_sandboxed_browser_pane_is_not_allowed_to_read() {
        // Its pages send `Origin: null`; answering `null` would let them in.
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let url = url_for(&path.to_string_lossy());
        for app in [Some("http://tauri.localhost"), Some("null"), None] {
            let response = respond(&roots, &with_origin(&url, "null"), app);
            assert!(response.headers().get("Access-Control-Allow-Origin").is_none());
        }
    }

    #[test]
    fn a_request_without_origin_gets_no_cors_header() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(&roots, &request(&url_for(&path.to_string_lossy()), None), Some("http://tauri.localhost"));
        assert!(response.headers().get("Access-Control-Allow-Origin").is_none());
    }
}

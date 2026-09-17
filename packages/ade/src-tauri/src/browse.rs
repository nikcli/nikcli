//! What the browser pane needs from outside the webview.
//!
//! The pane's frame is sandboxed and cross-origin, and a `fetch` from ADE's
//! page only sees the response headers a server chooses to expose to CORS.
//! Whether a site forbids being framed (`X-Frame-Options`, CSP
//! `frame-ancestors`) is exactly what servers do not expose, so without this
//! a refused frame was an empty box with no explanation.

use serde::Serialize;

/// The two headers that decide whether a page may be framed, as the last response sent them.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramingHeaders {
    pub x_frame_options: Option<String>,
    pub csp: Option<String>,
}

/// Only web pages: never `file:`, a custom scheme, or anything a shell would read as more than one argument.
fn web_url(url: &str) -> Result<&str, String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("solo indirizzi http e https".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) || url.starts_with('-') {
        return Err("indirizzo non valido".into());
    }
    Ok(url)
}

/// Reads the headers of the last response in `curl -D -` output (one block per redirect).
fn last_block_headers(dump: &str) -> FramingHeaders {
    let mut headers = FramingHeaders::default();
    for line in dump.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with("HTTP/") {
            headers = FramingHeaders::default();
            continue;
        }
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim().to_string();
        match name.trim().to_ascii_lowercase().as_str() {
            "x-frame-options" => headers.x_frame_options = Some(value),
            "content-security-policy" => {
                // Several policies all apply; joined, a `frame-ancestors` in any of them is found.
                headers.csp = Some(match headers.csp.take() {
                    Some(previous) => format!("{previous}; {value}"),
                    None => value,
                })
            }
            _ => {}
        }
    }
    headers
}

fn curl() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        std::path::PathBuf::from(system_root).join("System32").join("curl.exe")
    }
    #[cfg(not(windows))]
    {
        std::path::PathBuf::from("curl")
    }
}

/// The framing headers of `url`, fetched the way a browser would reach it (redirects followed).
///
/// Returns only those two headers: the body is discarded, so this cannot be
/// used to read a page ADE's own fetch is not allowed to read.
#[tauri::command]
pub async fn ade_browser_framing(url: String) -> Result<FramingHeaders, String> {
    let url = web_url(&url)?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let mut command = std::process::Command::new(curl());
        command
            // Web schemes only, on the first request and on every redirect.
            .args(["-sS", "--proto", "=http,https", "--proto-redir", "=http,https"])
            .args(["-L", "--max-redirs", "5", "--max-time", "6", "-o", null, "-D", "-", "--"])
            .arg(&url)
            .stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let output = command.output().map_err(|e| format!("curl non eseguibile: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(last_block_headers(&String::from_utf8_lossy(&output.stdout)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a web page in the system browser, for a page that cannot be shown in the pane.
#[tauri::command]
pub async fn ade_open_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = web_url(&url)?.to_string();
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(url, None)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_urls_pass() {
        assert!(web_url("https://example.com/a?b=c").is_ok());
        assert!(web_url("HTTP://example.com").is_ok());
        assert!(web_url("file:///C:/Windows").is_err());
        assert!(web_url("javascript:alert(1)").is_err());
        assert!(web_url("https://example.com/a b").is_err());
        assert!(web_url("https://example.com/\n").is_err());
    }

    #[test]
    fn the_last_redirect_decides() {
        let dump = "HTTP/1.1 301 Moved\r\nLocation: https://b/\r\nX-Frame-Options: DENY\r\n\r\nHTTP/2 200\r\ncontent-security-policy: default-src 'self'\r\ncontent-security-policy: frame-ancestors 'none'\r\n\r\n";
        assert_eq!(
            last_block_headers(dump),
            FramingHeaders {
                x_frame_options: None,
                csp: Some("default-src 'self'; frame-ancestors 'none'".into()),
            }
        );
    }

    #[test]
    fn no_headers_is_nothing() {
        assert_eq!(last_block_headers("HTTP/2 200\r\ncontent-type: text/html\r\n\r\n"), FramingHeaders::default());
    }
}

//! Live event streaming from the nikcli service (`/global/event`, Server-Sent Events).
//!
//! The webview cannot hold an authenticated SSE connection (the password stays native), so Rust
//! keeps the connection, parses the frames and pushes one JSON value per event over an IPC channel.
use crate::service;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

#[derive(Default)]
pub struct Streams(pub Arc<Mutex<HashMap<String, JoinHandle<()>>>>);

/// `Connection` frames tell the UI whether the feed is live; everything else is a parsed event.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamEvent {
    Connection {
        state: &'static str,
        detail: Option<String>,
    },
    Event {
        data: serde_json::Value,
    },
}

/// Extracts complete SSE frames from `buf` (frames end with a blank line) and returns their `data:` payloads.
fn drain_frames(buf: &mut String) -> Vec<String> {
    let mut out = vec![];
    loop {
        let normalized = buf.replace("\r\n", "\n");
        let Some(end) = normalized.find("\n\n") else {
            *buf = normalized;
            return out;
        };
        let frame = normalized[..end].to_string();
        *buf = normalized[end + 2..].to_string();
        let data: Vec<&str> = frame
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(|d| d.trim_start())
            .collect();
        if !data.is_empty() {
            out.push(data.join("\n"));
        }
    }
}

#[tauri::command]
pub async fn event_stream(
    streams: State<'_, Streams>,
    id: String,
    service_url: String,
    path: String,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("path must start with /".into());
    }
    let mut map = streams.0.lock().await;
    if let Some(old) = map.remove(&id) {
        old.abort();
    }
    let handle = tokio::spawn(async move {
        let client = match reqwest::Client::builder().build() {
            Ok(c) => c,
            Err(e) => {
                let _ = on_event.send(StreamEvent::Connection {
                    state: "error",
                    detail: Some(e.to_string()),
                });
                return;
            }
        };
        loop {
            // Re-resolve every attempt: the service may have restarted with a new port or password.
            let Some(svc) = service::discover_services()
                .into_iter()
                .find(|s| s.url.trim_end_matches('/') == service_url.trim_end_matches('/'))
            else {
                if on_event
                    .send(StreamEvent::Connection {
                        state: "reconnecting",
                        detail: Some("service not registered".into()),
                    })
                    .is_err()
                {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            };
            let mut req = client
                .get(format!("{}{}", svc.url.trim_end_matches('/'), path))
                .header("accept", "text/event-stream");
            if let Some(pw) = service::password_for(&svc) {
                req = req.basic_auth("nikcli", Some(pw));
            }
            match req.send().await {
                Ok(mut res) if res.status().is_success() => {
                    if on_event
                        .send(StreamEvent::Connection {
                            state: "live",
                            detail: None,
                        })
                        .is_err()
                    {
                        return;
                    }
                    let mut buf = String::new();
                    loop {
                        match res.chunk().await {
                            Ok(Some(bytes)) => {
                                buf.push_str(&String::from_utf8_lossy(&bytes));
                                for data in drain_frames(&mut buf) {
                                    if let Ok(value) =
                                        serde_json::from_str::<serde_json::Value>(&data)
                                    {
                                        if on_event
                                            .send(StreamEvent::Event { data: value })
                                            .is_err()
                                        {
                                            return;
                                        }
                                    }
                                }
                            }
                            Ok(None) => break,
                            Err(e) => {
                                let _ = on_event.send(StreamEvent::Connection {
                                    state: "reconnecting",
                                    detail: Some(e.to_string()),
                                });
                                break;
                            }
                        }
                    }
                }
                Ok(res) => {
                    let _ = on_event.send(StreamEvent::Connection {
                        state: "error",
                        detail: Some(format!("HTTP {}", res.status())),
                    });
                }
                Err(e) => {
                    let _ = on_event.send(StreamEvent::Connection {
                        state: "reconnecting",
                        detail: Some(e.to_string()),
                    });
                }
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
    });
    map.insert(id, handle);
    Ok(())
}

#[tauri::command]
pub async fn event_stop(streams: State<'_, Streams>, id: String) -> Result<(), String> {
    if let Some(h) = streams.0.lock().await.remove(&id) {
        h.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::drain_frames;

    #[test]
    fn splits_frames_and_keeps_partial_tail() {
        let mut buf = "data: {\"a\":1}\n\ndata: {\"b\":2}\r\n\r\ndata: {\"c\"".to_string();
        assert_eq!(drain_frames(&mut buf), vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(buf, "data: {\"c\"");
        buf.push_str(":3}\n\n");
        assert_eq!(drain_frames(&mut buf), vec!["{\"c\":3}"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn joins_multiline_data_and_skips_comments() {
        let mut buf = ": keepalive\n\ndata: line1\ndata: line2\n\n".to_string();
        assert_eq!(drain_frames(&mut buf), vec!["line1\nline2"]);
    }
}

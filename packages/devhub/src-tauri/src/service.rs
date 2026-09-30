use crate::paths;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct Registration {
    id: String,
    pid: u32,
    url: String,
    version: String,
    #[serde(rename = "startedAt")]
    started_at: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub file: String,
    pub channel: String,
    pub id: String,
    pub pid: u32,
    pub url: String,
    pub version: String,
    pub started_at: u64,
    pub has_password: bool,
    /// The registered pid is a running nikcli process. A crashed service leaves its file behind.
    pub alive: bool,
}

pub fn read_password(file: &str) -> Option<String> {
    let stem = file.strip_suffix(".json")?;
    let raw = std::fs::read_to_string(paths::state_dir().join(format!("{stem}.password"))).ok()?;
    let trimmed = raw.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// The channel password for a discovered service, read from its 0600 file (never sent to the webview).
pub fn password_for(svc: &ServiceInfo) -> Option<String> {
    read_password(&svc.file)
}

fn channel_of(file: &str) -> String {
    match file
        .strip_prefix("service-")
        .and_then(|s| s.strip_suffix(".json"))
    {
        Some(c) => c.to_string(),
        None => "shared".into(),
    }
}

/// Every background service registered on this machine (one per channel).
#[tauri::command]
pub fn discover_services() -> Vec<ServiceInfo> {
    let Ok(rd) = std::fs::read_dir(paths::state_dir()) else {
        return vec![];
    };
    let mut sys = sysinfo::System::new();
    let mut out: Vec<ServiceInfo> = rd
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            if !(file == "service.json"
                || (file.starts_with("service-") && file.ends_with(".json")))
            {
                return None;
            }
            let reg: Registration =
                serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
            let pid = sysinfo::Pid::from_u32(reg.pid);
            sys.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[pid]),
                true,
                sysinfo::ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
            );
            // A reused pid must not pass for the service: require a nikcli/serve command line.
            let alive = sys.process(pid).is_some_and(|p| {
                let hay = format!(
                    "{} {}",
                    p.name().to_string_lossy(),
                    p.cmd()
                        .iter()
                        .map(|c| c.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" ")
                )
                .to_lowercase();
                hay.contains("nikcli") || hay.contains("serve")
            });
            Some(ServiceInfo {
                alive,
                channel: channel_of(&file),
                has_password: read_password(&file).is_some(),
                file,
                id: reg.id,
                pid: reg.pid,
                url: reg.url,
                version: reg.version,
                started_at: reg.started_at,
            })
        })
        .collect();
    out.sort_by(|a, b| b.alive.cmp(&a.alive).then(b.started_at.cmp(&a.started_at)));
    out
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequest {
    /// Must be the `url` of a discovered service: the proxy never talks to arbitrary hosts.
    pub service_url: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    /// Defaults to 60 s; long model calls pass more.
    pub timeout_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub elapsed_ms: f64,
}

/// Short proxied calls share a small pool of slots: a burst of UI polls queues here instead of
/// flooding the service (whose event loop is shared with running agent turns). Long calls
/// (a prompt that runs for minutes) do not take a slot.
fn slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(6))
}

/// Authenticated request to a local nikcli service. The password is read from
/// the channel's 0600 file here and never crosses into the webview.
#[tauri::command]
pub async fn api_request(req: ApiRequest) -> Result<ApiResponse, String> {
    let service = discover_services()
        .into_iter()
        .find(|s| s.url.trim_end_matches('/') == req.service_url.trim_end_matches('/'))
        .ok_or("unknown service url")?;
    if !req.path.starts_with('/') {
        return Err("path must start with /".into());
    }
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            req.timeout_secs.unwrap_or(60).min(1800),
        ))
        .build()
        .map_err(|e| e.to_string())?;
    let mut builder = client.request(
        method,
        format!("{}{}", service.url.trim_end_matches('/'), req.path),
    );
    if let Some(password) = read_password(&service.file) {
        builder = builder.basic_auth("nikcli", Some(password));
    }
    for (k, v) in &req.headers {
        let lower = k.to_lowercase();
        if lower == "authorization" || lower == "host" {
            continue;
        }
        builder = builder.header(k, v);
    }
    if let Some(body) = req.body {
        builder = builder.body(body);
    }
    let _slot = if req.timeout_secs.unwrap_or(60) <= 120 {
        slots().acquire().await.ok()
    } else {
        None
    };
    let started = Instant::now();
    let res = builder.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
        .collect();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        status,
        headers,
        body,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

// ── account ──────────────────────────────────────────────────────────────────

fn session_token_file() -> std::path::PathBuf {
    paths::data_dir().join("user-session.token")
}

fn service_for(url: &str) -> Result<ServiceInfo, String> {
    discover_services()
        .into_iter()
        .find(|s| s.url.trim_end_matches('/') == url.trim_end_matches('/'))
        .ok_or_else(|| "unknown service url".to_string())
}

fn client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

fn authed(b: reqwest::RequestBuilder, svc: &ServiceInfo) -> reqwest::RequestBuilder {
    match read_password(&svc.file) {
        Some(pw) => b.basic_auth("nikcli", Some(pw)),
        None => b,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub account_id: String,
    pub email: Option<String>,
    /// `/user/me` answered with a local user, i.e. this install is provisioned.
    pub provisioned: bool,
}

/// Waits for the browser approval (the service call blocks), stores the issuer token exactly as the
/// TUI does (`<data>/user-session.token`, 0600) and provisions the local user via `/user/me`.
/// The token itself never reaches the webview.
#[tauri::command]
pub async fn account_complete(
    service_url: String,
    device_code: String,
    expires_in: Option<u64>,
) -> Result<SignedIn, String> {
    let svc = service_for(&service_url)?;
    let body = serde_json::json!({ "deviceCode": device_code, "expiresIn": expires_in });
    let res = authed(
        client(expires_in.unwrap_or(600) + 30)?
            .post(format!(
                "{}/account/login/complete",
                svc.url.trim_end_matches('/')
            ))
            .json(&body),
        &svc,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    let status = res.status();
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("sign-in failed")
            .to_string());
    }
    let token = v
        .get("accessToken")
        .and_then(|t| t.as_str())
        .ok_or("the account service returned no token")?;
    let file = session_token_file();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, token).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
    }
    let me = authed(
        client(30)?.get(format!("{}/user/me", svc.url.trim_end_matches('/'))),
        &svc,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    let provisioned = me.status().is_success()
        && me
            .text()
            .await
            .map(|t| t.trim() != "null" && !t.trim().is_empty())
            .unwrap_or(false);
    Ok(SignedIn {
        account_id: v
            .get("accountID")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string(),
        email: v
            .get("email")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        provisioned,
    })
}

/// Signs this machine out: asks the service to drop the session, then removes the stored token.
#[tauri::command]
pub async fn account_sign_out(service_url: String) -> Result<(), String> {
    let svc = service_for(&service_url)?;
    // Best effort: the local token is what matters, the service may not have a session to drop.
    let _ = authed(
        client(15)?.post(format!("{}/user/logout", svc.url.trim_end_matches('/'))),
        &svc,
    )
    .send()
    .await;
    match std::fs::remove_file(session_token_file()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── model catalogue ──────────────────────────────────────────────────────────

/// The few fields of a model the UI needs. `/provider` is ~6 MB (every model of every provider, with
/// options and headers); parsing that in the webview blocks its main thread, so it is reduced here.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub provider_id: String,
    pub provider_name: String,
    pub model_id: String,
    pub name: String,
    pub input_cost: Option<f64>,
    pub output_cost: Option<f64>,
    pub context: Option<u64>,
    pub reasoning: bool,
}

/// Models of every *connected* provider — the ones a prompt can actually be sent to right now.
#[tauri::command]
pub async fn provider_models(service_url: String) -> Result<Vec<ModelRow>, String> {
    let svc = service_for(&service_url)?;
    let res = authed(
        client(60)?.get(format!("{}/provider", svc.url.trim_end_matches('/'))),
        &svc,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("GET /provider → {}", res.status()));
    }
    let body = res.bytes().await.map_err(|e| e.to_string())?;
    // Parsing a multi-megabyte document is CPU work: keep it off the async runtime threads.
    tokio::task::spawn_blocking(move || -> Result<Vec<ModelRow>, String> {
        let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        let connected: Vec<&str> = v
            .get("connected")
            .and_then(|c| c.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let mut rows = vec![];
        for p in v
            .get("all")
            .and_then(|a| a.as_array())
            .into_iter()
            .flatten()
        {
            let id = p.get("id").and_then(|x| x.as_str()).unwrap_or_default();
            if !connected.contains(&id) {
                continue;
            }
            let provider_name = p
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or(id)
                .to_string();
            for (_, m) in p
                .get("models")
                .and_then(|m| m.as_object())
                .into_iter()
                .flatten()
            {
                if m.get("status").and_then(|s| s.as_str()) == Some("deprecated") {
                    continue;
                }
                let model_id = m
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string();
                rows.push(ModelRow {
                    provider_id: id.to_string(),
                    provider_name: provider_name.clone(),
                    name: m
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or(&model_id)
                        .to_string(),
                    model_id,
                    input_cost: m
                        .get("cost")
                        .and_then(|c| c.get("input"))
                        .and_then(|x| x.as_f64()),
                    output_cost: m
                        .get("cost")
                        .and_then(|c| c.get("output"))
                        .and_then(|x| x.as_f64()),
                    context: m
                        .get("limit")
                        .and_then(|c| c.get("context"))
                        .and_then(|x| x.as_u64()),
                    reasoning: m
                        .get("capabilities")
                        .and_then(|c| c.get("reasoning"))
                        .and_then(|x| x.as_bool())
                        .unwrap_or(false),
                });
            }
        }
        rows.sort_by(|a, b| {
            a.provider_name
                .cmp(&b.provider_name)
                .then(a.name.cmp(&b.name))
        });
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

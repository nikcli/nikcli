use crate::paths;
use serde::Serialize;
use std::path::{Path, PathBuf};

fn is_repo(p: &Path) -> bool {
    p.join("packages")
        .join("nikcli")
        .join("package.json")
        .is_file()
}

fn stored() -> Option<PathBuf> {
    let raw = std::fs::read_to_string(paths::config_file()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(PathBuf::from(v.get("repoRoot")?.as_str()?))
}

fn detect() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("NIKCLI_REPO") {
        let p = PathBuf::from(v);
        if is_repo(&p) {
            return Some(p);
        }
    }
    let starts = [std::env::current_dir().ok(), std::env::current_exe().ok()];
    for start in starts.into_iter().flatten() {
        for dir in start.ancestors() {
            if is_repo(dir) {
                return Some(dir.to_path_buf());
            }
        }
    }
    None
}

pub fn root() -> Result<PathBuf, String> {
    stored()
        .filter(|p| is_repo(p))
        .or_else(detect)
        .ok_or_else(|| "nikcli repository not found — choose its folder in Settings".to_string())
}

/// Windows `canonicalize` yields `\\?\C:\…`; child processes (bun) want the plain form.
fn plain(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(rest) = p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        return PathBuf::from(rest);
    }
    p
}

/// Resolves a repo-relative path and refuses anything that escapes the repo.
pub fn resolve(rel: &str) -> Result<PathBuf, String> {
    let root = root()?.canonicalize().map_err(|e| e.to_string())?;
    let full = root
        .join(rel)
        .canonicalize()
        .map_err(|e| format!("{rel}: {e}"))?;
    if !full.starts_with(&root) {
        return Err("path escapes the repository".into());
    }
    Ok(plain(full))
}

#[tauri::command]
pub fn repo_root() -> Result<String, String> {
    root().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_repo_root(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !is_repo(&p) {
        return Err("not a nikcli repository (packages/nikcli/package.json missing)".into());
    }
    let file = paths::config_file();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, serde_json::json!({ "repoRoot": path }).to_string())
        .map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn read_repo_file(rel: String) -> Result<String, String> {
    let p = resolve(&rel)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 4 * 1024 * 1024 {
        return Err("file is larger than 4 MiB".into());
    }
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestFile {
    pub package: String,
    /// Relative to the package directory.
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

fn walk(dir: &Path, pkg: &str, pkg_dir: &Path, out: &mut Vec<TestFile>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if matches!(
                name.as_str(),
                "node_modules" | "dist" | "target" | ".git" | "runs" | "fixtures"
            ) {
                continue;
            }
            walk(&path, pkg, pkg_dir, out);
        } else if name.contains(".test.") || name.contains(".spec.") {
            let meta = e.metadata().ok();
            out.push(TestFile {
                package: pkg.to_string(),
                path: path
                    .strip_prefix(pkg_dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string(),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            });
        }
    }
}

/// Every test file in every workspace package.
#[tauri::command]
pub fn list_tests() -> Result<Vec<TestFile>, String> {
    let packages = root()?.join("packages");
    let mut out = vec![];
    for e in std::fs::read_dir(&packages)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let dir = e.path();
        if !dir.join("package.json").is_file() {
            continue;
        }
        let pkg = e.file_name().to_string_lossy().to_string();
        walk(&dir, &pkg, &dir, &mut out);
    }
    out.sort_by(|a, b| (&a.package, &a.path).cmp(&(&b.package, &b.path)));
    Ok(out)
}

/// Stored benchmark runs (newest first) and the recorded perf baseline.
#[tauri::command]
pub fn read_benchmarks() -> Result<serde_json::Value, String> {
    let nikcli = root()?.join("packages").join("nikcli");
    let runs_dir = nikcli.join("test").join("benchmarks").join("runs");
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&runs_dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
                .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let runs: Vec<serde_json::Value> = files
        .into_iter()
        .take(60)
        .filter_map(|(_, p)| serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok())
        .collect();
    let baseline = std::fs::read_to_string(nikcli.join("specs").join("perf-baseline.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    Ok(serde_json::json!({ "runs": runs, "baseline": baseline, "runsDir": runs_dir }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    pub name: String,
    pub location: &'static str,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

/// What nikcli keeps on disk: databases, logs, snapshots, worktrees.
#[tauri::command]
pub fn storage_report() -> Vec<StorageEntry> {
    let mut out = vec![];
    for (location, dir) in [("data", paths::data_dir()), ("state", paths::state_dir())] {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let mut budget = 200_000;
            out.push(StorageEntry {
                name: e.file_name().to_string_lossy().to_string(),
                location,
                path: e.path().to_string_lossy().to_string(),
                size: paths::dir_size(&e.path(), &mut budget),
                is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
            });
        }
    }
    out.sort_by(|a, b| b.size.cmp(&a.size));
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub size: u64,
    pub modified: u64,
}

#[tauri::command]
pub fn list_logs() -> Vec<LogFile> {
    let Ok(rd) = std::fs::read_dir(paths::data_dir().join("log")) else {
        return vec![];
    };
    let mut out: Vec<LogFile> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file().then(|| LogFile {
                name: e.file_name().to_string_lossy().to_string(),
                size: m.len(),
                modified: m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            })
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

#[tauri::command]
pub fn tail_log(name: String, bytes: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid log name".into());
    }
    let mut f =
        std::fs::File::open(paths::data_dir().join("log").join(name)).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let take = bytes.min(len).min(2 * 1024 * 1024);
    f.seek(SeekFrom::Start(len - take))
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(take as usize);
    f.take(take)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Writes a scratch file under `<repo>/.devhub/` and returns its repo-relative path.
#[tauri::command]
pub fn write_scratch(name: String, content: String) -> Result<String, String> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        || name.starts_with('.')
    {
        return Err("invalid scratch file name".into());
    }
    if content.len() > 1024 * 1024 {
        return Err("scratch file is larger than 1 MiB".into());
    }
    let dir = root()?.join(".devhub");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&name), content).map_err(|e| e.to_string())?;
    Ok(format!(".devhub/{name}"))
}

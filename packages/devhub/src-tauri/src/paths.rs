use std::path::PathBuf;

const APP: &str = "nikcli";

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// `%LOCALAPPDATA%`, with the same fallback nikcli uses.
#[cfg(windows)]
fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("AppData").join("Local"))
}

/// Mirrors `xdgPath` in `@nikcli-ai/util/global`: XDG on macOS/Linux (env first, dotfile fallback under
/// `$HOME`), the AppData layout on Windows where XDG variables are ignored on purpose.
fn xdg(var: &str, posix_fallback: &[&str], _windows_root: impl FnOnce() -> PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let _ = (var, posix_fallback);
        return _windows_root().join(APP);
    }
    #[cfg(not(windows))]
    {
        let base = match std::env::var(var) {
            Ok(v) if !v.is_empty() => PathBuf::from(v),
            _ => posix_fallback.iter().fold(home(), |p, part| p.join(part)),
        };
        base.join(APP)
    }
}

/// Mirrors `Global.Path.state` (service registrations, passwords, kv).
pub fn state_dir() -> PathBuf {
    #[cfg(windows)]
    let root = || local_app_data().join("State");
    #[cfg(not(windows))]
    let root = PathBuf::new;
    xdg("XDG_STATE_HOME", &[".local", "state"], root)
}

/// Mirrors `Global.Path.data` (databases, logs, session token), including the `NIKCLI_DATA_DIR` override.
pub fn data_dir() -> PathBuf {
    if let Ok(v) = std::env::var("NIKCLI_DATA_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v.trim());
        }
    }
    #[cfg(windows)]
    let root = local_app_data;
    #[cfg(not(windows))]
    let root = PathBuf::new;
    xdg("XDG_DATA_HOME", &[".local", "share"], root)
}

pub fn config_file() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_default()
        .join("ai.nikcli.devhub")
        .join("settings.json")
}

pub fn dir_size(path: &std::path::Path, budget: &mut u32) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() || *budget == 0 {
        return 0;
    }
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0;
    for entry in rd.flatten() {
        *budget = budget.saturating_sub(1);
        total += dir_size(&entry.path(), budget);
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn posix_layout_follows_xdg_with_dotfile_fallback() {
        std::env::set_var("XDG_STATE_HOME", "/tmp/xs");
        std::env::set_var("XDG_DATA_HOME", "/tmp/xd");
        std::env::remove_var("NIKCLI_DATA_DIR");
        assert_eq!(state_dir(), PathBuf::from("/tmp/xs/nikcli"));
        assert_eq!(data_dir(), PathBuf::from("/tmp/xd/nikcli"));
        std::env::set_var("NIKCLI_DATA_DIR", "/tmp/custom");
        assert_eq!(data_dir(), PathBuf::from("/tmp/custom"));
        std::env::remove_var("NIKCLI_DATA_DIR");
        std::env::remove_var("XDG_STATE_HOME");
        assert_eq!(
            state_dir(),
            home().join(".local").join("state").join("nikcli")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_layout_ignores_xdg_and_uses_localappdata() {
        std::env::set_var("LOCALAPPDATA", r"C:\Users\u\AppData\Local");
        std::env::set_var("XDG_STATE_HOME", r"C:\ignored");
        std::env::remove_var("NIKCLI_DATA_DIR");
        assert_eq!(
            data_dir(),
            PathBuf::from(r"C:\Users\u\AppData\Local").join("nikcli")
        );
        assert_eq!(
            state_dir(),
            PathBuf::from(r"C:\Users\u\AppData\Local")
                .join("State")
                .join("nikcli")
        );
    }
}

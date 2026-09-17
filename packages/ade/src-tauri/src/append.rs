//! Appending a line to a project file, for logs more than one writer adds to.
//!
//! The decisions register (`.ade/decisions.jsonl`) is written by ADE when the
//! user answers and by Master from a shell with `>>`. `write_text_file` reads
//! nothing and replaces the whole file with a rename, so a line appended from
//! the shell between ADE's read and ADE's rename disappeared without an error.
//! An append opened with `O_APPEND` (`FILE_APPEND_DATA` on Windows) adds to
//! whatever the file holds at that instant, and two appenders keep both lines.
//!
//! Same confinement as every write: only inside the roots the window opened.

use std::io::Write;

use crate::{within_roots, WriteRoots};

/// The longest text one append may add; a line in a register is a few hundred bytes.
const MAX_APPEND_BYTES: usize = 1024 * 1024;

#[tauri::command]
pub async fn append_text_file(roots: tauri::State<'_, WriteRoots>, path: String, text: String) -> Result<(), String> {
    append_confined(&roots, &path, &text)
}

fn append_confined(roots: &WriteRoots, path: &str, text: &str) -> Result<(), String> {
    if text.len() > MAX_APPEND_BYTES {
        return Err("testo troppo lungo per un'aggiunta".into());
    }
    let target = within_roots(roots, path)?;
    if target.is_dir() {
        return Err(format!("il percorso è una directory: {path}"));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{path}: {e}"))?;
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(|e| format!("{path}: {e}"))?;
    // One write call: the line goes in whole or the call fails.
    file.write_all(text.as_bytes()).map_err(|e| format!("{path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("test-tmp")
                .join(format!("append-{tag}-{nanos}"));
            std::fs::create_dir_all(&path).expect("temp dir");
            TempDir(path)
        }

        fn roots(&self) -> WriteRoots {
            let roots = WriteRoots::default();
            roots.0.lock().unwrap().push(self.0.canonicalize().expect("canonical"));
            roots
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_the_file_and_its_folder_then_keeps_what_others_appended() {
        let dir = TempDir::new("keep");
        let file = dir.0.join(".ade").join("decisions.jsonl");
        let path = file.to_string_lossy().to_string();
        append_confined(&dir.roots(), &path, "{\"k\":\"D1\"}\n").unwrap();
        // Master, from a shell, in between.
        std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(b"{\"k\":\"D2\"}\n").unwrap();
        append_confined(&dir.roots(), &path, "{\"k\":\"D3\"}\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"k\":\"D1\"}\n{\"k\":\"D2\"}\n{\"k\":\"D3\"}\n");
    }

    #[test]
    fn refuses_outside_the_project_and_a_directory() {
        let project = TempDir::new("project");
        let other = TempDir::new("other");
        assert!(append_confined(&project.roots(), &other.0.join("x.jsonl").to_string_lossy(), "x").is_err());
        assert!(append_confined(&project.roots(), &project.0.to_string_lossy(), "x").is_err());
    }
}

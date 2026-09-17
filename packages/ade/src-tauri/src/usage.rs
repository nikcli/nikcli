//! What a session has spent, read from the transcript its CLI keeps on disk.
//!
//! The point is the cache: whether spawned sessions actually reuse each other's
//! prompt prefix is a number in these files, not a guess. Two formats:
//!
//! - Claude Code, `~/.claude/projects/<cwd with every non-alphanumeric as ->/<id>.jsonl`:
//!   each assistant entry carries `message.usage`, repeated once per content
//!   block of the same message, so entries are counted once per `message.id`.
//!   `input_tokens` there excludes the cache; the prompt is input + creation + read.
//! - Codex, `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`: `token_count`
//!   events carry a running `total_token_usage`, where `input_tokens` already
//!   includes `cached_input_tokens`. The last one is the total.
//!
//! Transcripts grow to megabytes, so each file is read from where the previous
//! call stopped, and only whole lines.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Prompt tokens billed at the full rate.
    pub input: u64,
    /// Prompt tokens read from the cache.
    pub cache_read: u64,
    /// Prompt tokens written to the cache.
    pub cache_write: u64,
    pub output: u64,
    /// Model requests counted.
    pub requests: u64,
}

#[derive(Default)]
struct FileState {
    offset: u64,
    usage: Usage,
    seen: HashSet<String>,
    /// The `Files::clock` of the last call that asked about this file.
    last_used: u64,
}

/*
 * How many transcripts are remembered at once.
 *
 * Every session a pane has ever shown leaves its file here, message ids and
 * all, and a window left open for a week of work is hundreds of sessions
 * nobody is looking at any more. Far more than the panes a screen can hold,
 * so a file still on screen is never the one let go.
 *
 * Forgetting a file costs nothing but time: the next call about it reads it
 * again from the start and arrives at the same totals. That is also why the
 * message ids inside a file are not capped — dropping some of those would let
 * a repeated entry be counted twice, and the number would stop being true.
 */
const MAX_FILES: usize = 256;

#[derive(Default)]
struct Files {
    by_path: HashMap<PathBuf, FileState>,
    /// Ticks once per call; orders the files by when they were last wanted.
    clock: u64,
}

#[derive(Default)]
pub struct UsageCache {
    files: Mutex<Files>,
    codex_paths: Mutex<HashMap<String, PathBuf>>,
}

/// Lets go of the least recently wanted files until at most `cap` are left.
fn evict_stale(files: &mut HashMap<PathBuf, FileState>, cap: usize) {
    while files.len() > cap {
        let Some(oldest) = files
            .iter()
            .min_by_key(|(_, state)| state.last_used)
            .map(|(path, _)| path.clone())
        else {
            return;
        };
        files.remove(&oldest);
    }
}

fn valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Claude Code's folder for a working directory. Mirrors `claudeTranscript` in `resume.ts`.
pub fn claude_folder(cwd: &str) -> Option<String> {
    let folder: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    (folder.len() <= 200).then_some(folder)
}

fn find_codex(root: &Path, id: &str, depth: u8) -> Option<PathBuf> {
    let suffix = format!("-{id}.jsonl");
    let mut entries: Vec<_> = fs::read_dir(root).ok()?.flatten().collect();
    // Newest folders first: a live session is almost always today's.
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                if let Some(found) = find_codex(&path, id, depth - 1) {
                    return Some(found);
                }
            }
        } else if entry.file_name().to_string_lossy().ends_with(&suffix) {
            return Some(path);
        }
    }
    None
}

/// Adds the usage in `chunk` (whole JSONL lines) to `state`.
fn accumulate(agent: &str, chunk: &str, state: &mut FileState) {
    for line in chunk.lines() {
        match agent {
            "claude-code" => {
                if !line.contains("\"usage\"") {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let Some(message) = value.get("message") else { continue };
                let Some(usage) = message.get("usage") else { continue };
                let key = message
                    .get("id")
                    .and_then(|id| id.as_str())
                    .map(str::to_string)
                    .or_else(|| value.get("uuid").and_then(|id| id.as_str()).map(str::to_string));
                if let Some(key) = key {
                    if !state.seen.insert(key) {
                        continue;
                    }
                }
                let n = |field: &str| usage.get(field).and_then(|v| v.as_u64()).unwrap_or(0);
                state.usage.input += n("input_tokens");
                state.usage.cache_read += n("cache_read_input_tokens");
                state.usage.cache_write += n("cache_creation_input_tokens");
                state.usage.output += n("output_tokens");
                state.usage.requests += 1;
            }
            "codex" => {
                if !line.contains("token_count") {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let Some(total) = value.pointer("/payload/info/total_token_usage") else { continue };
                let n = |field: &str| total.get(field).and_then(|v| v.as_u64()).unwrap_or(0);
                let cached = n("cached_input_tokens");
                // Running totals: replaced, not added.
                state.usage.input = n("input_tokens").saturating_sub(cached);
                state.usage.cache_read = cached;
                state.usage.cache_write = n("cache_write_input_tokens");
                state.usage.output = n("output_tokens");
                state.usage.requests += 1;
            }
            _ => {}
        }
    }
}

fn read_new(agent: &str, path: &Path, state: &mut FileState) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len < state.offset {
        // Rewritten or truncated: start over. Still the file this call wants,
        // so it keeps its place in the eviction order.
        *state = FileState { last_used: state.last_used, ..FileState::default() };
    }
    if len == state.offset {
        return Ok(());
    }
    file.seek(SeekFrom::Start(state.offset)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity((len - state.offset) as usize);
    file.take(len - state.offset).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    // Only whole lines; the rest is read next time.
    let Some(end) = bytes.iter().rposition(|&b| b == b'\n') else { return Ok(()) };
    let chunk = String::from_utf8_lossy(&bytes[..=end]);
    accumulate(agent, &chunk, state);
    state.offset += end as u64 + 1;
    Ok(())
}

/// The usage of one session so far, or `None` when its transcript is not found.
#[tauri::command]
pub async fn transcript_usage(
    cache: tauri::State<'_, UsageCache>,
    agent: String,
    session_id: String,
    cwd: String,
) -> Result<Option<Usage>, String> {
    if !valid_session_id(&session_id) {
        return Err("id sessione non valido".into());
    }
    let home = home().ok_or("cartella utente non trovata")?;
    let path = match agent.as_str() {
        "claude-code" => {
            let Some(folder) = claude_folder(&cwd) else { return Ok(None) };
            home.join(".claude").join("projects").join(folder).join(format!("{session_id}.jsonl"))
        }
        "codex" => {
            let known = cache.codex_paths.lock().map_err(|_| "cache bloccata")?.get(&session_id).cloned();
            match known.filter(|p| p.is_file()) {
                Some(path) => path,
                None => {
                    let Some(found) = find_codex(&home.join(".codex").join("sessions"), &session_id, 3) else {
                        return Ok(None);
                    };
                    cache
                        .codex_paths
                        .lock()
                        .map_err(|_| "cache bloccata")?
                        .insert(session_id.clone(), found.clone());
                    found
                }
            }
        }
        _ => return Ok(None),
    };
    if !path.is_file() {
        return Ok(None);
    }
    let mut files = cache.files.lock().map_err(|_| "cache bloccata")?;
    let files = &mut *files;
    files.clock += 1;
    let clock = files.clock;
    // Before the lookup, and with room for it: the file this call is about
    // has not been stamped yet, so it must not be counted against the cap.
    if !files.by_path.contains_key(&path) {
        evict_stale(&mut files.by_path, MAX_FILES - 1);
    }
    let state = files.by_path.entry(path.clone()).or_default();
    state.last_used = clock;
    read_new(&agent, &path, state)?;
    Ok(Some(state.usage))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_counts_each_message_once() {
        let mut state = FileState::default();
        let line = |id: &str, read: u64| {
            format!(
                r#"{{"type":"assistant","message":{{"id":"{id}","usage":{{"input_tokens":2,"cache_creation_input_tokens":10,"cache_read_input_tokens":{read},"output_tokens":5}}}}}}"#
            )
        };
        let chunk = [line("m1", 100), line("m1", 100), line("m2", 300), r#"{"type":"user"}"#.to_string()].join("\n");
        accumulate("claude-code", &chunk, &mut state);
        assert_eq!(
            state.usage,
            Usage { input: 4, cache_read: 400, cache_write: 20, output: 10, requests: 2 }
        );
    }

    #[test]
    fn codex_keeps_the_running_total() {
        let mut state = FileState::default();
        let line = |input: u64, cached: u64| {
            format!(
                r#"{{"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"cache_write_input_tokens":0,"output_tokens":7}}}}}}}}"#
            )
        };
        accumulate("codex", &[line(1000, 0), line(3000, 1800)].join("\n"), &mut state);
        assert_eq!(state.usage.input, 1200);
        assert_eq!(state.usage.cache_read, 1800);
        assert_eq!(state.usage.output, 7);
    }

    #[test]
    fn a_file_is_read_incrementally_and_only_by_whole_lines() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp").join(format!(
            "usage-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let one = r#"{"message":{"id":"a","usage":{"input_tokens":1,"cache_read_input_tokens":9,"output_tokens":1}}}"#;
        let two = r#"{"message":{"id":"b","usage":{"input_tokens":1,"cache_read_input_tokens":90,"output_tokens":1}}}"#;
        fs::write(&path, format!("{one}\n{}", &two[..20])).unwrap();
        let mut state = FileState::default();
        read_new("claude-code", &path, &mut state).unwrap();
        assert_eq!(state.usage.cache_read, 9);
        fs::write(&path, format!("{one}\n{two}\n")).unwrap();
        read_new("claude-code", &path, &mut state).unwrap();
        assert_eq!(state.usage.cache_read, 99);
        assert_eq!(state.usage.requests, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_files_let_go_are_the_ones_nobody_asked_about_lately() {
        let mut files: HashMap<PathBuf, FileState> = (0..5)
            .map(|n| (PathBuf::from(format!("{n}.jsonl")), FileState { last_used: n, ..FileState::default() }))
            .collect();
        // Asked about again just now, so the oldest by position is not the oldest by use.
        files.get_mut(Path::new("0.jsonl")).unwrap().last_used = 10;

        evict_stale(&mut files, 3);

        let mut kept: Vec<_> = files.keys().map(|p| p.to_string_lossy().into_owned()).collect();
        kept.sort();
        assert_eq!(kept, ["0.jsonl", "3.jsonl", "4.jsonl"]);
    }

    #[test]
    fn a_cache_within_its_cap_is_left_alone() {
        let mut files: HashMap<PathBuf, FileState> =
            (0..3).map(|n| (PathBuf::from(format!("{n}.jsonl")), FileState::default())).collect();
        evict_stale(&mut files, 3);
        assert_eq!(files.len(), 3);
    }

    #[test]
    fn ids_and_folders() {
        assert!(valid_session_id("01a0a0fa-d7cb-7571-8836-4606f8b4eb68"));
        assert!(!valid_session_id("../../etc/passwd"));
        assert_eq!(claude_folder("C:\\Users\\x\\repo").as_deref(), Some("C--Users-x-repo"));
    }
}

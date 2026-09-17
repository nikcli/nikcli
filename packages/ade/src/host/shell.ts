/**
 * The one place ADE talks to the machine.
 *
 * In the desktop shell this runs real processes through Tauri; in the browser
 * harness there is nothing to run and every entry point returns undefined, so
 * callers branch on absence once instead of asking "am I in Tauri?" everywhere.
 *
 * Nothing above this file imports @tauri-apps directly: the browser build must
 * not fail to load because a desktop-only module is missing.
 */

export interface SpawnedSession {
  /** Kills the process; with `tree`, the processes it started too. Safe to call more than once. */
  kill: (options?: { tree?: boolean }) => void
  /**
   * Types into the session's terminal, exactly as given.
   *
   * Nothing is appended. What a pty receives is keystrokes, and Enter, Ctrl-C,
   * an arrow key and the "y" that answers a permission prompt are all
   * keystrokes: deciding where a line ends belongs to whoever is typing, so
   * callers send their own "\r".
   */
  write: (data: string) => void
  /**
   * Tells the CLI how big its terminal is.
   *
   * An agent that draws a full-screen interface asks this and nothing else. Left
   * at whatever the pane measured on the first frame, every later redraw wraps
   * against a width that stopped being true the moment anything was dragged.
   */
  resize: (cols: number, rows: number) => void
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface DirEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified_ms: number
}

export interface FileRead {
  text: string
  truncated: boolean
  bytes: number
}

export interface Host {
  /** Runs `command arg` and returns its output, or null when it cannot run. */
  probe: (command: string, arg: string) => Promise<string | null>
  /**
   * Runs a command to completion and hands back everything it said.
   * Used for git, where the answer matters more than the stream, and where a
   * non-zero exit is often information rather than a failure.
   *
   * `env` extends the inherited environment rather than replacing it. It exists
   * for GIT_INDEX_FILE, which git accepts only as a variable: staging into a
   * throwaway index is the one way to snapshot the working tree without
   * touching the index the user is working in.
   */
  run: (command: string, args: string[], cwd?: string, env?: Record<string, string>) => Promise<RunResult>
  /**
   * Starts `command args` in `cwd` under a real pseudo-terminal.
   *
   * A pty rather than pipes because every agent CLI asks whether it is talking
   * to a terminal and becomes a different program when the answer is no —
   * Claude Code switches itself into `--print` and exits, the others drop their
   * prompt or their colours. `onData` carries the raw stream, escape sequences
   * included, for whatever emulator is drawing it; `onLine` is the same stream
   * read a second way, stripped and split, for the code that only wants to
   * notice what the agent said.
   */
  spawn: (input: {
    command: string
    args: string[]
    cwd?: string
    /** Terminal size at start. The CLI draws its first frame against this. */
    cols?: number
    rows?: number
    onData?: (chunk: string) => void
    onLine: (line: string, stream: "out" | "err") => void
    onExit: (code: number | null) => void
    /**
     * Lets the CLI report which conversation it opened.
     *
     * Passed only for an agent whose reporting hook is installed. The host
     * turns it into three environment variables the hook looks for; without
     * it they are not set, and a hook that is installed does nothing. See
     * `session-new/agent-link.ts`.
     */
    link?: { pane: string; nonce: string }
    /** The pane this process belongs to: what `ade-msg` calls the session. */
    pane?: string
    /** Proves a message comes from `pane`: set as `ADE_PANE_TOKEN`, sent back by `ade-msg`. */
    paneToken?: string
    /**
     * Pipes instead of a terminal: stdin is read as data, not keystrokes. Only
     * Claude Code, for a process kept running between turns (`bots/warm.ts`).
     * `resize` does nothing then.
     */
    pipe?: boolean
    /**
     * API keys to put in the process's environment, by name. The host reads
     * the values from the system keychain; they never pass through here.
     */
    secrets?: string[]
  }) => Promise<SpawnedSession>

  // -- API keys (see `src-tauri/src/secrets.rs`) ----------------------------
  /** Names, variables, agents and a masked tail; never a value. */
  listSecrets?: () => Promise<KeyInfo[]>
  /** Saves a key; `value` absent keeps the stored one. Rejects with the reason. */
  saveSecret?: (draft: KeyDraft) => Promise<void>
  deleteSecret?: (name: string) => Promise<void>
  /** The keys assigned to the agent `command` starts, from the index only: names and variables. */
  assignedSecrets?: (command: string) => Promise<{ name: string; env: string }[]>
  /** Copies a key to the clipboard from the host; resolves to the seconds before it is cleared. */
  copySecret?: (name: string) => Promise<number>

  // -- Messages between sessions (see `src-tauri/src/mailbox.rs`) -----------
  /** Takes every message `ade-msg send` has dropped since the last call. */
  mailboxTake?: () => Promise<{ id: string; body: string }[]>
  /** Answers the `ade-msg send` that is waiting on message `id`. */
  mailboxReceipt?: (id: string, text: string) => Promise<void>
  /** Replaces the list `ade-msg list` (sessions) or `ade-msg agents` prints. */
  mailboxPublish?: (text: string, name?: "sessions" | "agents" | "requests" | "usage" | "stats") => Promise<void>
  /**
   * A PNG of ADE's own window, cropped and with the sensitive rectangles
   * painted over before it reaches the disk (S35). ADE Test only for now.
   */
  /** Whether this build lets an agent see ADE at all (S35: ADE Test for now). */
  visionAllowed?: () => Promise<boolean>
  captureWindow?: (request: {
    label: string
    crop?: { x: number; y: number; w: number; h: number }
    redact: { x: number; y: number; w: number; h: number }[]
    scale: number
  }) => Promise<{ path: string; width: number; height: number; bytes: number }>
  /** The same capture, written to `path` in the project's `.ade/browser` (S46). */
  browserShot?: (request: {
    path: string
    crop: { x: number; y: number; w: number; h: number }
    redact: { x: number; y: number; w: number; h: number }[]
    scale: number
  }) => Promise<{ path: string; width: number; height: number }>
  /** Tokens a claude or codex session has spent so far, from its transcript; null when not found. */
  transcriptUsage?: (agent: string, sessionId: string, cwd: string) => Promise<TokenUsage | null>
  /** What request `id` is waiting on, printed by the `ade-msg wait` on it; empty removes it. */
  mailboxState?: (id: string, text: string, kind?: "state" | "update") => Promise<void>
  /**
   * Records the window, or a rectangle of it, to `dir/name.mp4` (S36).
   *
   * The system's own capture, so the frames are the window's composed pixels
   * rather than a picture of the screen. Only one take at a time.
   */
  recordStart?: (
    target: RecordTarget,
    dir: string,
    name: string,
    quality?: { fps: number; width?: number; height?: number; bitrate?: number },
  ) => Promise<RecordingState>
  recordStop?: () => Promise<RecordingState>
  recordState?: () => Promise<RecordingState>
  /**
   * Writes one track of a recent take (events, voice, microphone, promo).
   * The take's folder is not a write root: this is the only way in.
   */
  recordWrite?: (path: string, contents: Uint8Array) => Promise<void>
  /** The mailbox folder (per worktree in ADE Test, see `ADE_MAILBOX_ROOT`). */
  mailboxDir?: () => Promise<string>
  /** Leaves a long message for pane `pane` to read with `ade-msg inbox`. */
  mailboxInboxPut?: (pane: string, name: string, text: string) => Promise<void>
  /** Whether pane `pane` has read message `name` (the file left its inbox). */
  mailboxInboxRead?: (pane: string, name: string) => Promise<boolean>
  /** The answer to request `id`, for the `ade-msg ask|spawn|wait` blocked on it. */
  mailboxResult?: (id: string, text: string) => Promise<void>
  /** Takes back an answer no waiter claimed; its text, or null if one did. */
  mailboxResultReclaim?: (id: string, kind?: "result" | "update") => Promise<string | null>

  // -- The assistant's Piper voice (see `src-tauri/src/tts.rs`) ------------
  ttsPiperStatus?: (voice: string) => Promise<{ supported: boolean; installed: boolean }>
  /** Downloads the Piper runtime and the voice, checked against pinned digests. */
  ttsPiperInstall?: (voice: string) => Promise<void>
  /** One sentence as WAV bytes, from the resident Piper process. */
  ttsPiperSpeak?: (voice: string, text: string) => Promise<ArrayBuffer>
  /** Opens the model page of a known voice in the browser. */
  ttsOpenVoiceSource?: (voice: string) => Promise<void>

  // -- Filesystem access (backed by dedicated Tauri commands) ---------------
  readDir?: (path: string) => Promise<DirEntry[]>
  readTextFile?: (path: string, maxBytes?: number) => Promise<FileRead>
  writeTextFile?: (path: string, contents: string) => Promise<string | null>
  /**
   * Adds `text` at the end of a project file, creating it; resolves to the
   * failure. A real append: a line another process added meanwhile stays.
   */
  appendTextFile?: (path: string, text: string) => Promise<string | null>
  /**
   * The same write for content that is not text; resolves to the failure.
   *
   * Needed by the video panel, whose frame captures are PNGs: base64 through
   * `writeTextFile` would write the text of the image rather than the image.
   */
  writeBytes?: (path: string, contents: Uint8Array) => Promise<string | null>
  /**
   * A project file's bytes, whole; rejects outside every open project or
   * above `maxBytes`. For the 3D panel, whose models and textures are binary.
   */
  readBytes?: (path: string, maxBytes: number) => Promise<Uint8Array>
  currentDir?: () => Promise<string>
  homeDir?: () => Promise<string>
  exists?: (path: string) => Promise<boolean>

  /**
   * Declares a directory this window may write inside.
   *
   * Writing, linking and deleting are refused outside the roots declared here,
   * and nothing is declared until a project is discovered. The gate exists
   * because the commands behind `writeTextFile` and `writeBytes` answer to
   * whatever is running in the window — including a page loaded in the browser
   * pane, which is not ADE's own interface and should not be able to drop a
   * file into the user's startup folder.
   *
   * Absent in the browser harness, which cannot write at all.
   */
  allowWriteRoot?: (path: string) => Promise<void>

  /** Opens a native directory picker. Returns the chosen path, or undefined when the user cancels. */
  pickDirectory?: (title?: string) => Promise<string | undefined>

  /**
   * Opens a native file picker, narrowed to the extensions given.
   *
   * Separate from `pickDirectory` rather than a flag on it, because the two
   * are used by different panels and a caller that passed the wrong flag
   * would get a dialog that cannot select what it is asking for.
   */
  pickFile?: (options?: {
    title?: string
    /** e.g. `{ name: "Video", extensions: ["mp4", "webm"] }` */
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<string | undefined>

  // -- The agent's own report of its session id ------------------------------

  /**
   * The report a CLI's hook left for this spawn, as text, or null.
   *
   * Text and not a parsed object: the file is written by a shell script, and
   * deciding whether to believe it belongs in `session-new/agent-link.ts`,
   * where it is tested, rather than in the host or in Rust.
   */
  readAgentLink?: (nonce: string) => Promise<string | null>
  /** Forgets a report that has been taken. */
  clearAgentLink?: (nonce: string) => Promise<void>
  /** The last turn start or end the CLI's hook wrote for this spawn, as text, or null. */
  readAgentActivity?: (nonce: string) => Promise<string | null>
  /**
   * One CLI's hook configuration, so ADE can show its state and merge into it.
   *
   * `agent` is an id from `HOOK_TARGETS`; anything else is refused by the
   * command, which is what keeps this from being a way to read any file.
   */
  readAgentHook?: (agent: string) => Promise<AgentHookFiles>
  /**
   * Writes the merged configuration back, installing or removing the script.
   *
   * `script: null` removes it. Both halves in one call, so there is never a
   * configuration pointing at a script that is not there.
   */
  writeAgentHook?: (agent: string, configText: string, script: string | null) => Promise<void>
  /** `nikcli models` or `nikcli agent create …`: the only nikcli commands the bots panel runs. */
  nikcliBot?: (args: string[], cwd?: string) => Promise<RunResult>
  /** Deletes a bot's `.md` file; resolves to the failure, or null. */
  deleteBotFile?: (path: string) => Promise<string | null>
  /** What ADE and its processes spend, for the sidebar footer. Mirrors `stats.rs`. */
  systemStats?: () => Promise<SystemStats>
}

/** ADE only: this app, its webview and every agent it started. */
export interface SystemStats {
  /** CPU used by ADE's processes, 0–100 of the machine's capacity. */
  cpu: number
  /** Resident memory of ADE's processes, in bytes. */
  appMem: number
  /** The machine's RAM, as the base for the percentage. */
  ramTotal: number
  processes: number
}

/** What `readAgentHook` answers. Mirrors `HookFiles` in `agent_link.rs`. */
export interface AgentHookFiles {
  configPath: string
  configText: string | null
  scriptPath: string
  scriptPresent: boolean
}

// Moved to `./ansi` so `./line-stream` can use it without importing the host,
// which would be a cycle. Re-exported because callers already import it here.
export { stripAnsi } from "./ansi"

import { createLineAccumulator } from "./line-stream"
import type { TokenUsage } from "../session/shared"
import type { KeyDraft, KeyInfo } from "../secrets/keys"
import type { QualityLevel, RecordTarget, RecordingState } from "../record/recording"

const inTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)

let cached: Host | undefined | null = null

/** The host for this build, or undefined in the browser harness. */
export async function getHost(): Promise<Host | undefined> {
  if (cached !== null) return cached ?? undefined
  if (!inTauri()) {
    cached = undefined
    return undefined
  }

  cached = {
    async probe(command, _arg) {
      /*
       * Looked up on PATH rather than run.
       *
       * The new-session form asks this about every agent at once, and running
       * ten CLIs to find out which exist costs a visible pause, wakes up
       * whatever update checks they each do at startup, and — for the ones that
       * are shell shims rather than executables — is refused by the shell
       * allowlist anyway. PATHEXT resolution lives on the Rust side, which is
       * what makes an npm-installed `opencode.cmd` answer to `opencode`.
       */
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        return await invoke<string | null>("pty_which", { command })
      } catch {
        return null
      }
    },

    async run(command, args, cwd, env) {
      /*
       * git, and only git.
       *
       * Every caller of `run` in this package runs git — the agents go through
       * `spawn` and a pty instead — so rather than keep a general "run a
       * program" door open for one program, this goes to a command that knows
       * it is running git and can check the arguments accordingly. The shell
       * plugin could only check them by position, which for git meant allowing
       * any argument at all, and `git -c core.pager=<anything>` runs anything.
       */
      if (command !== "git") {
        return { code: null, stdout: "", stderr: `comando non consentito: ${command}` }
      }

      const { invoke } = await import("@tauri-apps/api/core")
      try {
        return await invoke<RunResult>("git_run", { args, cwd, env })
      } catch (error) {
        // A command that cannot start at all is reported like one that ran and
        // failed, so callers have a single shape to handle.
        return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
      }
    },

    async nikcliBot(args, cwd) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        return await invoke<RunResult>("nikcli_bot", { args, cwd })
      } catch (error) {
        return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
      }
    },

    async deleteBotFile(path) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        await invoke("bot_delete", { path })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },

    async allowWriteRoot(path) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        await invoke("allow_write_root", { path })
      } catch {
        // Not fatal here: the write itself will refuse, with a message that
        // names the path, which is a better place to learn about it than a
        // silent failure during project discovery.
      }
    },

    async spawn({ command, args, cwd, cols, rows, onData, onLine, onExit, link, pane, paneToken, secrets, pipe }) {
      const { invoke } = await import("@tauri-apps/api/core")
      const { listen } = await import("@tauri-apps/api/event")

      // The pane already has an id and the listeners are attached before the
      // spawn call, so a CLI that greets in under a millisecond cannot outrun
      // them.
      const id = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      let dead = false
      const lineStream = createLineAccumulator()
      const unlisten: Array<() => void> = []

      const stop = () => {
        for (const off of unlisten.splice(0)) off()
      }

      unlisten.push(
        /*
         * This session's own topic, not a shared one every pane filters.
         *
         * With six sessions running, `pty:data` woke six listeners for every
         * chunk so that five of them could compare an id and return — per
         * chunk, per frame, on the thread that draws. The id is still on the
         * payload, because the event carries what it is about.
         *
         * Must match `data_topic` in `src-tauri/src/pty.rs`.
         */
        await listen<{ id: string; data: string }>(`pty:data:${id}`, (event) => {
          onData?.(event.payload.data)
          /*
           * The second reading of the same bytes. Escape sequences are removed
           * and the remainder split on newlines, so the parts of ADE that only
           * want to notice what an agent *said* — a permission question, a token
           * count — do not have to understand cursor movement to find it.
           */
          for (const line of lineStream.push(event.payload.data)) onLine(line, "out")
        }),
      )

      unlisten.push(
        await listen<{ id: string; code: number | null }>("pty:exit", (event) => {
          if (event.payload.id !== id) return
          dead = true
          // Whatever was still in flight when the process ended is the last
          // thing it said, and it is usually the reason it ended.
          for (const line of lineStream.flush()) onLine(line, "out")
          stop()
          onExit(event.payload.code ?? null)
        }),
      )

      try {
        await invoke("pty_spawn", {
          id,
          command,
          args,
          cwd,
          cols: cols ?? 120,
          rows: rows ?? 30,
          link: link ?? null,
          pane: pane ?? null,
          paneToken: paneToken ?? null,
          secrets: secrets && secrets.length > 0 ? secrets : null,
          pipe: pipe === true,
        })
      } catch (error) {
        dead = true
        stop()
        onLine(error instanceof Error ? error.message : String(error), "err")
        onExit(null)
      }

      return {
        kill: (options) => {
          if (dead) return
          dead = true
          stop()
          void invoke("pty_kill", { id, tree: options?.tree === true }).catch(() => undefined)
        },
        write: (data) => {
          if (dead) return
          void invoke("pty_write", { id, data }).catch(() => undefined)
        },
        resize: (nextCols, nextRows) => {
          if (dead) return
          void invoke("pty_resize", { id, cols: nextCols, rows: nextRows }).catch(() => undefined)
        },
      }
    },

    // -- API keys ------------------------------------------------------------

    async listSecrets() {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<KeyInfo[]>("secret_list")
    },
    async saveSecret(draft) {
      const { invoke } = await import("@tauri-apps/api/core")
      // Rejects with the keychain's or the validator's reason, in Italian.
      await invoke("secret_save", { name: draft.name, env: draft.env, agents: [...draft.agents], value: draft.value ?? null })
    },
    async assignedSecrets(command) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<{ name: string; env: string }[]>("secret_assigned", { command })
    },
    async deleteSecret(name) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("secret_delete", { name })
    },
    async copySecret(name) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<number>("secret_copy", { name })
    },

    // -- Filesystem access (backed by dedicated Tauri commands) -------------

    async readDir(path) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        return await invoke<DirEntry[]>("read_dir", { path })
      } catch {
        return []
      }
    },

    async readTextFile(path, maxBytes = 1_048_576) {
      const { invoke } = await import("@tauri-apps/api/core")
      /*
       * The failure is thrown, not turned into an empty file.
       *
       * It used to return `{ text: "", truncated: false }`, and that shape is
       * indistinguishable from an empty file that read fine. The editor opened
       * a blank buffer, the `truncated` guard that refuses to save a partial
       * file saw `false` and stayed out of the way, and one keystroke plus a
       * save wrote the blank buffer over the user's file. Every caller here
       * already has a catch that puts the message on screen.
       */
      return await invoke<FileRead>("read_text_file", { path, maxBytes })
    },

    async writeTextFile(path, contents) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        await invoke("write_text_file", { path, contents })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },

    async appendTextFile(path, text) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        await invoke("append_text_file", { path, text })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },

    async writeBytes(path, contents) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        // Sent as a plain array: Tauri's IPC serialises a typed array as an
        // object of index keys, which arrives in Rust as something that is
        // not a `Vec<u8>` and fails at the boundary with no useful message.
        await invoke("write_bytes", { path, contents: Array.from(contents) })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },

    async readBytes(path, maxBytes) {
      const { invoke } = await import("@tauri-apps/api/core")
      // A raw IPC response arrives as an ArrayBuffer, not as JSON numbers.
      const buffer = await invoke<ArrayBuffer>("read_project_bytes", { path, maxBytes })
      return new Uint8Array(buffer)
    },

    async currentDir() {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<string>("current_dir")
    },

    async homeDir() {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<string>("home_dir")
    },

    async exists(path) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        return await invoke<boolean>("path_exists", { path })
      } catch {
        return false
      }
    },

    async systemStats() {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<SystemStats>("system_stats")
    },

    async ttsPiperStatus(voice) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<{ supported: boolean; installed: boolean }>("tts_piper_status", { voiceId: voice })
    },

    async ttsPiperInstall(voice) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("tts_piper_install", { voiceId: voice })
    },

    async ttsOpenVoiceSource(voice) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("tts_open_voice_source", { voiceId: voice })
    },

    async ttsPiperSpeak(voice, text) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<ArrayBuffer>("tts_piper_speak", { voiceId: voice, text })
    },

    async mailboxTake() {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<{ id: string; body: string }[]>("mailbox_take")
    },

    async mailboxReceipt(id, text) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("mailbox_receipt", { id, text })
    },

    async visionAllowed() {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<boolean>("vision_allowed")
    },
    async captureWindow(request) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<{ path: string; width: number; height: number; bytes: number }>("capture_window", {
        label: request.label,
        crop: request.crop ?? null,
        redact: request.redact,
        scale: request.scale,
      })
    },
    async browserShot(request) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<{ path: string; width: number; height: number }>("browser_shot", request)
    },
    async mailboxPublish(text, name) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("mailbox_publish", { text, name: name ?? null })
    },

    async transcriptUsage(agent, sessionId, cwd) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        return await invoke<TokenUsage | null>("transcript_usage", { agent, sessionId, cwd })
      } catch {
        return null
      }
    },

    async mailboxState(id, text, kind) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("mailbox_state", { id, text, kind: kind ?? null })
    },

    async recordStart(target, dir, name, quality) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<RecordingState>("record_start", { target, dir, name, quality: quality ?? null })
    },

    async recordWrite(path, contents) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("record_write", { path, contents: Array.from(contents) })
    },

    async recordStop() {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<RecordingState>("record_stop")
    },

    async recordState() {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<RecordingState>("record_state")
    },

    async mailboxDir() {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<string>("mailbox_dir")
    },

    async mailboxInboxPut(pane, name, text) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("mailbox_inbox_put", { pane, name, text })
    },

    async mailboxInboxRead(pane, name) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<boolean>("mailbox_inbox_read", { pane, name })
    },

    async mailboxResult(id, text) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("mailbox_result", { id, text })
    },

    async mailboxResultReclaim(id, kind) {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<string | null>("mailbox_result_reclaim", { id, kind: kind === "update" ? "update" : null })
    },

    async pickDirectory(title) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog")
        const selected = await open({ directory: true, title: title ?? "Scegli cartella" })
        // open() returns string | string[] | null depending on `multiple`
        if (typeof selected === "string") return selected
        return undefined
      } catch {
        return undefined
      }
    },

    async pickFile(options) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog")
        const selected = await open({
          directory: false,
          multiple: false,
          title: options?.title ?? "Scegli file",
          ...(options?.filters ? { filters: options.filters } : {}),
        })
        if (typeof selected === "string") return selected
        return undefined
      } catch {
        return undefined
      }
    },

    // -- The agent's own report of its session id ---------------------------

    async readAgentLink(nonce) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        return (await invoke<string | null>("agent_link_read", { nonce })) ?? null
      } catch {
        /*
         * Polled once a second while a session starts, so a failure here must
         * not be noise. There is nothing the user could do about it either:
         * the consequence is a pane that resumes from its last conversation
         * instead of by id, which is the behaviour they had before the hook.
         */
        return null
      }
    },

    async clearAgentLink(nonce) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        await invoke("agent_link_clear", { nonce })
      } catch {
        // A report left behind is swept at the next start.
      }
    },

    async readAgentActivity(nonce) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        return (await invoke<string | null>("agent_activity_read", { nonce })) ?? null
      } catch {
        // Unknown, which is what it is: never read as idle.
        return null
      }
    },

    async readAgentHook(agent) {
      const { invoke } = await import("@tauri-apps/api/core")
      return await invoke<AgentHookFiles>("agent_hook_read", { agent })
    },

    async writeAgentHook(agent, configText, script) {
      const { invoke } = await import("@tauri-apps/api/core")
      // Not swallowed: this one the user asked for, and if it fails they need
      // to know that the file they were told would change did not.
      await invoke("agent_hook_write", { agent, configText, script })
    },
  }

  return cached
}

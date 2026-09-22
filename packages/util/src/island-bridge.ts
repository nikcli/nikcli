import fs from "fs/promises"
import { homedir, platform } from "os"
import path from "path"
import { GlobalBus } from "./global-bus"
import { Log } from "@nikcli-ai/util/log"

/**
 * nikcli Island bridge — mirrors live session state into the file contract
 * NikcliIsland.app (packages/nikcli-island, a native macOS notch app modeled on
 * Pookify) reads. This is CLI-level, not TUI-level: it listens on `GlobalBus`,
 * the process-wide EventEmitter every `Bus.publish` call already forwards to
 * (see src/bus/index.ts) regardless of whether the invocation is `nikcli tui`,
 * a one-shot `nikcli run`, or `nikcli serve` — so the island reflects any nikcli
 * process running on the machine, the same way Pookify's hook fires for every
 * Claude Code session once installed, without depending on any one UI surface.
 *
 * `start()` is self-activating: `Bus.publish` itself calls it on every publish
 * (idempotent, no-op after the first real call), rather than depending on each
 * CLI entrypoint remembering to wire it in. This matters because the TUI's real
 * session/Bus activity runs inside a `Worker` thread (src/cli/cmd/tui/worker.ts),
 * which has its own isolated module state — a `GlobalBus` listener registered
 * only in the parent process (e.g. from src/index.ts) never sees those events.
 * Hooking `Bus.publish` instead of a specific entrypoint file means whichever
 * realm actually fires the event is also the realm that activates the bridge,
 * with nothing to accidentally drop when an entrypoint file changes.
 *
 * `stop()`, by contrast, has no single choke point to hook (there's no "last
 * publish" signal) — callers invoke it explicitly at their own real shutdown
 * point: worker.ts's `shutdown` RPC handler for the TUI, `process.on("exit",
 * ...)` in index.ts for a plain (non-worker) entrypoint. See `stop()`'s own
 * doc for why a shared `process.on("exit", ...)` inside `start()` itself was
 * wrong (it raced real writes out from under themselves when verified).
 *
 * One JSON file per session under `~/Library/Application Support/NikcliIsland/state.d/`,
 * written atomically (temp file + rename), macOS only. The native app polls that
 * directory (see NikcliIsland/SessionAggregator.swift). Each snapshot also carries
 * this process's local server URL when one is running, so the island can call back
 * into `POST /permission/:requestID/reply` to approve/deny a permission request
 * directly from the notch instead of just displaying it.
 */
export namespace IslandBridge {
  const log = Log.create({ service: "island-bridge" })

  // Re-resolved on every access rather than cached at module load: tests swap
  // ISLAND_SUPPORT_DIR / NIKCLI_ISLAND_TEST_FORCE_DARWIN per file (see NIKCLI_TEST_HOME
  // convention elsewhere in this codebase), and a cached const would go stale.
  //
  // NIKCLI_ISLAND_TEST_FORCE_DARWIN exists ONLY so this file's own test suite can run
  // its assertions on non-macOS CI; it is not documented as a user-facing flag and must
  // never be set in a real deployment — the feature is Windows/Linux no-op by design
  // (NikcliIsland.app is a native macOS notch UI; there is nothing for it to drive there).
  function isMac(): boolean {
    return platform() === "darwin" || process.env.NIKCLI_ISLAND_TEST_FORCE_DARWIN === "1"
  }
  function supportDir(): string {
    return process.env.ISLAND_SUPPORT_DIR || path.join(homedir(), "Library", "Application Support", "NikcliIsland")
  }
  function stateDir(): string {
    return path.join(supportDir(), "state.d")
  }

  type IslandState = "idle" | "thinking" | "tool" | "permission" | "done" | "error"

  interface Snapshot {
    schema: number
    sessionID: string
    state: IslandState
    label: string
    tool: string
    detail: string
    project: string
    cwd: string
    pid: number
    port: number
    /** The `Authorization` the server on `port` requires, or empty. The file
     *  is 0600 in a 0700 directory, readable only by the user it belongs to. */
    authorization: string
    startedAt: number
    ts: number
    permissionID: string
    /** 0 while a tool is still running; >0 once finished — the app holds the label
     *  until this time so fast tools (a quick Read/Edit) are still readable, then
     *  falls back to "Thinking…". Mirrors Pookify's tool-linger behavior. */
    toolEndsAt: number
    /** Non-empty when this session is a subagent spawned via delegation (Task/Agent/
     *  delegation.manager) — the parent's own sessionID. Lets the island tell a
     *  subagent's row apart from its orchestrator instead of showing duplicate
     *  "project" names when several subagents share the same cwd. */
    parentID: string
    /** The session's own title (e.g. a delegated task's description) — shown in the
     *  multi-session stack in place of `project` for subagent rows, since `project`
     *  is usually identical across a parent and all its subagents. */
    agentTitle: string
  }

  const toolLingerSeconds = 1.9

  // Mirrors the tool-name -> friendly-label mapping the TUI's own activity line uses.
  const TOOL_LABELS: Record<string, string> = {
    bash: "Running command",
    bashoutput: "Running command",
    killshell: "Running command",
    powershell: "Running command",
    slashcommand: "Running command",
    monitor: "Running command",
    taskoutput: "Running command",
    taskstop: "Running command",
    edit: "Editing",
    multiedit: "Editing",
    notebookedit: "Editing",
    write: "Writing",
    read: "Reading",
    grep: "Searching",
    glob: "Searching",
    webfetch: "Browsing web",
    websearch: "Searching web",
    task: "Delegating",
    taskcreate: "Delegating",
    agent: "Delegating",
    sendmessage: "Delegating",
    workflow: "Delegating",
    todowrite: "Planning",
    exitplanmode: "Planning",
    enterplanmode: "Planning",
    toolsearch: "Preparing tools",
    skill: "Running skill",
    askuserquestion: "Asking a question",
  }

  function toolLabel(tool: string): string {
    const hit = TOOL_LABELS[tool.toLowerCase()]
    if (hit) return hit
    if (tool.startsWith("mcp__")) return "Using MCP tool"
    return "Working…"
  }

  function fileFor(sessionID: string): string {
    const safe = sessionID.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown"
    return path.join(stateDir(), `nikcli-${safe}.json`)
  }

  // Mirrors Pookify's appIsRunning()/launchApp(): the app writes its own pid to
  // app.pid on launch and removes it on a clean quit, so kill(pid, 0) is a cheap
  // liveness check. Checked on every write (not just once at start()) so quitting
  // the app mid-session doesn't leave it dead for the rest of that nikcli process —
  // the next real event re-launches it, exactly like Pookify's hook does on every
  // Claude Code event.
  async function appIsRunning(): Promise<boolean> {
    try {
      const raw = (await fs.readFile(path.join(supportDir(), "app.pid"), "utf8")).trim()
      const pid = Number(raw)
      if (!Number.isFinite(pid) || pid <= 0) return false
      process.kill(pid, 0)
      return true
    } catch (error: any) {
      // EPERM means the pid exists but is owned by someone else — still alive.
      return error?.code === "EPERM"
    }
  }

  function wakeApp(): void {
    try {
      // `osascript ... to launch` (not `activate`) starts the app in the background
      // without stealing focus — same intent as `open -g`, but goes through Launch
      // Services' bundle-id resolution via System Events instead of the `open` CLI,
      // which is more reliable when this call is one process removed from a real
      // interactive shell (e.g. from inside a Bun Worker thread).
      Bun.spawn(["osascript", "-e", `tell application id "com.nikcli.island" to launch`], {
        windowsHide: true,
        stdout: "ignore",
        stderr: "ignore",
      })
    } catch {
      // not installed; nothing to wake
    }
  }

  async function wakeAppIfNeeded(): Promise<void> {
    if (!(await appIsRunning())) wakeApp()
  }

  /**
   * What the host can answer that this module cannot.
   *
   * The bridge runs on both sides — the worker writes snapshots, the terminal
   * reads them — so it lives in the shared package. These two lookups only ever
   * happen on the writing side, and both have a working fallback, so instead of
   * importing the server they are handed in by whoever owns it.
   */
  export type Host = {
    port?: () => Promise<number>
    authorization?: () => Promise<string | undefined>
    identity?: (sessionID: string) => Promise<{ parentID: string; agentTitle: string }>
  }

  let host: Host = {}

  /** Called by the process that owns the HTTP server and the session store. */
  export function configure(next: Host): void {
    host = next
  }

  async function currentPort(): Promise<number> {
    if (process.env.NIKCLI_PORT) {
      const n = Number(process.env.NIKCLI_PORT)
      if (Number.isFinite(n) && n > 0) return n
    }
    try {
      const port = await host.port?.()
      return Number.isFinite(port) ? (port as number) : 0
    } catch {
      return 0
    }
  }

  async function currentAuthorization(): Promise<string> {
    try {
      return (await host.authorization?.()) ?? ""
    } catch {
      return ""
    }
  }

  let dirsReadyFor = ""
  async function ensureDirs() {
    const dir = stateDir()
    if (dirsReadyFor === dir) return
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    dirsReadyFor = dir
  }

  const known = new Map<string, Snapshot>()

  /** parentID/title never change after a session is created, so this only needs to
   *  run once per sessionID (guarded by `known` already holding a prior snapshot) —
   *  not on every write, which would otherwise hit the DB on every status tick. */
  async function lookupIdentity(sessionID: string): Promise<{ parentID: string; agentTitle: string }> {
    try {
      const info = await host.identity?.(sessionID)
      return { parentID: info?.parentID ?? "", agentTitle: info?.agentTitle ?? "" }
    } catch {
      return { parentID: "", agentTitle: "" }
    }
  }

  async function write(sessionID: string, directory: string | undefined, patch: Partial<Snapshot>) {
    try {
      await ensureDirs()
      const prev = known.get(sessionID)
      const identity = prev ? undefined : await lookupIdentity(sessionID)
      const snap: Snapshot = {
        schema: 1,
        sessionID,
        state: "idle",
        label: "",
        tool: "",
        detail: "",
        project: directory ? path.basename(directory) : (prev?.project ?? ""),
        cwd: directory ?? prev?.cwd ?? "",
        pid: process.pid,
        port: await currentPort(),
        startedAt: 0,
        permissionID: "",
        toolEndsAt: 0,
        parentID: identity?.parentID ?? prev?.parentID ?? "",
        agentTitle: identity?.agentTitle ?? prev?.agentTitle ?? "",
        ...prev,
        ...patch,
        // After the spreads: the credential is this process's, never a stale copy.
        authorization: await currentAuthorization(),
        ts: Date.now() / 1000,
      }
      known.set(sessionID, snap)
      const file = fileFor(sessionID)
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 })
      await fs.rename(tmp, file)
      // Any sign of life must be able to bring the app back, not just the first
      // one — if the user quit it mid-session, the next real event should still
      // revive it (mirrors Pookify's island-hook doing the same check per event).
      void wakeAppIfNeeded()
    } catch (error) {
      log.debug("island snapshot write failed", { sessionID, error })
    }
  }

  async function clear(sessionID: string) {
    known.delete(sessionID)
    await fs.rm(fileFor(sessionID), { force: true }).catch(() => {})
  }

  let started = false
  // Separate from `started`: `started` just guards the one-time GlobalBus
  // listener registration, while `enabled` gates whether that listener does
  // anything. Kept apart so a TUI plugin can flip bridging on/off for this
  // process's session (see feature-plugins/island) without needing to
  // register/unregister the listener each time — toggling off just clears
  // the current snapshots and stops writing; toggling back on resumes
  // through the already-registered listener.
  let enabled = process.env.NIKCLI_ISLAND === "1" && process.env.NIKCLI_ISLAND_DISABLE !== "1"

  /** Idempotent. No-op off macOS. Safe to call from any CLI entrypoint. */
  export function start(): void {
    if (started || !isMac()) return
    started = true

    GlobalBus.on("event", ({ directory, payload }) => {
      if (!enabled) return
      const { type, properties } = payload ?? {}
      switch (type) {
        case "session.status": {
          const { sessionID, status } = properties
          if (status.type === "idle") {
            void write(sessionID, directory, {
              state: "idle",
              label: "",
              startedAt: 0,
            })
          } else if (status.type === "busy") {
            void write(sessionID, directory, {
              state: "thinking",
              label: "Thinking…",
              startedAt: (status.since ?? Date.now()) / 1000,
            })
          } else if (status.type === "retry") {
            void write(sessionID, directory, {
              state: "thinking",
              label: `Retrying (${status.attempt})…`,
            })
          }
          break
        }
        case "permission.asked": {
          const req = properties
          void write(req.sessionID, directory, {
            state: "permission",
            label: "Awaiting permission",
            permissionID: req.id,
          })
          break
        }
        case "permission.replied": {
          void write(properties.sessionID, directory, {
            state: "thinking",
            label: "Thinking…",
            permissionID: "",
          })
          break
        }
        case "session.error": {
          const sessionID = properties?.sessionID
          if (sessionID)
            void write(sessionID, directory, {
              state: "error",
              label: "Error",
            })
          break
        }
        case "session.deleted": {
          const sessionID = properties?.info?.id ?? properties?.sessionID
          if (sessionID) void clear(sessionID)
          break
        }
        case "message.part.updated": {
          const part = properties?.part
          if (!part || part.type !== "tool" || !part.sessionID) break
          const status = part.state?.status
          if (status === "running" || status === "pending") {
            const input = part.state?.input ?? {}
            const rawPath = input.filePath ?? input.file_path ?? input.path
            const detail = typeof rawPath === "string" ? path.basename(rawPath) : ""
            void write(part.sessionID, directory, {
              state: "tool",
              tool: part.tool ?? "",
              label: toolLabel(part.tool ?? ""),
              detail,
              toolEndsAt: 0,
            })
          } else if (status === "completed" || status === "error") {
            // Linger: keep the tool's label/detail up briefly so a fast tool doesn't
            // just flash by, then the aggregator falls back to "Thinking…" on its own.
            const prev = known.get(part.sessionID)
            void write(part.sessionID, directory, {
              state: "tool",
              tool: prev?.tool ?? part.tool ?? "",
              label: prev?.label ?? toolLabel(part.tool ?? ""),
              toolEndsAt: Date.now() / 1000 + toolLingerSeconds,
            })
          }
          break
        }
        default:
          break
      }
    })
  }

  /**
   * Best-effort synchronous cleanup: remove every session file this instance
   * touched, so a nikcli process that's genuinely quitting doesn't leave a
   * zombie pill on the notch.
   *
   * NOT wired to `process.on("exit", ...)` here. `process` is one object per
   * OS process, shared by the main thread AND every `Worker` thread inside it
   * (the TUI's real session logic runs in exactly such a worker — see
   * src/cli/cmd/tui/worker.ts) — so an "exit" listener registered from inside
   * a worker fires on ANY thread's exit signal, not specifically "this worker
   * is done", which raced real writes out from under itself when verified
   * end-to-end. Callers must invoke `stop()` explicitly at their own actual
   * shutdown point instead (worker.ts's `shutdown` RPC handler; a plain
   * `process.on("exit", IslandBridge.stop)` is fine for a non-worker
   * entrypoint, where "this process" and "the OS process" are the same thing).
   */
  export function stop(): void {
    for (const sessionID of known.keys()) {
      try {
        require("node:fs").rmSync(fileFor(sessionID), { force: true })
      } catch {}
    }
    known.clear()
  }

  export function isSupported(): boolean {
    return isMac()
  }

  export function isEnabled(): boolean {
    return enabled
  }

  /** Toggle bridging for this process's session (e.g. the TUI plugin's activate/deactivate). */
  export function setEnabled(next: boolean): void {
    if (enabled === next) return
    enabled = next
    if (next) {
      start()
      return
    }
    stop()
  }

  export async function status(): Promise<{
    supported: boolean
    enabled: boolean
    appRunning: boolean
    sessions: number
  }> {
    return {
      supported: isMac(),
      enabled,
      appRunning: isMac() ? await appIsRunning() : false,
      sessions: known.size,
    }
  }
}

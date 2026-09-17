/**
 * Where one worktree's ADE Test lives: its port, its WebView2 profile, its log.
 *
 * Several agent sessions work on ADE at once, each in its own worktree, and
 * each wants to try its change in a running app. They used to share
 * everything that made that safe: one dev port, one profile, one way to find
 * the process to stop. The port was the dangerous one. Vite is `strictPort`,
 * so a second worktree's Vite exited on 5177 — and Tauri then opened
 * `localhost:5177` anyway, where the *first* worktree's Vite answered. The
 * window said ADE Test and ran someone else's code.
 *
 * Everything here is derived from the worktree path, so it is the same on
 * every run and different between worktrees. Pure, so it can be tested; the
 * script in `scripts/test-app.ts` does the spawning.
 */

import { basename, join } from "node:path"

/** Dev ports are taken from 5200–5599, clear of Vite's 5173 and ADE's 5177. */
export const TEST_APP_PORT_BASE = 5200
export const TEST_APP_PORT_SPAN = 400
/** The remote-debugging port sits a fixed distance above the dev port. */
export const TEST_APP_CDP_OFFSET = 4000

export interface TestAppPlan {
  /** The worktree folder's name, which is what the badge shows. */
  name: string
  /** Name and branch, for the window title and the terminal. */
  label: string
  /** The preferred dev port; the script moves up when it is taken. */
  port: number
  stateDir: string
  profileDir: string
  tmpDir: string
  logPath: string
  recordPath: string
  configPath: string
  /**
   * This instance's `ade-msg` mailbox, passed as `ADE_MAILBOX_ROOT`. Every test
   * build otherwise shares one under the test identity's data folder, and one
   * instance rewrote the other's `ade-msg.ps1` mid-test (S25).
   */
  mailboxDir: string
}

/** What a started instance left behind, so `status` and `list` can describe it. */
export interface TestAppRecord {
  port: number
  cdpPort?: number
  label: string
  root: string
  /**
   * When `start` launched it, in ms since the epoch, taken just before the
   * spawn. `stop` kills only processes created after this: see
   * `instanceProcesses`. Absent in records written before it existed.
   */
  startedAt?: number
}

/** One row of the OS process table, as far as telling instances apart needs. */
export interface ProcessRow {
  pid: number
  ppid: number
  exe?: string
  cmd?: string
  /** Creation time, ms since the epoch; unknown when the OS would not say. */
  created?: number
}

/** Process creation times are read at a coarser grain than `Date.now()`. */
export const TEST_APP_START_SLACK_MS = 2000

/**
 * The processes that make up one worktree's instance.
 *
 * Found by what only this worktree's processes can contain, not by a
 * recorded pid. A pid was the first design and it failed on the first run:
 * the liveness check behind it is a PowerShell call, one call failed under
 * the load of the Rust build, and the instance was declared gone while its
 * window was open. Paths do not have that failure, and they also survive the
 * parent being killed, which leaves `tauri`'s children orphaned but still
 * carrying the same arguments.
 *
 * The roots are the `tauri dev` processes (their `--config` names this
 * worktree's config), the WebView2 processes (their profile is this
 * worktree's), the app binary (built into this worktree's `target`) and this
 * port's Vite. Everything below a root belongs too: cargo, shells, esbuild.
 *
 * With `startedAt`, only what this start could have created: arguments are
 * not ownership, since anyone can run a process naming this worktree's paths.
 * A root must be created after the start, and a child after its parent —
 * Windows reuses pids, and a process that predates its "parent" is some
 * other process that inherited a dead one's id. A process whose creation time
 * is unknown is left out, since nothing proves it is ours.
 */
export function instanceProcesses(
  rows: readonly ProcessRow[],
  plan: TestAppPlan,
  root: string,
  port?: number,
  startedAt?: number,
): ProcessRow[] {
  const norm = (text: string | undefined) => (text ?? "").replace(/\\/g, "/").toLowerCase()
  const config = norm(plan.configPath)
  const profile = norm(plan.profileDir)
  const target = norm(join(root, "packages", "ade", "src-tauri", "target"))
  const tree = norm(root)

  const isRoot = (row: ProcessRow) => {
    const cmd = norm(row.cmd)
    const exe = norm(row.exe)
    if (cmd.includes(config) || cmd.includes(profile)) return true
    if (exe.startsWith(`${target}/`)) return true
    // `${tree}/`: `nikcli-ade` is a prefix of `nikcli-ade-testapp`.
    return port !== undefined && cmd.includes(`${tree}/`) && cmd.includes("vite") && cmd.includes(`--port ${port}`)
  }

  const since = startedAt === undefined ? undefined : startedAt - TEST_APP_START_SLACK_MS
  const ownRoot = (row: ProcessRow) => since === undefined || (row.created !== undefined && row.created >= since)
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const ownChild = (row: ProcessRow) => {
    if (since === undefined) return true
    const parent = byPid.get(row.ppid)
    return row.created !== undefined && parent?.created !== undefined && row.created >= parent.created
  }

  const members = new Set(rows.filter((row) => isRoot(row) && ownRoot(row)).map((row) => row.pid))
  // Descendants, to a fixed point: a child can be listed before its parent.
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      if (!members.has(row.pid) && members.has(row.ppid) && ownChild(row)) {
        members.add(row.pid)
        grew = true
      }
    }
  }
  return rows.filter((row) => members.has(row.pid))
}

/**
 * The order to kill members in: children before parents.
 *
 * Each process is killed on its own, never with its tree: a tree kill walks
 * parent ids again, and that walk is the one that sweeps in a process that
 * reused a pid. Children first, so a parent that restarts what dies under it
 * (`tauri dev` watching) is gone before it can.
 */
export function killOrder(members: readonly ProcessRow[]): ProcessRow[] {
  const byPid = new Map(members.map((row) => [row.pid, row]))
  const depth = (row: ProcessRow): number => {
    let d = 0
    for (let at = byPid.get(row.ppid), seen = new Set<number>(); at && !seen.has(at.pid); at = byPid.get(at.ppid)) {
      seen.add(at.pid)
      d++
    }
    return d
  }
  return [...members].sort((a, b) => depth(b) - depth(a))
}

/** Whether the instance is still up: its `tauri dev` or its app binary. */
export function instanceRunning(members: readonly ProcessRow[], plan: TestAppPlan, root: string): boolean {
  const norm = (text: string | undefined) => (text ?? "").replace(/\\/g, "/").toLowerCase()
  const config = norm(plan.configPath)
  const target = norm(join(root, "packages", "ade", "src-tauri", "target"))
  return members.some((row) => norm(row.cmd).includes(config) || norm(row.exe).startsWith(`${target}/`))
}

/**
 * FNV-1a over the normalised path.
 *
 * Normalised because the same worktree is spelled `C:\Users\…` by Windows and
 * `C:/Users/…` by git, and a port that changed with the spelling would defeat
 * the point of deriving it.
 */
export function hashPath(path: string): number {
  const normalised = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  let hash = 0x811c9dc5
  for (let i = 0; i < normalised.length; i++) {
    hash ^= normalised.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function planTestApp(input: { root: string; branch: string }): TestAppPlan {
  const name = basename(input.root.replace(/[\\/]+$/, ""))
  const stateDir = join(input.root, ".ade-test")
  return {
    name,
    label: input.branch ? `${name} · ${input.branch}` : name,
    port: TEST_APP_PORT_BASE + (hashPath(input.root) % TEST_APP_PORT_SPAN),
    stateDir,
    profileDir: join(stateDir, "webview2"),
    tmpDir: join(stateDir, "tmp"),
    logPath: join(stateDir, "ade-test.log"),
    recordPath: join(stateDir, "record.json"),
    configPath: join(stateDir, "tauri.dev.json"),
    mailboxDir: join(stateDir, "mailbox"),
  }
}

/**
 * The Tauri config fragment that points this instance at its own Vite.
 *
 * Both halves carry the port: the command that starts Vite and the URL the
 * window loads. `--strictPort` stays, so a port taken between the check and
 * the start fails the start instead of loading whatever holds it.
 */
export function devConfig(port: number): string {
  return JSON.stringify(
    {
      build: {
        beforeDevCommand: `bun x vite --port ${port} --strictPort`,
        devUrl: `http://localhost:${port}`,
      },
    },
    null,
    2,
  )
}

/**
 * `tauri dev`'s arguments for this instance.
 *
 * A test build runs as its own executable, `ade-test`, so that nothing
 * finding the official app by its name (an installer closing `ade-desktop.exe`)
 * reaches a test window. That binary exists only where `Cargo.toml` declares
 * the `test-exe` feature, so the flags follow the manifest: on a branch that
 * predates it the dev build stays `ade-desktop`.
 *
 * `--no-watch` unless asked otherwise. `tauri dev` watches the Rust sources
 * and, on a change, rebuilds and *restarts the app*: the window closes under
 * whoever is using it. That is fine while writing Rust and wrong everywhere
 * else — a session driving ADE Test, a person trying something, a measurement
 * — and it happened in the middle of a live trial, taking the window away
 * from the user mid-sentence. A rebuild is now asked for by stopping and
 * starting again, which is one command and never a surprise.
 */
export function tauriDevArgs(configPath: string, cargoToml: string, options: { watch?: boolean } = {}): string[] {
  const args = ["x", "tauri", "dev", "--config", "src-tauri/tauri.test.conf.json", "--config", configPath]
  if (!options.watch) args.push("--no-watch")
  // Everything after `--` belongs to cargo, so the flag goes before it.
  if (/^\s*test-exe\s*=/m.test(cargoToml)) args.push("--features", "test-exe", "--", "--bin", "ade-test")
  return args
}

/** Whether `tauri dev`'s output says the app binary is running, under either name. */
export function appStarted(log: string): boolean {
  return /Running `target[\\/]debug[\\/]ade-(desktop|test)/.test(log)
}

export function parseRecord(text: string): TestAppRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<TestAppRecord>
    if (typeof value.port !== "number" || typeof value.root !== "string") return undefined
    return value as TestAppRecord
  } catch {
    return undefined
  }
}

/**
 * Lines of `tauri dev` output that mean the start has failed.
 *
 * Checked as the log grows, because a failed start does not always end the
 * parent process: `tauri dev` keeps watching for changes after the app has
 * panicked, and waiting for it to exit would wait forever.
 */
export function startFailure(log: string): string | undefined {
  const patterns = [
    /Port \d+ is already in use/,
    /Failed to setup app[^\n]*/,
    /error\[E\d+\][^\n]*/,
    /error: could not compile[^\n]*/,
    /The "beforeDevCommand" terminated with a non-zero status code/,
    /process didn't exit successfully[^\n]*/,
  ]
  for (const pattern of patterns) {
    const match = log.match(pattern)
    if (match) return match[0]
  }
  return undefined
}

/* ── start and stop, with the machine passed in ─────────────────────────── */

/** What `stop` did: closed and killed what the start created, refused to guess, or found nothing. */
export type StopOutcome =
  | { outcome: "stopped"; closed: number[]; killed: number[] }
  | { outcome: "refused"; pids: number[] }
  | { outcome: "nothing" }

/** How long the app has to close its window and exit before it is killed. */
export const TEST_APP_CLOSE_TIMEOUT_MS = 10_000

/** Whether a process is the app itself: the binary built into this worktree's `target`. */
export function isAppProcess(row: ProcessRow, root: string): boolean {
  const norm = (text: string | undefined) => (text ?? "").replace(/\\/g, "/").toLowerCase()
  return norm(row.exe).startsWith(`${norm(join(root, "packages", "ade", "src-tauri", "target"))}/`)
}

/**
 * Stops one worktree's instance: every process its recorded start created,
 * then its record.
 *
 * The app first, in order: its window is asked to close and the app gets
 * `closeTimeoutMs` to exit. WebView2 writes localStorage to disk late, and a
 * kill lost what the page had stored in its last seconds (S34). What is left
 * then — `tauri dev`, cargo, Vite, and an app that did not exit — is killed,
 * children first, as read again from the process table.
 *
 * Without a start time in the record nothing is closed or killed: arguments
 * alone do not say who started a process. The record is removed only when
 * nothing of the instance is left to describe.
 */
export function stopInstance(input: {
  rows: readonly ProcessRow[]
  record: TestAppRecord | undefined
  plan: TestAppPlan
  root: string
  selfPid: number
  kill: (pid: number) => void
  removeRecord: () => void
  /** Asks a process to close its window; the orderly stop. Without it everything is killed. */
  close?: (pid: number) => void
  /** Waits up to `timeoutMs` for the pids to exit, and returns those still running. */
  waitExit?: (pids: number[], timeoutMs: number) => number[]
  /** The process table after the app has closed; `rows` again when it cannot be read. */
  reread?: () => readonly ProcessRow[] | undefined
  closeTimeoutMs?: number
}): StopOutcome {
  const { rows, record, plan, root } = input
  if (record?.startedAt === undefined) {
    const found = instanceProcesses(rows, plan, root, record?.port)
    if (found.length > 0) return { outcome: "refused", pids: found.map((row) => row.pid) }
    input.removeRecord()
    return { outcome: "nothing" }
  }
  let members = instanceProcesses(rows, plan, root, record.port, record.startedAt)
  const closed: number[] = []
  const apps = members.filter((row) => isAppProcess(row, root) && row.pid !== input.selfPid).map((row) => row.pid)
  if (input.close && input.waitExit && apps.length > 0) {
    for (const pid of apps) input.close(pid)
    const alive = new Set(input.waitExit(apps, input.closeTimeoutMs ?? TEST_APP_CLOSE_TIMEOUT_MS))
    closed.push(...apps.filter((pid) => !alive.has(pid)))
    // Read again, with the same start filter, so a pid reused meanwhile is not taken for ours.
    // Unreadable: the app and its children are left alone, since after the wait nothing proves those pids are still theirs.
    const fresh = input.reread?.()
    members = fresh
      ? instanceProcesses(fresh, plan, root, record.port, record.startedAt)
      : members.filter((row) => !apps.includes(row.pid) && !apps.includes(row.ppid))
  }
  const killed: number[] = []
  for (const row of killOrder(members)) {
    if (row.pid === input.selfPid) continue
    input.kill(row.pid)
    killed.push(row.pid)
  }
  input.removeRecord()
  return closed.length > 0 || killed.length > 0 ? { outcome: "stopped", closed, killed } : { outcome: "nothing" }
}

/** How a start ended. Every outcome but `started` has already stopped what the start left. */
export type StartOutcome =
  | { outcome: "started" }
  | { outcome: "failed"; failure: string; log: string }
  | { outcome: "lost" }
  | { outcome: "timeout" }

/**
 * Waits for the window after `tauri dev` was launched.
 *
 * Waited on the log rather than on the process: `tauri dev` stays up watching
 * files after the app itself has failed, so its exit says nothing. The process
 * table is only a backstop, read every `livenessEveryMs`, and an unreadable
 * table (`undefined`) never counts as gone. A start that fails, loses its app
 * or runs out of time calls `stop` before returning, so no Vite, WebView2 or
 * record outlives it.
 */
export async function superviseStart(deps: {
  readLog: () => string
  /** Whether the instance is up; `undefined` when the process table could not be read. */
  running: () => boolean | undefined
  stop: () => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  timeoutMs: number
  livenessEveryMs?: number
  onProgress?: (progress: string) => void
}): Promise<StartOutcome> {
  const every = deps.livenessEveryMs ?? 15_000
  const deadline = deps.now() + deps.timeoutMs
  let lastProgress = ""
  let lastLiveness = deps.now()
  while (deps.now() < deadline) {
    const log = deps.readLog()
    const failure = startFailure(log)
    if (failure) {
      deps.stop()
      return { outcome: "failed", failure, log }
    }
    if (appStarted(log)) return { outcome: "started" }
    if (deps.now() - lastLiveness > every) {
      lastLiveness = deps.now()
      if (deps.running() === false) {
        deps.stop()
        return { outcome: "lost" }
      }
    }
    const progress = log.match(/\d+\/\d+(?=: )/g)?.pop()
    if (progress && progress !== lastProgress) {
      lastProgress = progress
      deps.onProgress?.(progress)
    }
    await deps.sleep(1000)
  }
  deps.stop()
  return { outcome: "timeout" }
}

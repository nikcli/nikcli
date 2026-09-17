/**
 * One ADE Test per worktree.
 *
 *   bun run test:app            start this worktree's ADE Test (or say it is running)
 *   bun run test:app --cdp      same, with WebView2 remote debugging for an agent to drive
 *   bun run test:app --watch    same, rebuilding and restarting on every Rust change
 *                               (the window closes and reopens: only while writing Rust)
 *   bun run test:app stop       stop this worktree's instance, and nothing else
 *   bun run test:app status     this worktree's instance
 *   bun run test:app list       every worktree's instance
 *
 * Port, profile and log come from the worktree path: see `src/host/test-app.ts`
 * for why each one has to be separate. The state lives in `.ade-test/` at the
 * worktree root, which is ignored by git.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import {
  TEST_APP_CDP_OFFSET,
  devConfig,
  instanceProcesses,
  instanceRunning,
  parseRecord,
  planTestApp,
  stopInstance,
  superviseStart,
  tauriDevArgs,
  type ProcessRow,
  type TestAppPlan,
  type TestAppRecord,
} from "../src/host/test-app"

const adeDir = join(import.meta.dir, "..")
const isWindows = process.platform === "win32"

function git(args: string[], cwd = adeDir): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" })
  return run.status === 0 ? run.stdout.trim() : ""
}

const root = git(["rev-parse", "--show-toplevel"])
if (!root) {
  console.error("ADE Test: non trovo la radice del repository git.")
  process.exit(1)
}
const plan = planTestApp({ root, branch: git(["branch", "--show-current"]) })

const args = process.argv.slice(2)
const command = args.find((arg) => !arg.startsWith("-")) ?? "start"
const wantCdp = args.includes("--cdp")
/*
 * A change to the Rust sources rebuilds and restarts the app, which closes
 * the window whoever is using it is looking at. Off unless asked for: see
 * `tauriDevArgs`.
 */
const wantWatch = args.includes("--watch")

// ---------------------------------------------------------------------------

/**
 * The process table, or nothing when it could not be read.
 *
 * "Could not read" and "nothing is running" are kept apart on purpose: under
 * the load of a Rust build a PowerShell call can fail, and treating that as
 * an empty table is how an open instance was once declared gone.
 */
function processTable(): ProcessRow[] | undefined {
  if (isWindows) {
    const run = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine," +
          "@{n='Created';e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }}}" +
          " | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
    if (run.status !== 0 || !run.stdout.trim()) return undefined
    try {
      const rows = JSON.parse(run.stdout) as {
        ProcessId: number
        ParentProcessId: number
        ExecutablePath?: string | null
        CommandLine?: string | null
        Created?: number | null
      }[]
      return rows.map((row) => ({
        pid: row.ProcessId,
        ppid: row.ParentProcessId,
        exe: row.ExecutablePath ?? undefined,
        cmd: row.CommandLine ?? undefined,
        created: typeof row.Created === "number" ? row.Created : undefined,
      }))
    } catch {
      return undefined
    }
  }
  const run = spawnSync("ps", ["-eo", "pid=,ppid=,etimes=,args="], { encoding: "utf8" })
  if (run.status !== 0) return undefined
  const now = Date.now()
  return run.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      // Elapsed whole seconds: the start is known to within one.
      created: now - (Number(match[3]) + 1) * 1000,
      cmd: match[4],
      exe: match[4].split(" ")[0],
    }))
}

function readRecord(path: string): TestAppRecord | undefined {
  if (!existsSync(path)) return undefined
  return parseRecord(readFileSync(path, "utf8"))
}

/** Free on both loopback addresses, since `localhost` may resolve to either. */
async function isPortFree(port: number): Promise<boolean> {
  const tryListen = (host: string) =>
    new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once("error", (err: NodeJS.ErrnoException) => {
        // No IPv6 on this machine is not a port in use.
        resolve(err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")
      })
      server.listen(port, host, () => server.close(() => resolve(true)))
    })
  return (await tryListen("127.0.0.1")) && (await tryListen("::1"))
}

async function choosePorts(): Promise<{ port: number; cdpPort?: number }> {
  for (let port = plan.port; port < plan.port + 40; port++) {
    const cdpPort = wantCdp ? port + TEST_APP_CDP_OFFSET : undefined
    if (!(await isPortFree(port))) continue
    if (cdpPort !== undefined && !(await isPortFree(cdpPort))) continue
    return { port, cdpPort }
  }
  throw new Error(`nessuna porta libera tra ${plan.port} e ${plan.port + 39}`)
}

function describe(record: TestAppRecord): string {
  return [
    `  ${record.label}`,
    `  vite  http://localhost:${record.port}`,
    ...(record.cdpPort ? [`  cdp   http://127.0.0.1:${record.cdpPort}/json/list`] : []),
    `  log   ${join(record.root, ".ade-test", "ade-test.log")}`,
  ].join("\n")
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}

/** Running, not running, or unknown because the process table could not be read. */
function state(target: TestAppPlan, treeRoot: string, record?: TestAppRecord): boolean | undefined {
  const rows = processTable()
  if (!rows) return undefined
  return instanceRunning(instanceProcesses(rows, target, treeRoot, record?.port, record?.startedAt), target, treeRoot)
}

// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  const existing = readRecord(plan.recordPath)
  if (state(plan, root, existing)) {
    console.log(`ADE Test è già aperta per questa cartella:\n${existing ? describe(existing) : `  ${plan.label}`}`)
    console.log("Per riavviarla: bun run test:app stop, poi bun run test:app")
    return
  }

  // Before cargo writes a binary: see scripts/medium-target.ts.
  spawnSync(process.execPath, [join(adeDir, "scripts", "medium-target.ts")], { stdio: "inherit" })

  for (const dir of [plan.stateDir, plan.profileDir, plan.tmpDir]) mkdirSync(dir, { recursive: true })

  const { port, cdpPort } = await choosePorts()
  writeFileSync(plan.configPath, devConfig(port))
  writeFileSync(plan.logPath, "")

  const browserArgs = [process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, cdpPort ? `--remote-debugging-port=${cdpPort}` : ""]
    .filter(Boolean)
    .join(" ")

  const out = openSync(plan.logPath, "a")
  const startedAt = Date.now()
  const child = spawn(
    process.execPath,
    tauriDevArgs(plan.configPath, readFileSync(join(adeDir, "src-tauri", "Cargo.toml"), "utf8"), { watch: wantWatch }),
    {
      cwd: adeDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        // The Rust linker fails on a %TEMP% it cannot write (LNK1104), and
        // each instance having its own keeps their scratch files apart.
        TEMP: plan.tmpDir,
        TMP: plan.tmpDir,
        // Two instances cannot share a WebView2 profile, and the default one
        // under %LOCALAPPDATA% belongs to whoever started first.
        WEBVIEW2_USER_DATA_FOLDER: plan.profileDir,
        ...(browserArgs ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs } : {}),
        ADE_TEST_LABEL: plan.label,
        VITE_ADE_TEST_LABEL: plan.name,
        // Read only by a test build (mailbox.rs): its own mailbox, not the one all test builds share.
        ADE_MAILBOX_ROOT: plan.mailboxDir,
      },
    },
  )
  child.unref()

  const record: TestAppRecord = { port, cdpPort, label: plan.label, root, startedAt }
  writeFileSync(plan.recordPath, JSON.stringify(record, null, 2))

  console.log(`ADE Test in avvio (la prima compilazione Rust di una cartella nuova richiede minuti):\n${describe(record)}`)
  console.log(
    wantWatch
      ? "  --watch: ogni modifica al Rust ricompila e riapre la finestra, chiudendo quella aperta"
      : "  le modifiche al Rust non riaprono la finestra: per ricompilare, stop e riavvio",
  )

  // Overridable so the timeout's cleanup can be tried without waiting 20 minutes.
  const timeoutMs = Number(process.env.ADE_TEST_START_TIMEOUT_MS) || 20 * 60_000
  // Cargo colours its output; the escapes sit between the words matched in the log.
  const readLog = () => stripAnsi(readFileSync(plan.logPath, "utf8"))
  const result = await superviseStart({
    readLog,
    running: () => state(plan, root, record),
    stop: () => stop(true),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs,
    onProgress: (progress) => console.log(`  compilazione ${progress}`),
  })
  switch (result.outcome) {
    case "started":
      console.log("\nFinestra aperta. Per chiuderla: bun run test:app stop")
      return
    case "failed":
      console.error(`\nADE Test non è partita: ${result.failure}`)
      console.error(result.log.split(/\r?\n/).filter(Boolean).slice(-15).join("\n"))
      break
    case "lost":
      console.error(`\nADE Test si è chiusa durante l'avvio. Log: ${plan.logPath}`)
      break
    case "timeout": {
      const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minuti` : `${Math.round(timeoutMs / 1000)} secondi`
      console.error(`\nADE Test non ha aperto la finestra entro ${limit}. Log: ${plan.logPath}`)
      break
    }
  }
  process.exit(1)
}

function stop(quiet = false): void {
  const rows = processTable()
  if (!rows) {
    console.error("ADE Test: non riesco a leggere l'elenco dei processi; non chiudo nulla.")
    process.exit(1)
  }
  const result = stopInstance({
    rows,
    record: readRecord(plan.recordPath),
    plan,
    root,
    selfPid: process.pid,
    kill: (pid) => {
      if (isWindows) spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" })
      else {
        try {
          process.kill(pid, "SIGTERM")
        } catch {
          // already gone
        }
      }
    },
    removeRecord: () => rmSync(plan.recordPath, { force: true }),
    // Without /F taskkill sends the window a close, as its X button does.
    close: (pid) => {
      if (isWindows) spawnSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" })
      else {
        try {
          process.kill(pid, "SIGTERM")
        } catch {
          // already gone
        }
      }
    },
    waitExit: (pids, timeoutMs) => {
      const alive = () => pids.filter((pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      })
      const deadline = Date.now() + timeoutMs
      while (alive().length > 0 && Date.now() < deadline) Bun.sleepSync(200)
      return alive()
    },
    reread: processTable,
  })
  if (result.outcome === "refused") {
    console.error(
      "ADE Test: non c'è una registrazione di quando è partita, quindi non chiudo processi che non so di aver avviato.\n" +
        `Chiudili a mano se sono tuoi (pid ${result.pids.join(", ")}).`,
    )
    process.exit(1)
  }
  if (!quiet) {
    console.log(result.outcome === "stopped" ? `ADE Test chiusa: ${plan.label}` : "Nessuna ADE Test in esecuzione per questa cartella.")
  }
}

function status(): void {
  const record = readRecord(plan.recordPath)
  const running = state(plan, root, record)
  if (running === undefined) console.log("Non riesco a leggere l'elenco dei processi.")
  else if (running) console.log(`In esecuzione:\n${record ? describe(record) : `  ${plan.label}`}`)
  else console.log("Nessuna ADE Test in esecuzione per questa cartella.")
}

function list(): void {
  const rows = processTable()
  if (!rows) {
    console.log("Non riesco a leggere l'elenco dei processi.")
    return
  }
  const trees = git(["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
  let found = 0
  for (const tree of trees) {
    const target = planTestApp({ root: tree, branch: "" })
    const record = readRecord(target.recordPath)
    if (!instanceRunning(instanceProcesses(rows, target, tree, record?.port), target, tree)) continue
    found++
    console.log((record ? describe(record) : `  ${target.name}`) + "\n")
  }
  if (found === 0) console.log("Nessuna ADE Test in esecuzione.")
}

switch (command) {
  case "start":
    await start()
    break
  case "stop":
    stop()
    break
  case "status":
    status()
    break
  case "list":
    list()
    break
  default:
    console.error(`Comando sconosciuto: ${command}. Usa start, stop, status o list.`)
    process.exit(1)
}

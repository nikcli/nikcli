#!/usr/bin/env bun
/**
 * Boots a *compiled* nikcli binary's real TUI inside a PTY and asserts it paints.
 *
 * `--version` / `--help` never import `@opentui/core`, so they stayed green
 * right through the 1.226.0 regression where the bundled tree-sitter worker was
 * compiled as code instead of embedded as a file: OpenTUI's asset import
 * returned a namespace whose `default` was undefined and the runtime died with
 * "undefined is not an object (evaluating 'loadedPath.startsWith')" during
 * module evaluation — i.e. on every single TUI launch. Only starting the actual
 * TUI exercises that path, so that is what this does: real binary, real pty,
 * real render, then assert on what got painted.
 *
 * Usage:
 *   bun run script/tui-smoke.ts [path/to/nikcli[.exe]]
 *
 * The binary is auto-detected from ./dist for the host platform when omitted.
 */
import { mkdtempSync, existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnPty, type PtyExitEvent } from "@nikcli-ai/util/pty"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(__dirname, "..")
process.chdir(dir)

const SETTLE_MS = Number(process.env.NIKCLI_SMOKE_TIMEOUT_MS ?? 45_000)
/**
 * Substrings that must appear in the painted output, comma-separated.
 *
 * "It painted something" is the right bar for the boot check, and too low a bar for anything that
 * claims to render a *particular* screen — a launch that silently falls back to the normal TUI paints
 * plenty of characters.
 */
const EXPECT = (process.env.NIKCLI_SMOKE_EXPECT ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
const COLS = 100
const ROWS = 30

/** Substrings that only ever show up when the TUI failed to boot. */
const FAILURE_MARKERS = [
  "loadedPath",
  "Unexpected error",
  "is not an object",
  "is not a function",
  "Cannot find module",
  "ResolveMessage",
]

function resolveBinary() {
  const explicit = process.argv[2] ?? process.env.NIKCLI_SMOKE_BIN
  if (explicit) return path.resolve(explicit)
  const platform = process.platform === "win32" ? "windows" : process.platform
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const exe = process.platform === "win32" ? "nikcli.exe" : "nikcli"
  const candidates = [
    path.join(dir, "dist", `nikcli-ai-${platform}-${arch}`, "bin", exe),
    path.join(dir, "dist", `nikcli-ai-${platform}-${arch}-baseline`, "bin", exe),
  ]
  const found = candidates.find((item) => existsSync(item))
  if (!found) throw new Error(`no compiled binary found; looked in:\n  ${candidates.join("\n  ")}`)
  return found
}

/** Drop ANSI/OSC control sequences so cell-by-cell text reassembles into words. */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g")
const ANSI_DCS = new RegExp(`${ESC}P[^${ESC}]*${ESC}\\\\`, "g")
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, "g")
const ANSI_OTHER = new RegExp(`${ESC}[@-Z\\\\-_]`, "g")
function plain(raw: string) {
  return raw.replace(ANSI_OSC, "").replace(ANSI_DCS, "").replace(ANSI_CSI, "").replace(ANSI_OTHER, "")
}

const binary = resolveBinary()
const home = mkdtempSync(path.join(os.tmpdir(), "nikcli-tui-smoke-"))

console.log(`[tui-smoke] binary ${binary}`)
console.log(`[tui-smoke] home   ${home}`)
console.log(`[tui-smoke] pty    ${COLS}x${ROWS}, settling for ${SETTLE_MS}ms`)

let raw = ""
let exit: PtyExitEvent | undefined

const pty = spawnPty({
  command: binary,
  cols: COLS,
  rows: ROWS,
  cwd: home,
  env: {
    ...process.env,
    NIKCLI_TEST_HOME: home,
    NIKCLI_DISABLE_AUTOUPDATE: "1",
    // Bun's native Windows ConPTY currently reports stdin.isTTY=false. Without
    // the managed-terminal marker the CLI treats stdin as a pipe and waits for
    // EOF forever, so the renderer never starts and the smoke sees no output.
    NIKCLI_TERMINAL: "1",
    TERM: "xterm-256color",
  },
})

pty.onData((data) => {
  raw += data
})
pty.onExit((event) => {
  exit = event
})

const deadline = Date.now() + SETTLE_MS
// Stop early once the renderer has clearly painted; otherwise wait it out so a
// slow-but-healthy boot still passes and a crash still gets its output captured.
while (Date.now() < deadline && !exit) {
  if (raw.includes("\x1b[?1049h") && plain(raw).trim().length > 200) {
    // Painting something is enough for the boot check, but not when a specific screen was asked for:
    // plugins load asynchronously, so a plugin route paints "Unknown plugin route" first and only
    // resolves once the plugin registry catches up. Keep waiting for what was actually requested.
    if (EXPECT.length === 0 || EXPECT.every((expected) => plain(raw).includes(expected))) break
  }
  await Bun.sleep(250)
}

// Snapshot before killing: `kill()` synchronously drives `onExit`, so reading
// `exit` afterwards would always look like the binary died on its own.
const died = exit
if (!died) pty.kill()
await rm(home, { recursive: true, force: true }).catch(() => undefined)

const text = plain(raw)
const failures: string[] = []

if (died) failures.push(`the binary exited (code ${died.exitCode}) instead of staying in the TUI`)
if (!raw.includes("\x1b[?1049h"))
  failures.push("the TUI never switched to the alternate screen — the renderer did not start")
if (text.trim().length < 200) failures.push(`the TUI painted only ${text.trim().length} printable characters`)
for (const marker of FAILURE_MARKERS) {
  if (text.includes(marker)) failures.push(`runtime error surfaced in the TUI output: ${JSON.stringify(marker)}`)
}
for (const expected of EXPECT) {
  if (!text.includes(expected)) failures.push(`expected text never painted: ${JSON.stringify(expected)}`)
}

if (failures.length > 0) {
  console.error("[tui-smoke] FAIL")
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error("[tui-smoke] captured output:")
  console.error(text.trim() ? text.trim().slice(0, 4000) : "(nothing)")
  process.exit(1)
}

console.log(`[tui-smoke] painted ${text.trim().length} printable characters, process still alive`)
if (EXPECT.length > 0) console.log(`[tui-smoke] found all ${EXPECT.length} expected string(s)`)
console.log("[tui-smoke] PASS — the compiled TUI booted and rendered")

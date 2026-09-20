#!/usr/bin/env bun

/**
 * ci-validate.ts — Central validation runner for CI pipeline and autofix.
 *
 * Runs the same set of checks in both contexts so results are reproducible.
 * Writes a sanitized summary to tmp/ci-validation-summary.md and exits non-zero
 * on the first critical failure.
 */

import { $ } from "bun"
import { mkdirSync, writeFileSync, existsSync } from "fs"
import { dirname, join } from "path"

const SUMMARY_DIR = "tmp"
const SUMMARY_PATH = join(SUMMARY_DIR, "ci-validation-summary.md")

// Token-like patterns to redact from any captured output
const REDACT_PATTERNS = [
  /ghp_[A-Za-z0-9]{36,}/g,
  /gho_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{36,}/g,
  /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, // JWT-like
  /x-access-token:[A-Za-z0-9_-]+@/g, // URL-embedded tokens
]

function redact(output: string): string {
  for (const pattern of REDACT_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]")
  }
  return output
}

interface ValidationStep {
  name: string
  command: string[]
  cwd?: string
  critical?: boolean // defaults to true
  timeout?: number // ms
}

const steps: ValidationStep[] = [
  {
    name: "Install dependencies",
    command: ["bun", "install", "--frozen-lockfile"],
    timeout: 120_000,
  },
  {
    name: "Typecheck",
    command: ["bun", "run", "typecheck"],
    timeout: 180_000,
  },
  {
    name: "Route coverage gate",
    command: ["bun", "run", "script/check-route-coverage.ts", "--strict"],
    cwd: "packages/nikcli",
    timeout: 30_000,
  },
  {
    name: "Open-payload allowlist gate",
    command: ["bun", "run", "script/check-open-payloads.ts"],
    cwd: "packages/nikcli",
    timeout: 30_000,
  },
  {
    name: "Account-required guard gate",
    command: ["bun", "run", "script/check-account-required.ts"],
    cwd: "packages/nikcli",
    timeout: 30_000,
  },
  {
    name: "Observability schema gate",
    command: ["bun", "run", "script/check-observability-schema.ts"],
    cwd: "packages/nikcli",
    timeout: 30_000,
  },
  {
    name: "Plugin v2 contract gate",
    command: ["bun", "run", "script/check-plugin-v2.ts"],
    cwd: "packages/nikcli",
    timeout: 30_000,
  },
  {
    name: "Workspace isolation gate",
    command: ["bun", "run", "script/check-workspace-isolation.ts"],
    cwd: "packages/nikcli",
    timeout: 30_000,
  },
  {
    name: "Network egress accounting gate",
    command: ["bun", "run", "script/check-network-egress.ts"],
    cwd: "packages/nikcli",
    timeout: 30_000,
  },
  {
    name: "Flag capture-at-import gate",
    command: ["bun", "run", "script/check-flag-capture.ts"],
    cwd: "packages/nikcli",
    timeout: 30_000,
  },
  {
    name: "Spec commit-reference gate",
    command: ["bun", "run", "script/check-spec-commit-refs.ts"],
    cwd: "packages/nikcli",
    // Non-blocking: it depends on the checkout having history, and a CI
    // strategy change should not turn a documentation link into a red build.
    critical: false,
    timeout: 60_000,
  },
  {
    name: "Generated HTTP client drift",
    command: [
      "bash",
      "-c",
      "bun run --cwd packages/nikcli generate:httpapi-clients && git diff --exit-code -- packages/sdk/js/src/httpapi/generated packages/nikcli/src/server/httpapi/client",
    ],
    timeout: 120_000,
  },
  {
    name: "Formatting",
    command: ["bun", "run", "format:check"],
    cwd: "packages/nikcli",
    timeout: 120_000,
  },
  {
    name: "Lint",
    command: ["bun", "run", "lint"],
    cwd: "packages/nikcli",
    timeout: 120_000,
  },
  // The full nikcli suite is deliberately NOT run here. It is ~350 files that
  // cost this job 2.5 minutes at best, and it took the runner down outright at
  // worst: a single bun process climbed to 14.5 GB and was killed at file 175,
  // failing the job with exit 143 that `critical: false` could not contain.
  // Running it as a non-critical step was worse than not running it — it burned
  // the time and then reported "Validation passed (non-blocking failures: Run
  // tests)", so real failures were logged and ignored.
  //
  // Validation runs no tests at all now: typecheck is the correctness signal
  // here, and the rest of these steps are static checks that finish in seconds.
  // No workflow runs the suite — `test.yml` was reduced to typecheck for the
  // same reason. `bun run test:ci` in packages/nikcli runs it anywhere else,
  // sharded so it does not OOM. See specs/v2/ci-pipeline-runtime-budgets.md.
  {
    name: "Shell syntax check (install script)",
    command: ["bash", "-n", "install"],
    critical: true,
    timeout: 10_000,
  },
  {
    // The Railway deploy step runs this script with `--detach`, so a syntax
    // error in it surfaces as a failed deploy nobody is watching rather than a
    // red pipeline. Parse it here instead.
    name: "Shell syntax check (railway-deploy)",
    command: ["bash", "-n", "script/railway-deploy.sh"],
    critical: true,
    timeout: 10_000,
  },
  {
    // A literal NIKCLI_VERSION in a Dockerfile goes stale silently — the image
    // keeps reporting an old release and no build ever fails over it.
    // Also reject positional Effect installs that change the validated graph.
    name: "Docker nikcli version check",
    command: ["bun", "run", "script/check-docker-versions.ts"],
    critical: true,
    timeout: 30_000,
  },
  {
    // `patchedDependencies` is keyed by exact version, so bumping a dependency
    // silently stops applying its patch — bun says nothing, and package.json
    // still lists the entry. `@modelcontextprotocol/sdk` lost its SSE
    // reconnect-storm fix that way for 25 days.
    name: "Patched dependency check",
    command: ["bun", "run", "script/check-patched-deps.ts"],
    critical: true,
    timeout: 30_000,
  },
  {
    // .railwayignore filters the repo-root `railway up` upload. A rule that
    // drops something Dockerfile.serve COPYs fails the Railway build, not CI.
    name: "Railway upload context check",
    command: ["bun", "run", "script/check-railway-context.ts"],
    critical: true,
    timeout: 30_000,
  },
  {
    // GitHub's ubuntu runners ship pwsh; local machines may not, and a missing
    // shell must not turn into a red pipeline.
    //
    // The trailing `exit 0` is load-bearing: without it pwsh printed the parse
    // result and then sat there instead of exiting, so the step hit its
    // timeout despite the check itself having passed. Telemetry is opted out
    // for the same reason — its first-run background work delays teardown.
    name: "PowerShell syntax check (install.ps1)",
    command: [
      "bash",
      "-c",
      'command -v pwsh >/dev/null 2>&1 || { echo "pwsh not available — skipped"; exit 0; }; ' +
        "POWERSHELL_TELEMETRY_OPTOUT=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 " +
        "pwsh -NoProfile -NonInteractive -NoLogo -Command '$e = $null; " +
        "[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path ./install.ps1), [ref]$null, [ref]$e) | Out-Null; " +
        'if ($e) { $e | Out-String | Write-Error; exit 1 }; Write-Output "install.ps1 parses clean"; exit 0\'',
    ],
    critical: true,
    timeout: 60_000,
  },
]

interface StepResult {
  name: string
  passed: boolean
  durationMs: number
  outputTail: string
}

const DEFAULT_TIMEOUT = 300_000
const TAIL_LINES = 20
/** How long to keep reading a step's pipes after the process itself has exited. */
const DRAIN_GRACE = 5_000

/**
 * Drains one of the child's pipes, echoing every chunk to our own stdout the
 * moment it arrives and appending it to `sink` for the summary tail.
 *
 * Echoing is what makes a step diagnosable. Output used to be buffered until
 * the child exited, so when a step took the runner down with it — no exit, no
 * summary, no artifact — the job log held nothing but the `▸` line and
 * `Process completed with exit code 143`. Chunks go out raw and unbuffered
 * rather than line-prefixed: a hard kill can land mid-line, and whatever
 * reached us should already be in the log when it does.
 */
async function drain(stream: ReadableStream<Uint8Array>, sink: string[]) {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    if (!text) continue
    process.stdout.write(text)
    sink.push(text)
    // Keep the tail bounded: a full test suite's output is megabytes, and only
    // the last TAIL_LINES of it ever reach the summary. Pipe chunks cap at
    // ~64KB, so 64 of them is already far more text than that.
    if (sink.length > 128) sink.splice(0, sink.length - 64)
  }
}

async function runStep(step: ValidationStep): Promise<StepResult> {
  const start = Date.now()
  let passed = false
  let outputTail = ""

  try {
    const proc = Bun.spawn(step.command, {
      cwd: step.cwd || process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb", CI: "true" },
    })

    // The declared timeout is enforced here. Without it a hung step (a test
    // waiting on a socket, a watcher that never exits) ran until the job's own
    // limit — hours, for a pipeline that should report in minutes.
    const limit = step.timeout ?? DEFAULT_TIMEOUT
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill(9)
    }, limit)

    // Both pipes are drained concurrently. Read one to completion before
    // touching the other and a child that fills the idle pipe's buffer blocks
    // forever writing to it, while we wait on a stream it will never advance —
    // a deadlock that only ends at the step timeout.
    const chunks: string[] = []
    const drained = Promise.all([drain(proc.stdout, chunks), drain(proc.stderr, chunks)])
    drained.catch(() => {})

    // Stop reading once the child is gone, even if the pipes are still open.
    // Bun.spawn puts the child in *our* process group, so `proc.kill()` reaches
    // only the direct child: kill `bun run test:ci` and its parallel test
    // workers live on, still holding the inherited stdout pipe. Waiting on the
    // pipe alone therefore ignores the timeout entirely — a 2s limit sat there
    // for the grandchild's full 30s. The grace period is what lets genuinely
    // buffered output land before we move on.
    await Promise.race([drained, proc.exited.then(() => Bun.sleep(DRAIN_GRACE))])
    const exitCode = await proc.exited
    clearTimeout(timer)

    const tailLines = chunks.join("").trim().split("\n").slice(-TAIL_LINES).join("\n")
    outputTail = redact(timedOut ? `${tailLines}\n[timed out after ${(limit / 1000).toFixed(0)}s]` : tailLines)
    passed = !timedOut && exitCode === 0
  } catch (err) {
    outputTail = redact(String(err))
    passed = false
  }

  return {
    name: step.name,
    passed,
    durationMs: Date.now() - start,
    outputTail,
  }
}

async function main() {
  // Ensure summary directory exists
  if (!existsSync(SUMMARY_DIR)) {
    mkdirSync(SUMMARY_DIR, { recursive: true })
  }

  const results: StepResult[] = []
  let hasCriticalFailure = false

  console.log("=== CI Validation Started ===\n")

  for (const step of steps) {
    const isCritical = step.critical !== false
    console.log(`▸ ${step.command.join(" ")}`)
    const result = await runStep(step)
    results.push(result)

    const icon = result.passed ? "✓" : "✗"
    const duration = (result.durationMs / 1000).toFixed(1)
    // Say which failures block. A bare `✗` reads the same either way, which is
    // how a permanently failing test step sat in green runs without anyone
    // noticing it had failed.
    const note = result.passed ? "" : isCritical ? " — blocking" : " — non-blocking"
    console.log(`  ${icon} ${step.name} (${duration}s)${note}`)

    if (!result.passed && isCritical) {
      hasCriticalFailure = true
      // Continue running remaining steps for summary, but mark that we'll fail
    }
  }

  // Write summary
  const lines: string[] = []
  lines.push("# CI Validation Summary")
  lines.push("")
  lines.push(`**Triggered by:** ${process.env.GITHUB_EVENT_NAME || "local"}`)
  lines.push(`**Ref:** ${process.env.GITHUB_REF_NAME || "N/A"}`)
  lines.push(`**SHA:** ${process.env.GITHUB_SHA || "N/A"}`)
  lines.push("")

  const passedCount = results.filter((r) => r.passed).length
  const failedCount = results.filter((r) => !r.passed).length
  lines.push(`**Results:** ${passedCount} passed, ${failedCount} failed`)
  lines.push("")

  for (const result of results) {
    const icon = result.passed ? "✓" : "✗"
    lines.push(`## ${icon} ${result.name}`)
    if (!result.passed && result.outputTail) {
      lines.push("```")
      lines.push(result.outputTail)
      lines.push("```")
    }
    lines.push("")
  }

  writeFileSync(SUMMARY_PATH, lines.join("\n"))
  console.log(`\nSummary written to ${SUMMARY_PATH}`)

  const nonBlocking = results.filter((r) => !r.passed).map((r) => r.name)

  if (hasCriticalFailure) {
    console.log("\n❌ Validation failed")
    process.exit(1)
  }

  if (nonBlocking.length > 0) {
    console.log(`\n✅ Validation passed (non-blocking failures: ${nonBlocking.join(", ")})`)
  } else {
    console.log("\n✅ Validation passed")
  }

  // Explicit, because a timed-out step can leave orphaned grandchildren holding
  // the pipes we abandoned. Falling off the end of main() then keeps the runner
  // alive until *they* exit — a 2s timeout kept the whole script up for the
  // grandchild's full minute. The summary is already written synchronously.
  process.exit(0)
}

main().catch((err) => {
  console.error("Validation runner crashed:", redact(String(err)))
  process.exit(2)
})

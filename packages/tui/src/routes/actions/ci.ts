import { run, runText, type RunResult } from "@tui/routes/workspace/repo-status"

/**
 * GitHub Actions data for the workspace CI tab.
 *
 * Everything goes through the `gh` CLI rather than the server's
 * `/mobile/github/**` routes: the TUI already drives `git` and `gh` locally for
 * the commits and PR views, and `gh` carries the user's own auth, so the CI tab
 * works in any checkout without a mobile session or a connector token.
 */

export type RunStatus = string
export type RunConclusion = string

export type WorkflowRun = {
  id: number
  number: number
  attempt: number
  workflow: string
  title: string
  branch: string
  event: string
  /** `queued` | `in_progress` | `completed` | … — left open, GitHub adds states. */
  status: RunStatus
  /** `success` | `failure` | `cancelled` | … — empty while the run is going. */
  conclusion: RunConclusion
  url: string
  createdAt: string
  startedAt: string
  updatedAt: string
}

export type WorkflowJob = {
  id: number
  name: string
  status: RunStatus
  conclusion: RunConclusion
  startedAt: string
  completedAt: string
  url: string
  steps: Array<{ name: string; status: RunStatus; conclusion: RunConclusion; number: number }>
}

export type Workflow = {
  id: number
  name: string
  path: string
  state: string
}

export type CiState = {
  runs: WorkflowRun[]
  workflows: Workflow[]
  /** Set when `gh` is missing, unauthenticated, or the repo has no Actions. */
  error?: string
  configured: boolean
}

export const RUN_LIMIT = 40

export function ghAvailable() {
  return Bun.which("gh") !== null
}

function str(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function num(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function parseRuns(json: string): WorkflowRun[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((raw) => {
    const row = raw as Record<string, unknown>
    return {
      id: num(row["databaseId"]),
      number: num(row["number"]),
      attempt: num(row["attempt"], 1),
      workflow: str(row["workflowName"], str(row["name"], "Workflow")),
      title: str(row["displayTitle"], str(row["name"], "")),
      branch: str(row["headBranch"]),
      event: str(row["event"]),
      status: str(row["status"]),
      conclusion: str(row["conclusion"]),
      url: str(row["url"]),
      createdAt: str(row["createdAt"]),
      startedAt: str(row["startedAt"], str(row["createdAt"])),
      updatedAt: str(row["updatedAt"]),
    }
  })
}

export function parseWorkflows(json: string): Workflow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((raw) => {
    const row = raw as Record<string, unknown>
    return {
      id: num(row["id"]),
      name: str(row["name"], str(row["path"], "Workflow")),
      path: str(row["path"]),
      state: str(row["state"], "active"),
    }
  })
}

export function parseJobs(json: string): WorkflowJob[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const jobs = (parsed as { jobs?: unknown })?.jobs
  if (!Array.isArray(jobs)) return []
  return jobs.map((raw) => {
    const row = raw as Record<string, unknown>
    const steps = Array.isArray(row["steps"]) ? (row["steps"] as Array<Record<string, unknown>>) : []
    return {
      id: num(row["databaseId"]),
      name: str(row["name"], "job"),
      status: str(row["status"]),
      conclusion: str(row["conclusion"]),
      startedAt: str(row["startedAt"]),
      completedAt: str(row["completedAt"]),
      url: str(row["url"]),
      steps: steps.map((step) => ({
        name: str(step["name"], "step"),
        status: str(step["status"]),
        conclusion: str(step["conclusion"]),
        number: num(step["number"]),
      })),
    }
  })
}

/** True while the run can still change — drives the "live" marker and polling. */
export function isRunning(row: { status: RunStatus }) {
  return row.status !== "completed" && row.status !== ""
}

export type RunTone = "success" | "failure" | "running" | "pending" | "neutral"

export function runTone(row: { status: RunStatus; conclusion: RunConclusion }): RunTone {
  if (isRunning(row)) return row.status === "queued" || row.status === "waiting" ? "pending" : "running"
  switch (row.conclusion) {
    case "success":
      return "success"
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failure"
    case "cancelled":
    case "skipped":
    case "neutral":
    case "stale":
      return "neutral"
    case "action_required":
      return "pending"
    default:
      return row.conclusion ? "neutral" : "pending"
  }
}

export function runIcon(tone: RunTone) {
  switch (tone) {
    case "success":
      return "✓"
    case "failure":
      return "✗"
    case "running":
      return "●"
    case "pending":
      return "◌"
    case "neutral":
      return "–"
  }
}

/** `2m 14s`, `1h 03m`, or `—` when the run never started. */
export function formatDuration(startedAt: string, endedAt: string, now = Date.now()) {
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return "—"
  const end = endedAt ? Date.parse(endedAt) : now
  const ms = (Number.isNaN(end) ? now : end) - start
  if (ms < 0) return "—"
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** Short relative age (`3m`, `2h`, `4d`) for the right-hand column. */
export function formatAge(timestamp: string, now = Date.now()) {
  const value = Date.parse(timestamp)
  if (Number.isNaN(value)) return ""
  const seconds = Math.max(0, Math.floor((now - value) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

const RUN_FIELDS = [
  "databaseId",
  "number",
  "attempt",
  "workflowName",
  "displayTitle",
  "headBranch",
  "event",
  "status",
  "conclusion",
  "url",
  "createdAt",
  "startedAt",
  "updatedAt",
].join(",")

/** Human message for a failed `gh` call — auth and "no workflows" read differently. */
export function ghErrorMessage(result: RunResult) {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  if (!text) return `gh exited with ${result.exitCode}`
  if (/not logged|gh auth login/i.test(text)) return "Not signed in to GitHub — run `gh auth login`"
  if (/no runs found/i.test(text)) return ""
  if (/could not determine|not a git repository|no git remotes/i.test(text))
    return "No GitHub remote for this directory"
  return text.split("\n").find((line) => line.trim().length > 0) ?? text
}

export async function loadCiState(directory: string, options: { branch?: string } = {}): Promise<CiState> {
  if (!ghAvailable()) {
    return { runs: [], workflows: [], configured: false, error: "gh not installed — install the GitHub CLI for CI" }
  }
  const args = ["run", "list", "--limit", String(RUN_LIMIT), "--json", RUN_FIELDS]
  if (options.branch) args.push("--branch", options.branch)
  const [runsResult, workflowsJson] = await Promise.all([
    run("gh", args, directory, { timeoutMs: 25_000 }),
    runText("gh", ["workflow", "list", "--all", "--json", "id,name,path,state"], directory),
  ])
  const workflows = parseWorkflows(workflowsJson ?? "")
  if (runsResult.exitCode !== 0) {
    const error = ghErrorMessage(runsResult)
    return { runs: [], workflows, configured: workflows.length > 0, error: error || undefined }
  }
  const runs = parseRuns(runsResult.stdout)
  return { runs, workflows, configured: runs.length > 0 || workflows.length > 0 }
}

export async function loadJobs(directory: string, runID: number): Promise<WorkflowJob[]> {
  const json = await runText("gh", ["run", "view", String(runID), "--json", "jobs"], directory)
  if (!json) return []
  return parseJobs(json)
}

/** Latest run for a branch — the CI chip in the workspace strip. */
export async function loadLatestRun(directory: string, branch: string): Promise<WorkflowRun | undefined> {
  if (!ghAvailable() || !branch || branch === "detached") return undefined
  const json = await runText("gh", ["run", "list", "--limit", "1", "--branch", branch, "--json", RUN_FIELDS], directory)
  if (!json) return undefined
  return parseRuns(json)[0]
}

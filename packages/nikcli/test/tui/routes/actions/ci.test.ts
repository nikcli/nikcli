import { describe, expect, it } from "bun:test"
import {
  formatAge,
  formatDuration,
  ghErrorMessage,
  isRunning,
  parseJobs,
  parseRuns,
  parseWorkflows,
  runIcon,
  runTone,
} from "@tui/routes/actions/ci"

const RUNS = JSON.stringify([
  {
    databaseId: 42,
    number: 7,
    attempt: 2,
    workflowName: "CI",
    displayTitle: "fix: the thing",
    headBranch: "live-main",
    event: "push",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/o/r/actions/runs/42",
    createdAt: "2026-09-18T10:00:00Z",
    startedAt: "2026-09-18T10:00:10Z",
    updatedAt: "2026-09-18T10:04:10Z",
  },
  { databaseId: 43, status: "in_progress", conclusion: "" },
])

describe("parseRuns", () => {
  it("maps the gh fields and fills the gaps", () => {
    const [first, second] = parseRuns(RUNS)
    expect(first).toMatchObject({
      id: 42,
      number: 7,
      attempt: 2,
      workflow: "CI",
      title: "fix: the thing",
      branch: "live-main",
      conclusion: "failure",
    })
    expect(second.workflow).toBe("Workflow")
    expect(second.attempt).toBe(1)
    expect(second.branch).toBe("")
  })

  it("returns an empty list for junk", () => {
    expect(parseRuns("")).toEqual([])
    expect(parseRuns("not json")).toEqual([])
    expect(parseRuns('{"runs":[]}')).toEqual([])
  })
})

describe("parseWorkflows", () => {
  it("falls back to the path when a workflow has no name", () => {
    const parsed = parseWorkflows('[{"id":1,"path":".github/workflows/ci.yml","state":"active"}]')
    expect(parsed[0]).toEqual({
      id: 1,
      name: ".github/workflows/ci.yml",
      path: ".github/workflows/ci.yml",
      state: "active",
    })
  })

  it("tolerates junk", () => {
    expect(parseWorkflows("null")).toEqual([])
  })
})

describe("parseJobs", () => {
  it("reads the jobs and their steps out of `gh run view --json jobs`", () => {
    const jobs = parseJobs(
      JSON.stringify({
        jobs: [
          {
            databaseId: 9,
            name: "typecheck",
            status: "completed",
            conclusion: "failure",
            startedAt: "2026-09-18T10:00:00Z",
            completedAt: "2026-09-18T10:02:30Z",
            url: "https://github.com/o/r/actions/runs/42/job/9",
            steps: [{ name: "bun run typecheck", status: "completed", conclusion: "failure", number: 3 }],
          },
        ],
      }),
    )
    expect(jobs).toHaveLength(1)
    expect(jobs[0].steps[0].conclusion).toBe("failure")
    expect(formatDuration(jobs[0].startedAt, jobs[0].completedAt)).toBe("2m 30s")
  })

  it("returns an empty list when there is no jobs key", () => {
    expect(parseJobs("{}")).toEqual([])
    expect(parseJobs("[]")).toEqual([])
  })
})

describe("runTone", () => {
  it("treats anything unfinished as live", () => {
    expect(runTone({ status: "in_progress", conclusion: "" })).toBe("running")
    expect(runTone({ status: "queued", conclusion: "" })).toBe("pending")
    expect(isRunning({ status: "in_progress" })).toBe(true)
    expect(isRunning({ status: "completed" })).toBe(false)
    // An empty status means gh told us nothing — do not claim it is running.
    expect(isRunning({ status: "" })).toBe(false)
  })

  it("maps the conclusions", () => {
    expect(runTone({ status: "completed", conclusion: "success" })).toBe("success")
    expect(runTone({ status: "completed", conclusion: "failure" })).toBe("failure")
    expect(runTone({ status: "completed", conclusion: "timed_out" })).toBe("failure")
    expect(runTone({ status: "completed", conclusion: "cancelled" })).toBe("neutral")
    expect(runTone({ status: "completed", conclusion: "action_required" })).toBe("pending")
    expect(runTone({ status: "completed", conclusion: "" })).toBe("pending")
  })

  it("has an icon for every tone", () => {
    for (const tone of ["success", "failure", "running", "pending", "neutral"] as const) {
      expect(runIcon(tone).length).toBe(1)
    }
  })
})

describe("formatDuration", () => {
  const start = "2026-09-18T10:00:00Z"

  it("scales from seconds to hours", () => {
    expect(formatDuration(start, "2026-09-18T10:00:45Z")).toBe("45s")
    expect(formatDuration(start, "2026-09-18T10:02:05Z")).toBe("2m 05s")
    expect(formatDuration(start, "2026-09-18T11:07:00Z")).toBe("1h 07m")
  })

  it("measures an unfinished run against now", () => {
    expect(formatDuration(start, "", Date.parse("2026-09-18T10:00:30Z"))).toBe("30s")
  })

  it("has nothing to show without a start", () => {
    expect(formatDuration("", "2026-09-18T10:00:45Z")).toBe("—")
  })
})

describe("formatAge", () => {
  const now = Date.parse("2026-09-18T12:00:00Z")

  it("picks the largest unit that still reads as a number", () => {
    expect(formatAge("2026-09-18T11:59:30Z", now)).toBe("30s")
    expect(formatAge("2026-09-18T11:30:00Z", now)).toBe("30m")
    expect(formatAge("2026-09-18T09:00:00Z", now)).toBe("3h")
    expect(formatAge("2026-09-15T12:00:00Z", now)).toBe("3d")
    expect(formatAge("2026-08-18T12:00:00Z", now)).toBe("4w")
    expect(formatAge("", now)).toBe("")
  })
})

describe("ghErrorMessage", () => {
  it("translates the two failures a user can act on", () => {
    expect(ghErrorMessage({ stdout: "", stderr: "gh auth login required", exitCode: 1 })).toContain("gh auth login")
    expect(ghErrorMessage({ stdout: "", stderr: "could not determine the repository", exitCode: 1 })).toBe(
      "No GitHub remote for this directory",
    )
  })

  it("says nothing when a repo simply has no runs", () => {
    expect(ghErrorMessage({ stdout: "", stderr: "no runs found", exitCode: 1 })).toBe("")
  })
})

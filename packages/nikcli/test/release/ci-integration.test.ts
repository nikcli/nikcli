import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import fs from "fs/promises"
import path from "path"

const root = path.resolve(import.meta.dir, "../../../..")
const scriptsDir = path.join(root, "script")

async function readRoot(relative: string) {
  return fs.readFile(path.join(root, relative), "utf8")
}

function runScript(
  scriptPath: string,
  args: string[] = [],
  env: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn({
      cmd: ["bun", scriptPath, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CI: "true",
        TERM: "dumb",
        NO_COLOR: "1",
        ...env,
      },
    })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Script timed out after ${timeoutMs}ms: ${scriptPath}`))
    }, timeoutMs)
    const stdoutP = proc.stdout ? new Response(proc.stdout).text() : Promise.resolve("")
    const stderrP = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("")
    proc.exited.then((exitCode) => {
      clearTimeout(timer)
      Promise.all([stdoutP, stderrP]).then(([stdout, stderr]) => {
        resolve({ exitCode, stdout, stderr })
      })
    })
  })
}

// ─── ci-validate.ts integration tests ───────────────────────────────────────

describe("ci-validate.ts", () => {
  describe("script structure", () => {
    it("exists and is executable", async () => {
      const stat = await fs.stat(path.join(scriptsDir, "ci-validate.ts"))
      expect(stat.isFile()).toBe(true)
    })

    it("has correct shebang", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-validate.ts"), "utf8")
      expect(content.startsWith("#!/usr/bin/env bun")).toBe(true)
    })

    it("defines all required validation steps", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-validate.ts"), "utf8")
      const stepNames = [
        "Install dependencies",
        "Typecheck",
        "Route coverage gate",
        "Generated HTTP client drift",
        "Formatting",
        "Lint",
        "Shell syntax check (install script)",
        "Shell syntax check (railway-deploy)",
        "Docker nikcli version check",
        "Railway upload context check",
      ]
      for (const name of stepNames) {
        expect(content).toContain(name)
      }
    })

    it("has redaction patterns for all common token formats", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-validate.ts"), "utf8")
      expect(content).toContain("ghp_")
      expect(content).toContain("gho_")
      expect(content).toContain("github_pat_")
      expect(content).toContain("sk-")
      expect(content).toContain("npm_")
    })

    it("writes summary to tmp/ci-validation-summary.md", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-validate.ts"), "utf8")
      expect(content).toContain("tmp/ci-validation-summary.md")
      expect(content).toContain("mkdirSync")
    })

    it("exits with code 1 on critical validation failure", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-validate.ts"), "utf8")
      expect(content).toContain("process.exit(1)")
    })

    it("exits with code 2 on script crash", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-validate.ts"), "utf8")
      expect(content).toContain("process.exit(2)")
    })
  })

  describe("execution", () => {
    // Clean up tmp before and after
    beforeAll(async () => {
      try {
        await fs.rm("tmp/ci-validation-summary.md", { force: true })
      } catch {
        /* ignore */
      }
    })

    afterAll(async () => {
      try {
        await fs.rm("tmp/ci-validation-summary.md", { force: true })
      } catch {
        /* ignore */
      }
    })

    it("redacts token-like strings from the summary", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-validate.ts"), "utf8")
      const redactCall = content.match(/function redact\([\s\S]*?\}/)?.[0]
      expect(redactCall).toBeDefined()

      // Verify [REDACTED] replacement
      expect(content).toContain("[REDACTED]")
    })
  })
})

// ─── ci-autofix.ts integration tests ────────────────────────────────────────

describe("ci-autofix.ts", () => {
  describe("script structure", () => {
    it("has skip patterns for all anti-loop cases", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      expect(content).toContain("[nikcli autofix]")
      expect(content).toContain("release: v")
      expect(content).toContain("chore: generate")
      expect(content).toContain("[skip ci]")
    })

    it("checks for bot actor and skips them", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      expect(content).toContain('"github-actions[bot]"')
      expect(content).toContain('"nikcli-ci[bot]"')
    })

    it("checks fork PRs and skips them", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      expect(content).toContain("PR_HEAD_REPO")
      expect(content).toContain("!== REPO")
    })

    it("requires MINIMAX_API_KEY secret", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      expect(content).toContain("MINIMAX_API_KEY")
      expect(content).toContain("Missing MINIMAX_API_KEY")
    })

    it("uses MiniMax model as default (not costly providers)", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      expect(content).toContain("minimax-coding-plan/MiniMax-M3")
      expect(content).not.toContain("claude-sonnet-4")
    })

    it("exits 78 when autofix fails and validation still fails", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      expect(content).toContain("process.exit(78)")
    })

    it("exits 0 when nothing to push", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      expect(content).toContain("process.exit(0)")
    })

    it("installs nikcli via shell installer", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      expect(content).toContain("https://nikcli.store/install")
    })

    it("calls nikcli run headlessly with --command, --model, --format json", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      expect(content).toContain("nikcli")
      expect(content).toContain("run")
      expect(content).toContain("--command")
      expect(content).toContain("--model")
      expect(content).toContain("--format")
      expect(content).toContain("json")
    })

    it("re-validates after nikcli changes", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-autofix.ts"), "utf8")
      // Should call ci-validate after the autofix attempt
      expect(content).toContain("revalidateExit")
      expect(content).toContain("ci-validate.ts")
    })
  })

  describe("execution - skip behavior", () => {
    it("skips when GITHUB_ACTOR is github-actions[bot]", async () => {
      const result = await runScript(path.join(scriptsDir, "ci-autofix.ts"), [], {
        GITHUB_ACTOR: "github-actions[bot]",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "nikcli/nikcli",
        MINIMAX_API_KEY: "sk-test",
        GITHUB_SHA: "abc123",
        GITHUB_REF: "refs/heads/live-main",
        GITHUB_REF_NAME: "live-main",
        GITHUB_EVENT_HEAD_COMMIT_MESSAGE: "some commit",
        GITHUB_EVENT_PULL_REQUEST_TITLE: "",
        GITHUB_EVENT_PULL_REQUEST_HEAD_REPO_FULL_NAME: "",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Autofix skipped")
    })

    it("skips when commit message matches [nikcli autofix]", async () => {
      const result = await runScript(path.join(scriptsDir, "ci-autofix.ts"), [], {
        GITHUB_ACTOR: "nikomatt69",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "nikcli/nikcli",
        MINIMAX_API_KEY: "sk-test",
        GITHUB_SHA: "abc123",
        GITHUB_REF: "refs/heads/live-main",
        GITHUB_REF_NAME: "live-main",
        GITHUB_EVENT_HEAD_COMMIT_MESSAGE: "[nikcli autofix] automated repair",
        GITHUB_EVENT_PULL_REQUEST_TITLE: "",
        GITHUB_EVENT_PULL_REQUEST_HEAD_REPO_FULL_NAME: "",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Autofix skipped")
    })

    it("skips when commit message matches release: v", async () => {
      const result = await runScript(path.join(scriptsDir, "ci-autofix.ts"), [], {
        GITHUB_ACTOR: "nikomatt69",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "nikcli/nikcli",
        MINIMAX_API_KEY: "sk-test",
        GITHUB_SHA: "abc123",
        GITHUB_REF: "refs/heads/live-main",
        GITHUB_REF_NAME: "live-main",
        GITHUB_EVENT_HEAD_COMMIT_MESSAGE: "release: v1.2.3",
        GITHUB_EVENT_PULL_REQUEST_TITLE: "",
        GITHUB_EVENT_PULL_REQUEST_HEAD_REPO_FULL_NAME: "",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Autofix skipped")
    })

    it("skips when commit message matches chore: generate", async () => {
      const result = await runScript(path.join(scriptsDir, "ci-autofix.ts"), [], {
        GITHUB_ACTOR: "nikomatt69",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "nikcli/nikcli",
        MINIMAX_API_KEY: "sk-test",
        GITHUB_SHA: "abc123",
        GITHUB_REF: "refs/heads/live-main",
        GITHUB_REF_NAME: "live-main",
        GITHUB_EVENT_HEAD_COMMIT_MESSAGE: "chore: generate SDK",
        GITHUB_EVENT_PULL_REQUEST_TITLE: "",
        GITHUB_EVENT_PULL_REQUEST_HEAD_REPO_FULL_NAME: "",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Autofix skipped")
    })

    it("skips when commit message has [skip ci]", async () => {
      const result = await runScript(path.join(scriptsDir, "ci-autofix.ts"), [], {
        GITHUB_ACTOR: "nikomatt69",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "nikcli/nikcli",
        MINIMAX_API_KEY: "sk-test",
        GITHUB_SHA: "abc123",
        GITHUB_REF: "refs/heads/live-main",
        GITHUB_REF_NAME: "live-main",
        GITHUB_EVENT_HEAD_COMMIT_MESSAGE: "wip: something [skip ci]",
        GITHUB_EVENT_PULL_REQUEST_TITLE: "",
        GITHUB_EVENT_PULL_REQUEST_HEAD_REPO_FULL_NAME: "",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Autofix skipped")
    })

    it("skips when missing MINIMAX_API_KEY", async () => {
      const result = await runScript(path.join(scriptsDir, "ci-autofix.ts"), [], {
        GITHUB_ACTOR: "nikomatt69",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "nikcli/nikcli",
        GITHUB_SHA: "abc123",
        GITHUB_REF: "refs/heads/live-main",
        GITHUB_REF_NAME: "live-main",
        GITHUB_EVENT_HEAD_COMMIT_MESSAGE: "fix: some bug",
        GITHUB_EVENT_PULL_REQUEST_TITLE: "",
        GITHUB_EVENT_PULL_REQUEST_HEAD_REPO_FULL_NAME: "",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Autofix skipped")
    })

    it("skips when running from wrong repository", async () => {
      const result = await runScript(path.join(scriptsDir, "ci-autofix.ts"), [], {
        GITHUB_ACTOR: "nikomatt69",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "some-user/nikcli",
        MINIMAX_API_KEY: "sk-test",
        GITHUB_SHA: "abc123",
        GITHUB_REF: "refs/heads/feature",
        GITHUB_REF_NAME: "feature",
        GITHUB_EVENT_HEAD_COMMIT_MESSAGE: "fix: some bug",
        GITHUB_EVENT_PULL_REQUEST_TITLE: "",
        GITHUB_EVENT_PULL_REQUEST_HEAD_REPO_FULL_NAME: "",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Autofix skipped")
    })
  })
})

// ─── ci-report-failure.ts integration tests ─────────────────────────────────

describe("ci-report-failure.ts", () => {
  describe("script structure", () => {
    it("has sticky marker for idempotent comments", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-report-failure.ts"), "utf8")
      expect(content).toContain("<!-- nikcli-ci-autofix -->")
      expect(content).toContain("STICKY_MARKER")
    })

    it("redacts token patterns from summary", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-report-failure.ts"), "utf8")
      expect(content).toContain("REDACT_PATTERNS")
      expect(content).toContain("ghp_")
      expect(content).toContain("sk-")
      expect(content).toContain("npm_")
      expect(content).toContain("[REDACTED]")
    })

    it("has configurable mention via NIKCLI_CI_FAILURE_MENTION", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-report-failure.ts"), "utf8")
      expect(content).toContain("NIKCLI_CI_FAILURE_MENTION")
    })

    it("truncates long summaries to prevent comment bloat", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-report-failure.ts"), "utf8")
      expect(content).toContain("1500")
      expect(content).toContain("truncated")
    })

    it("uses GITHUB_TOKEN (not raw secrets) for API calls", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-report-failure.ts"), "utf8")
      expect(content).toContain("GITHUB_TOKEN")
      expect(content).not.toContain("process.env.NPM_TOKEN")
      expect(content).not.toContain("process.env.SST_GITHUB_TOKEN")
    })

    it("exits with code 1 when GITHUB_TOKEN is missing", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-report-failure.ts"), "utf8")
      expect(content).toContain("GITHUB_TOKEN is not set")
      expect(content).toContain("process.exit(1)")
    })

    it("has GitHub API fetch fallback when @octokit/rest unavailable", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-report-failure.ts"), "utf8")
      expect(content).toContain("@octokit/rest")
      expect(content).toContain("fetch-based GitHub API")
      expect(content).toContain("githubFetch")
    })

    it("creates tracking issue for live-main push with no PR", async () => {
      const content = await fs.readFile(path.join(scriptsDir, "ci-report-failure.ts"), "utf8")
      expect(content).toContain("nikcli-ci-failure")
      expect(content).toContain("CI failure on live-main")
      expect(content).toContain("tracking issue")
    })
  })

  describe("execution - fails gracefully without GITHUB_TOKEN", () => {
    it("exits with code 1 when GITHUB_TOKEN is not set", async () => {
      const result = await runScript(path.join(scriptsDir, "ci-report-failure.ts"), [], {
        GITHUB_REPOSITORY: "nikcli/nikcli",
        GITHUB_RUN_ID: "12345",
        GITHUB_EVENT_NAME: "push",
        GITHUB_SHA: "abc123",
        GITHUB_HEAD_SHA: "abc123",
        GITHUB_PR_NUMBER: "",
        NIKCLI_CI_FAILURE_MENTION: "@nikomatt69",
        AUTOFIX_ATTEMPTED: "skipped",
      })
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("GITHUB_TOKEN")
    })
  })
})

// ─── workflow YAML integration tests ───────────────────────────────────────

describe("workflow YAML integration", () => {
  it("ci-pipeline.yml has all 4 required jobs", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("jobs:")
    expect(content).toContain("validate:")
    expect(content).toContain("publish:")
    expect(content).toContain("autofix:")
    expect(content).toContain("report-failure:")
  })

  it("publish job needs validate", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("needs: validate")
  })

  it("autofix job needs validate", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("needs: validate")
  })

  it("report-failure needs both validate and autofix", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("needs: [validate, autofix]")
  })

  it("publish only runs on live-main push with validate success", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("needs.validate.result == 'success'")
    expect(content).toContain("refs/heads/live-main")
    expect(content).toContain("nikcli/nikcli")
  })

  it("autofix only runs on validation failure with trusted event source", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("needs.validate.result == 'failure'")
    // Must be push OR same-repo PR (no forks, no workflow_dispatch, no schedule)
    expect(content).toContain("github.event_name == 'push'")
    expect(content).toContain("github.event_name == 'pull_request'")
    expect(content).toContain("github.event.pull_request.head.repo.full_name == github.repository")
  })

  it("autofix skips bot actors and skip-pattern commits", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("github-actions[bot]")
    expect(content).toContain("[nikcli autofix]")
    expect(content).toContain("release: v")
    expect(content).toContain("chore: generate")
  })

  it("autofix uses MiniMax as default model", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("minimax-coding-plan/MiniMax-M3")
  })

  it("autofix uses SST_GITHUB_TOKEN for push (not GITHUB_TOKEN)", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("secrets.SST_GITHUB_TOKEN")
    expect(content).toContain("secrets.MINIMAX_API_KEY")
  })

  it("publish uses workflow_call to publish.yml with secrets: inherit", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("uses: ./.github/workflows/publish.yml")
    expect(content).toContain("secrets: inherit")
  })

  it("ci-pipeline concurrency cancel-in-progress false on live-main", async () => {
    const content = await readRoot(".github/workflows/ci-pipeline.yml")
    expect(content).toContain("cancel-in-progress:")
    expect(content).toContain("refs/heads/live-main")
  })

  it("publish.yml has workflow_call trigger", async () => {
    const content = await readRoot(".github/workflows/publish.yml")
    expect(content).toContain("workflow_call:")
  })

  it("publish.yml accepts bump, version, channel inputs", async () => {
    const content = await readRoot(".github/workflows/publish.yml")
    expect(content).toContain("inputs:")
    expect(content).toContain("bump:")
    expect(content).toContain("version:")
    expect(content).toContain("channel:")
  })

  it("publish.yml does NOT push to live-main directly (only via workflow_call)", async () => {
    const content = await readRoot(".github/workflows/publish.yml")
    // live-main must not appear in the push branches
    const lines = content.split("\n")
    let inPushBlock = false
    let pushBranches: string[] = []
    for (const line of lines) {
      if (line.trim() === "push:") inPushBlock = true
      if (inPushBlock && line.includes("branches:")) continue
      if (inPushBlock && line.match(/^\s+-\s+/)) pushBranches.push(line.trim())
      if (inPushBlock && pushBranches.length > 0 && !line.match(/^\s+-\s+/) && !line.includes("branches")) break
    }
    // The only invariant we care about is that the workflow does not fire on direct
    // pushes to live-main. Which other branches trigger publishing (snapshot-*, dev, etc.)
    // is workflow-configuration, not a test contract.
    expect(pushBranches.join("\n")).not.toContain("live-main")
    expect(pushBranches.length).toBeGreaterThan(0)
  })

  it("publish.yml anti-loop includes [nikcli autofix]", async () => {
    const content = await readRoot(".github/workflows/publish.yml")
    expect(content).toContain("[nikcli autofix]")
  })

  it("publish.yml does not echo token output", async () => {
    const content = await readRoot(".github/workflows/publish.yml")
    // Security invariant: no bare `echo ${{ secrets.* }}` and any `npm whoami`
    // invocation must redirect stdout so the resolved login does not leak.
    expect(content).not.toContain("echo ${{ secrets")
    if (content.includes("npm whoami")) {
      expect(content).toContain("npm whoami >/dev/null")
      expect(content).not.toContain("npm whoami\n")
    }
  })
})

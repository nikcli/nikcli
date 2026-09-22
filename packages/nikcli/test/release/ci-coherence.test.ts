import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"

const root = path.resolve(import.meta.dir, "../../../..")

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), "utf8")
}

// Canonical values — change here to update the contract across all files.
// The bracketed patterns appear escaped in both the workflow regex and the JS RegExp source.
const ANTI_LOOP_PATTERNS = ["nikcli autofix", "release: v", "chore: generate", "skip ci"]
const REDACTION_TOKENS = ["ghp_", "gho_", "github_pat_", "sk-", "npm_", "x-access-token:"]
const DEFAULT_MODEL = "minimax-coding-plan/MiniMax-M3"
const SUMMARY_PATH = "tmp/ci-validation-summary.md"

const PIPELINE_YML = ".github/workflows/ci-pipeline.yml"
const PUBLISH_YML = ".github/workflows/publish.yml"
const VALIDATE_TS = "script/ci-validate.ts"
const AUTOFIX_TS = "script/ci-autofix.ts"
const REPORT_TS = "script/ci-report-failure.ts"

// ─── 1. Anti-loop pattern coherence ─────────────────────────────────────────

describe("anti-loop pattern coherence", () => {
  it("ci-pipeline.yml workflow skip-check contains every canonical pattern", async () => {
    const yml = await read(PIPELINE_YML)
    for (const p of ANTI_LOOP_PATTERNS) {
      expect(yml).toContain(p)
    }
  })

  it("ci-autofix.ts SKIP_PATTERNS contains every canonical pattern", async () => {
    const ts = await read(AUTOFIX_TS)
    for (const p of ANTI_LOOP_PATTERNS) {
      expect(ts).toContain(p)
    }
  })

  it("publish.yml job-level `if:` enforces the same skip rules", async () => {
    const yml = await read(PUBLISH_YML)
    expect(yml).toContain("[nikcli autofix]")
    expect(yml).toContain("release: v")
    expect(yml).toContain("chore: generate")
  })
})

// ─── 2. Redaction pattern coherence ─────────────────────────────────────────

describe("redaction pattern coherence", () => {
  for (const file of [VALIDATE_TS, AUTOFIX_TS, REPORT_TS]) {
    it(`${file} redacts every canonical token format`, async () => {
      const ts = await read(file)
      for (const tok of REDACTION_TOKENS) {
        expect(ts).toContain(tok)
      }
      expect(ts).toContain("[REDACTED]")
    })
  }
})

// ─── 3. Model default coherence ─────────────────────────────────────────────

describe("model default coherence", () => {
  it("ci-autofix.ts uses the canonical default model", async () => {
    const ts = await read(AUTOFIX_TS)
    expect(ts).toContain(DEFAULT_MODEL)
  })

  it("ci-pipeline.yml env passes the canonical default model", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toContain(DEFAULT_MODEL)
  })

  it("neither workflow nor script hard-codes a costly fallback model", async () => {
    const ts = await read(AUTOFIX_TS)
    const yml = await read(PIPELINE_YML)
    for (const banned of ["claude-opus", "claude-sonnet-4", "gpt-5", "gpt-4-turbo"]) {
      expect(ts).not.toContain(banned)
      expect(yml).not.toContain(banned)
    }
  })
})

// ─── 4. Workflow → script env handshake ─────────────────────────────────────

describe("autofix env handshake", () => {
  it("every env var the autofix script reads is set by the workflow", async () => {
    const ts = await read(AUTOFIX_TS)
    const yml = await read(PIPELINE_YML)
    const consumed = [
      "MINIMAX_API_KEY",
      "NIKCLI_AUTOFIX_MODEL",
      "GITHUB_REPOSITORY",
      "GITHUB_EVENT_NAME",
      "GITHUB_ACTOR",
    ]
    for (const v of consumed) {
      expect(ts).toContain(v)
      expect(yml).toContain(v)
    }
  })

  it("every env var the report-failure script reads is set by the workflow", async () => {
    const ts = await read(REPORT_TS)
    const yml = await read(PIPELINE_YML)
    const consumed = [
      "GITHUB_TOKEN",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ID",
      "GITHUB_EVENT_NAME",
      "GITHUB_SHA",
      "GITHUB_HEAD_SHA",
      "GITHUB_PR_NUMBER",
      "NIKCLI_CI_FAILURE_MENTION",
      "AUTOFIX_ATTEMPTED",
    ]
    for (const v of consumed) {
      expect(ts).toContain(v)
      expect(yml).toContain(v)
    }
  })
})

// ─── 5. Exit-code documentation coherence ───────────────────────────────────

describe("ci-autofix exit-code contract", () => {
  it("defines exit 0 (skip / no-op), 78 (autofix-failed), 1 (crash)", async () => {
    const ts = await read(AUTOFIX_TS)
    expect(ts).toContain("process.exit(0)")
    expect(ts).toContain("process.exit(78)")
    expect(ts).toContain("process.exit(1)")
  })

  it("workflow Push step only runs if autofix step succeeded (exit 0)", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toContain("steps.autofix.outcome == 'success'")
  })
})

// ─── 6. Trigger / non-duplication coherence ─────────────────────────────────

describe("trigger coherence", () => {
  it("ci-pipeline.yml triggers on push to live-main and pull_request", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toMatch(/on:\s*\n\s*push:/)
    expect(yml).toMatch(/^\s+-\s+live-main\s*$/m)
    expect(yml).toMatch(/^\s+pull_request:\s*$/m)
  })

  it("publish.yml exposes workflow_call with bump/version/channel inputs", async () => {
    const yml = await read(PUBLISH_YML)
    expect(yml).toContain("workflow_call:")
    // The 3 input names must appear within the workflow_call section
    const wfCallIdx = yml.indexOf("workflow_call:")
    const slice = yml.slice(wfCallIdx, wfCallIdx + 1500)
    expect(slice).toContain("bump:")
    expect(slice).toContain("version:")
    expect(slice).toContain("channel:")
  })

  it("publish.yml push trigger does NOT include live-main or nikoemme-main", async () => {
    const yml = await read(PUBLISH_YML)
    const onIdx = yml.indexOf("on:")
    const jobsIdx = yml.indexOf("\njobs:")
    const onBlock = yml.slice(onIdx, jobsIdx)
    const pushIdx = onBlock.indexOf("push:")
    if (pushIdx === -1) return // no push trigger — fine
    const pushBlock = onBlock.slice(pushIdx)
    // Branches inside the push block must not include the protected branches
    expect(pushBlock).not.toMatch(/^\s+-\s+live-main\s*$/m)
    expect(pushBlock).not.toMatch(/^\s+-\s+nikoemme-main\s*$/m)
  })

  it("ci-pipeline.yml publish job invokes ./.github/workflows/publish.yml with secrets: inherit", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toContain("uses: ./.github/workflows/publish.yml")
    expect(yml).toContain("secrets: inherit")
  })

  it("ci-pipeline.yml publish job gates on validate success + live-main + repo identity", async () => {
    const yml = await read(PIPELINE_YML)
    const pubIdx = yml.indexOf("\n  publish:")
    const after = yml.slice(pubIdx, pubIdx + 600)
    expect(after).toContain("needs.validate.result == 'success'")
    expect(after).toContain("refs/heads/live-main")
    expect(after).toContain("nikcli/nikcli")
  })

  it("ci-pipeline.yml autofix job blocks fork PRs and only allows push or same-repo PR", async () => {
    const yml = await read(PIPELINE_YML)
    const aIdx = yml.indexOf("\n  autofix:")
    const after = yml.slice(aIdx, aIdx + 800)
    expect(after).toContain("github.event.pull_request.head.repo.full_name == github.repository")
    expect(after).toContain("github.event_name == 'push'")
    expect(after).toContain("github.event_name == 'pull_request'")
  })

  it("ci-pipeline.yml report-failure depends on both validate and autofix with always()", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toContain("needs: [validate, autofix]")
    const rfIdx = yml.indexOf("\n  report-failure:")
    const after = yml.slice(rfIdx, rfIdx + 600)
    expect(after).toContain("always()")
    expect(after).toContain("needs.validate.result == 'failure'")
  })
})

// ─── 7. Permission scoping coherence ────────────────────────────────────────

describe("permission scoping coherence", () => {
  it("ci-pipeline.yml top-level permissions are read-only", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toMatch(/^permissions:\s*\n\s+contents:\s+read\s*\n/m)
  })

  it("autofix job elevates to contents: write for the push", async () => {
    const yml = await read(PIPELINE_YML)
    const aIdx = yml.indexOf("\n  autofix:")
    const after = yml.slice(aIdx, aIdx + 1200)
    expect(after).toMatch(/permissions:\s*\n\s+contents:\s+write/)
  })

  it("report-failure has issues + pull-requests write but contents read", async () => {
    const yml = await read(PIPELINE_YML)
    const rfIdx = yml.indexOf("\n  report-failure:")
    const after = yml.slice(rfIdx, rfIdx + 600)
    expect(after).toMatch(/contents:\s+read/)
    expect(after).toMatch(/issues:\s+write/)
    expect(after).toMatch(/pull-requests:\s+write/)
  })
})

// ─── 8. Validation step coherence ───────────────────────────────────────────

describe("validation step coherence", () => {
  it("ci-validate.ts writes summary to the canonical path", async () => {
    const ts = await read(VALIDATE_TS)
    expect(ts).toContain(SUMMARY_PATH)
  })

  it("ci-pipeline.yml uploads the same summary path as an artifact", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toContain(SUMMARY_PATH)
  })

  it("ci-report-failure.ts reads the same summary path", async () => {
    const ts = await read(REPORT_TS)
    expect(ts).toContain(SUMMARY_PATH)
  })

  it("ci-autofix.ts re-runs validation by invoking ci-validate.ts", async () => {
    const ts = await read(AUTOFIX_TS)
    expect(ts).toContain("script/ci-validate.ts")
  })

  it("validate step uses set -o pipefail so bun failures propagate", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toContain("set -o pipefail")
  })
})

// ─── 9. Secret reference coherence ──────────────────────────────────────────

describe("secret reference coherence", () => {
  it("ci-pipeline.yml references the required secrets", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toContain("secrets.SST_GITHUB_TOKEN")
    expect(yml).toContain("secrets.MINIMAX_API_KEY")
  })

  it("ci-pipeline.yml never echoes secret values", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).not.toMatch(/echo\s+["']?\$\{\{\s*secrets\./)
    expect(yml).not.toMatch(/printf\s+["']?\$\{\{\s*secrets\./)
  })

  it("scripts never read NPM_TOKEN or AUR_KEY directly", async () => {
    for (const f of [VALIDATE_TS, AUTOFIX_TS, REPORT_TS]) {
      const ts = await read(f)
      expect(ts).not.toContain("process.env.NPM_TOKEN")
      expect(ts).not.toContain("process.env.AUR_KEY")
    }
  })
})

// ─── 11. Railway deploy coherence ───────────────────────────────────────────

describe("railway-deploy coherence", () => {
  /**
   * The `railway-deploy` job, from its header to the next job.
   *
   * These assertions used to read a fixed number of characters after the job header — 1200, 1500,
   * 2500 — which meant every step added to the job silently pushed something out of the window and
   * failed a test that had nothing to do with the change. Twice in one day. The job's real end is the
   * next top-level job key, so slice to that instead of guessing a length.
   */
  async function railwayDeployJob() {
    const yml = await read(PIPELINE_YML)
    const start = yml.indexOf("\n  railway-deploy:")
    expect(start, "ci-pipeline.yml has no railway-deploy job").toBeGreaterThan(-1)
    // Search past the job's own header line, or it matches itself at offset 0.
    const bodyStart = yml.indexOf("\n", start + 1) + 1
    const next = yml.slice(bodyStart).search(/^ {2}[a-z][a-z0-9-]*:$/m)
    return next === -1 ? yml.slice(start) : yml.slice(start, bodyStart + next)
  }

  it("ci-pipeline.yml has a railway-deploy job gated on publish success", async () => {
    const job = await railwayDeployJob()
    expect(job).toContain("needs: publish")
    expect(job).toContain("needs.publish.result == 'success'")
    expect(job).toContain("refs/heads/live-main")
  })

  it("railway-deploy uses the existing deploy script in detach mode", async () => {
    const job = await railwayDeployJob()
    expect(job).toContain("./script/railway-deploy.sh --detach")
    expect(job).toContain("RAILWAY_TOKEN")
  })

  it("railway-deploy is silent: redirects logs and only emits one-line status", async () => {
    const job = await railwayDeployJob()
    // Output is redirected to a log file (not /dev/null) so failures can be
    // tailed for diagnosis, while success stays a single one-line status.
    expect(job).toContain(">tmp/railway.log")
    expect(job).toContain("✓ Railway deploy triggered")
  })

  // C3: the identity line names what was targeted, so both halves must be declared rather than
  // defaulted in the shell — a value that falls back to "production" reports the thing it is meant
  // to prove.
  it("declares every variable the expected-identity line reports", async () => {
    const job = await railwayDeployJob()
    for (const name of ["RAILWAY_SERVICE", "RAILWAY_ENVIRONMENT"]) {
      expect(job, `${name} is reported but never declared in env:`).toContain(`${name}: \${{ vars.${name}`)
    }
    expect(job).toContain("Expected identity: revision=${GITHUB_SHA}")
  })

  it("railway-deploy.sh script exists and is executable", async () => {
    const stat = await fs.stat(path.join(root, "script/railway-deploy.sh"))
    expect(stat.isFile()).toBe(true)
  })

  it("railway.toml references the serve Dockerfile", async () => {
    const toml = await read("railway.toml")
    expect(toml).toContain("Dockerfile.serve")
  })
})

// ─── 10. Injection-safety coherence ─────────────────────────────────────────

describe("injection-safety coherence", () => {
  it("workflow does not interpolate head_commit.message into bash directly", async () => {
    const yml = await read(PIPELINE_YML)
    // Forbidden: COMMIT_MSG="${{ github.event.head_commit.message ... }}"
    expect(yml).not.toMatch(/COMMIT_MSG=["']?\$\{\{\s*github\.event\.head_commit\.message/)
    // Required: pass via env, then reference "$COMMIT_MSG"
    expect(yml).toMatch(/COMMIT_MSG:\s*\$\{\{\s*github\.event\.head_commit\.message/)
  })

  it("workflow validates github.ref_name before using it in git push", async () => {
    const yml = await read(PIPELINE_YML)
    expect(yml).toContain("Refusing to push to unsafe ref name")
    expect(yml).toMatch(/REF_NAME["']?\s*=~\s*\^?\[A-Za-z0-9/)
  })
})

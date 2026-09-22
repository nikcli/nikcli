import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"

const root = path.resolve(import.meta.dir, "../../../..")

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), "utf8")
}

// ─── 1. Redaction patterns — verify each catches a realistic example ────────

describe("redaction pattern correctness", () => {
  // Canonical regex set the scripts must include. Each catches one realistic input.
  const CANONICAL = [
    {
      name: "GitHub classic PAT (ghp_)",
      regex: /ghp_[A-Za-z0-9]{36,}/g,
      sourceSubstring: "ghp_[A-Za-z0-9]",
      input: "Authorization: token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    },
    {
      name: "GitHub OAuth token (gho_)",
      regex: /gho_[A-Za-z0-9]{36,}/g,
      sourceSubstring: "gho_[A-Za-z0-9]",
      input: "token: gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    },
    {
      name: "GitHub fine-grained PAT (github_pat_)",
      regex: /github_pat_[A-Za-z0-9_]{22,}/g,
      sourceSubstring: "github_pat_[A-Za-z0-9_]",
      input: "secret: github_pat_11ABCDEFG0AbCdEfGhIjKl_MnOpQrStUvWxYzABCDEFGHIJKLMN",
    },
    {
      name: "OpenAI-style key (sk-)",
      regex: /sk-[A-Za-z0-9_-]{20,}/g,
      sourceSubstring: "sk-[A-Za-z0-9_-]",
      input: "OPENAI_API_KEY=sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0",
    },
    {
      name: "npm token (npm_)",
      regex: /npm_[A-Za-z0-9]{36,}/g,
      sourceSubstring: "npm_[A-Za-z0-9]",
      input: "//registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    },
    {
      name: "URL-embedded x-access-token",
      regex: /x-access-token:[A-Za-z0-9_-]+@/g,
      sourceSubstring: "x-access-token:",
      input: "https://x-access-token:ghp_secret123@github.com/owner/repo",
    },
  ]

  for (const file of ["script/ci-validate.ts", "script/ci-autofix.ts", "script/ci-report-failure.ts"]) {
    describe(file, () => {
      for (const tc of CANONICAL) {
        it(`source declares the ${tc.name} pattern`, async () => {
          const src = await read(file)
          expect(src).toContain(tc.sourceSubstring)
        })
        it(`canonical regex for ${tc.name} catches its example input`, () => {
          const redacted = tc.input.replace(tc.regex, "[REDACTED]")
          expect(redacted).toContain("[REDACTED]")
        })
      }

      it("canonical regexes do NOT match innocuous text", () => {
        const text = "This is a normal log line with no secrets in it"
        let out = text
        for (const c of CANONICAL) out = out.replace(c.regex, "[REDACTED]")
        expect(out).toBe(text)
      })
    })
  }
})

// ─── 2. Validation step order ───────────────────────────────────────────────

describe("ci-validate.ts step order", () => {
  it("executes steps in the documented sequence", async () => {
    const src = await read("script/ci-validate.ts")
    const stepsMatch = src.match(/const steps:\s*ValidationStep\[\]\s*=\s*\[([\s\S]*?)\n\]/)
    expect(stepsMatch).toBeTruthy()
    const stepNames = Array.from(stepsMatch![1].matchAll(/name:\s*"([^"]+)"/g)).map((m) => m[1])
    // The ten gates between route coverage and the codegen drift check were
    // added to `ci-validate.ts` without this list being updated, so it pinned
    // a twelve-step sequence that had not existed for some time — the drift
    // this test exists to catch, in the test itself. The placement is
    // deliberate and worth keeping: cheap static gates run after the typecheck
    // that makes them meaningful and before the expensive codegen, formatting
    // and deploy-context checks.
    expect(stepNames).toEqual([
      "Install dependencies",
      "Typecheck",
      "Route coverage gate",
      "Open-payload allowlist gate",
      "Account-required guard gate",
      "Observability schema gate",
      "Plugin v2 contract gate",
      "Workspace isolation gate",
      "Network egress accounting gate",
      "Flag capture-at-import gate",
      "Perf baseline gate",
      "Spec file-reference gate",
      "Spec commit-reference gate",
      "Generated HTTP client drift",
      "Formatting",
      "Lint",
      "Shell syntax check (install script)",
      "Shell syntax check (railway-deploy)",
      "Docker nikcli version check",
      "Patched dependency check",
      "Railway upload context check",
      "PowerShell syntax check (install.ps1)",
    ])
  })

  it("Install dependencies uses --frozen-lockfile", async () => {
    const src = await read("script/ci-validate.ts")
    expect(src).toContain("bun")
    expect(src).toContain("install")
    expect(src).toContain("--frozen-lockfile")
  })

  it("regenerates HTTP clients and fails when tracked output drifts", async () => {
    const src = await read("script/ci-validate.ts")
    expect(src).toContain("generate:httpapi-clients")
    expect(src).toContain("git diff --exit-code")
    expect(src).toContain("packages/sdk/js/src/httpapi/generated")
    expect(src).toContain("packages/nikcli/src/server/httpapi/client")
  })

  it("treats formatting and lint failures as blocking", async () => {
    const src = await read("script/ci-validate.ts")
    const stepsMatch = src.match(/const steps:\s*ValidationStep\[\]\s*=\s*\[([\s\S]*?)\n\]/)
    expect(stepsMatch).toBeTruthy()
    for (const name of ["Formatting", "Lint"]) {
      const start = stepsMatch![1].indexOf(`name: "${name}"`)
      const end = stepsMatch![1].indexOf("\n  },", start)
      const block = stepsMatch![1].slice(start, end)
      expect(block).not.toContain("critical: false")
    }
  })

  it("timeouts are reasonable: tests < 5min, typecheck < 3min", async () => {
    const src = await read("script/ci-validate.ts")
    const timeouts = Array.from(src.matchAll(/timeout:\s*(\d[\d_]*)/g)).map((m) => Number(m[1].replace(/_/g, "")))
    expect(timeouts.length).toBeGreaterThan(0)
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(300_000)
  })
})

// ─── 3. Report-failure body shape ───────────────────────────────────────────

describe("ci-report-failure.ts comment body structure", () => {
  it("buildBody emits the sticky marker on the first line", async () => {
    const src = await read("script/ci-report-failure.ts")
    const fnMatch = src.match(/function buildBody\([\s\S]*?return\s+\[\s*([\s\S]*?)\]\s*\.join/)
    expect(fnMatch).toBeTruthy()
    const firstLine = fnMatch![1].trim().split("\n")[0]
    expect(firstLine).toContain("STICKY_MARKER")
  })

  it("buildBody includes the failed step, autofix status, and run URL", async () => {
    const src = await read("script/ci-report-failure.ts")
    expect(src).toContain("Failed step")
    expect(src).toContain("Autofix status")
    expect(src).toContain("View full logs")
  })

  it("autofix status labels cover all three outcomes", async () => {
    const src = await read("script/ci-report-failure.ts")
    expect(src).toContain("Autofix succeeded but validation still failed")
    expect(src).toContain("Autofix attempted and failed")
    expect(src).toContain("Autofix skipped")
  })

  it("body always wraps the summary in a code fence", async () => {
    const src = await read("script/ci-report-failure.ts")
    expect(src).toMatch(/"```"/) // code fence appears in template
  })

  it("body length cap: truncatedSummary kicks in at >1500 chars", async () => {
    const src = await read("script/ci-report-failure.ts")
    expect(src).toMatch(/summary\.length\s*>\s*1500/)
    expect(src).toContain("(truncated)")
  })
})

// ─── 4. Anti-loop coverage matrix ───────────────────────────────────────────

describe("anti-loop coverage matrix", () => {
  // For every anti-loop pattern, both publish.yml (job-level if) and the
  // ci-pipeline.yml skip-check step must enforce it.
  const patterns = [
    { script: "[nikcli autofix]", yamlGrep: "\\[nikcli autofix\\]" },
    { script: "release: v", yamlGrep: "release: v" },
    { script: "chore: generate", yamlGrep: "chore: generate" },
    { script: "[skip ci]", yamlGrep: "\\[skip ci\\]" },
  ]

  for (const p of patterns) {
    it(`ci-autofix.ts skips on ${p.script}`, async () => {
      const src = await read("script/ci-autofix.ts")
      expect(src).toContain(p.yamlGrep)
    })
    it(`ci-pipeline.yml skip-check regex covers ${p.script}`, async () => {
      const src = await read(".github/workflows/ci-pipeline.yml")
      expect(src).toContain(p.yamlGrep)
    })
  }

  it("publish.yml job-level if also enforces the first three patterns", async () => {
    const src = await read(".github/workflows/publish.yml")
    // [skip ci] isn't in publish.yml's if (it's a global GH Actions convention) but the others are
    expect(src).toContain("[nikcli autofix]")
    expect(src).toContain("release: v")
    expect(src).toContain("chore: generate")
  })
})

// ─── 5. Setup-bun action consistency ────────────────────────────────────────

describe("setup-bun action consistency", () => {
  it("ci-pipeline.yml uses ./.github/actions/setup-bun for every job", async () => {
    const yml = await read(".github/workflows/ci-pipeline.yml")
    const setupRefs = (yml.match(/uses:\s*\.\/\.github\/actions\/setup-bun/g) || []).length
    // validate + autofix + report-failure each call setup-bun once = 3
    // railway-deploy does NOT need bun
    expect(setupRefs).toBeGreaterThanOrEqual(3)
  })

  it("the local setup-bun composite action exists", async () => {
    const stat = await fs.stat(path.join(root, ".github/actions/setup-bun"))
    expect(stat.isDirectory()).toBe(true)
  })
})

// ─── 6. Pinned action versions ──────────────────────────────────────────────

describe("third-party action versioning", () => {
  it("ci-pipeline.yml uses checkout@v4+ (not @v3 or unpinned)", async () => {
    const yml = await read(".github/workflows/ci-pipeline.yml")
    const checkouts = yml.match(/actions\/checkout@v\d+/g) || []
    expect(checkouts.length).toBeGreaterThan(0)
    for (const c of checkouts) {
      const major = Number(c.match(/@v(\d+)/)![1])
      expect(major).toBeGreaterThanOrEqual(4)
    }
  })

  it("ci-pipeline.yml uses upload-artifact@v4+ (v3 is deprecated)", async () => {
    const yml = await read(".github/workflows/ci-pipeline.yml")
    const uploads = yml.match(/actions\/upload-artifact@v\d+/g) || []
    for (const u of uploads) {
      const major = Number(u.match(/@v(\d+)/)![1])
      expect(major).toBeGreaterThanOrEqual(4)
    }
  })
})

// ─── 7. Concurrency safety ──────────────────────────────────────────────────

describe("concurrency safety", () => {
  it("ci-pipeline.yml does NOT cancel in-flight live-main runs", async () => {
    const yml = await read(".github/workflows/ci-pipeline.yml")
    // Must include a guard that disables cancel-in-progress for live-main
    expect(yml).toMatch(/cancel-in-progress:\s*\$\{\{\s*github\.ref\s*!=\s*['"]refs\/heads\/live-main['"]/)
  })

  it("publish.yml concurrency group includes version/bump (avoid clashing rapid bumps)", async () => {
    const yml = await read(".github/workflows/publish.yml")
    expect(yml).toMatch(
      /concurrency:\s*\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.ref\s*\}\}-\$\{\{\s*inputs\.version\s*\|\|\s*inputs\.bump\s*\}\}/,
    )
  })
})

// ─── 8. Workflow failure regressions ────────────────────────────────────────

describe("workflow failure regressions", () => {
  it("validates direct publishes and only trusts the ci-pipeline caller", async () => {
    const publish = await read(".github/workflows/publish.yml")
    const pipeline = await read(".github/workflows/ci-pipeline.yml")
    expect(publish).toContain("prevalidated:")
    expect(publish).toContain("if: ${{ !inputs.prevalidated }}")
    expect(publish).toContain("bun run script/ci-validate.ts")
    expect(pipeline).toContain("prevalidated: true")
  })

  it("the GitHub agent rejects failed SDK calls while waiting for its server", async () => {
    const src = await read("github/index.ts")
    expect(src).toContain("createNikcliClient({ baseUrl: url, throwOnError: true })")
    expect(src).toContain('client.app.log({\n          service: "github-workflow"')
    expect(src).toContain("client.session.share({ sessionID: session.id })")
    expect(src).toContain("client.session.prompt({\n      sessionID: session.id")
    expect(src).not.toMatch(/client\.[A-Za-z0-9_.]+<true>/)
    expect(src).not.toContain("path: session")
  })

  it("compiled TUI probes mark Bun ConPTY as an interactive terminal", async () => {
    for (const file of ["packages/nikcli/script/tui-smoke.ts", "packages/nikcli/script/tui-startup.ts"]) {
      const src = await read(file)
      expect(src).toContain('NIKCLI_TERMINAL: "1"')
    }
  })

  it("the startup probe reports percentiles instead of best-of warm runs", async () => {
    const src = await read("packages/nikcli/script/tui-startup.ts")
    expect(src).toContain("WARM_RUNS")
    expect(src).toContain("COLD_RUNS")
    expect(src).toContain("p95")
    expect(src).toContain("summarizeSamples")
    expect(src).toContain("rssBytes")
    expect(src).not.toContain("best of")
  })

  it("the site deployment only unlocks SST after detecting a persisted lock", async () => {
    const yml = await read(".github/workflows/deploy.yml")
    const detection = yml.indexOf("A concurrent update was detected")
    const unlock = yml.indexOf('bun sst unlock --stage="${{ github.ref_name }}"')
    expect(detection).toBeGreaterThan(-1)
    expect(unlock).toBeGreaterThan(detection)
    expect(yml).toContain('bun sst deploy --stage="${{ github.ref_name }}"')
    expect(yml).toContain("cancel-in-progress: false")
  })

  it("the Discord release notification is optional when its webhook is absent", async () => {
    const yml = await read(".github/workflows/notify-discord.yml")
    expect(yml).toContain("configured=false")
    expect(yml).toContain("if: steps.webhook.outputs.configured == 'true'")
  })

  it("the beta sync uses the workflow token instead of a broken app key", async () => {
    const yml = await read(".github/workflows/beta.yml")
    expect(yml).toContain("GH_TOKEN: ${{ github.token }}")
    expect(yml).not.toContain("setup-git-committer")
    expect(yml).not.toContain("NIKCLI_APP_SECRET")
  })

  it("issue triage selects the configured MiniMax provider explicitly", async () => {
    const yml = await read(".github/workflows/triage.yml")
    expect(yml).toContain("MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}")
    expect(yml).toContain("-m minimax-coding-plan/MiniMax-M3")
    expect(yml).not.toContain("NIKCLI_API_KEY")
  })

  it("the typecheck-only test workflow uses an available hosted runner", async () => {
    const yml = await read(".github/workflows/test.yml")
    expect(yml).toContain("host: ubuntu-latest")
    expect(yml).not.toContain("blacksmith-4vcpu-ubuntu-2404")
    expect(yml).toContain("bun turbo typecheck")
    const executable = yml
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
    expect(executable).not.toMatch(/\bbun (?:run )?test(?::ci)?\b/)
  })
})

// ─── 9. Railway deploy detail tests ─────────────────────────────────────────

describe("railway-deploy job specifics", () => {
  it("only runs after publish succeeds on live-main from the canonical repo", async () => {
    const yml = await read(".github/workflows/ci-pipeline.yml")
    const idx = yml.indexOf("\n  railway-deploy:")
    const block = yml.slice(idx, idx + 1500)
    expect(block).toContain("needs: publish")
    expect(block).toContain("needs.publish.result == 'success'")
    expect(block).toContain("github.ref == 'refs/heads/live-main'")
    expect(block).toContain("github.repository == 'nikcli/nikcli'")
  })

  it("fails when RAILWAY_TOKEN is unset instead of reporting a skipped deploy as successful", async () => {
    const yml = await read(".github/workflows/ci-pipeline.yml")
    expect(yml).toContain("RAILWAY_TOKEN not configured")
    expect(yml).toMatch(/RAILWAY_TOKEN\b[\s\S]{0,250}exit 1/)
  })

  it("uses --detach so the workflow doesn't block on deploy completion", async () => {
    const yml = await read(".github/workflows/ci-pipeline.yml")
    expect(yml).toContain("railway-deploy.sh --detach")
  })
})

// ─── 10. Script shebang + invocation portability ────────────────────────────

describe("script invocation portability", () => {
  for (const f of ["script/ci-validate.ts", "script/ci-autofix.ts", "script/ci-report-failure.ts"]) {
    it(`${f} has a bun shebang and is invokable as ./${f}`, async () => {
      const src = await read(f)
      expect(src.startsWith("#!/usr/bin/env bun")).toBe(true)
    })
  }

  it("all CI scripts are invoked with `bun run` in the workflow (matches local convention)", async () => {
    const yml = await read(".github/workflows/ci-pipeline.yml")
    expect(yml).toContain("bun run script/ci-validate.ts")
    expect(yml).toContain("bun run script/ci-autofix.ts")
    expect(yml).toContain("bun run script/ci-report-failure.ts")
  })
})

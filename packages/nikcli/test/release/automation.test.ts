import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"

const root = path.resolve(import.meta.dir, "../../../..")

async function readRoot(relative: string) {
  return fs.readFile(path.join(root, relative), "utf8")
}

describe("release automation", () => {
  it("parses ADE logo HTML with the formatter used by release generation", async () => {
    const { format } = await import("prettier")
    const source = await readRoot("packages/ade/design/logos/index.html")
    const formatted = await format(source, {
      parser: "html",
      semi: false,
      printWidth: 120,
    })
    expect(formatted).toContain('id="btnWireframe"')
    expect(formatted).toContain('id="btnSnapshot"')
  })

  it("keeps the GitHub comment runner executable and mention filters exact", async () => {
    const action = await readRoot("github/action.yml")
    const command = await readRoot("packages/nikcli/src/cli/handlers/github/install.ts")

    expect(action).toContain('bun "$GITHUB_ACTION_PATH/index.ts"')
    expect(action).not.toContain("nikcli github run")
    expect(command).toContain("github.event.comment.body == '/nik'")
    expect(command).toContain("github.event.comment.body == '/nikcli'")
    expect(command).toContain("github.event.comment.author_association")
  })

  it("publishes production releases automatically from live-main", async () => {
    const workflow = await readRoot(".github/workflows/publish.yml")

    expect(workflow).toContain("workflow_call:")
    expect(workflow).toContain("./script/publish-start.ts")
    expect(workflow).toContain("!startsWith(github.event.head_commit.message, 'release: v')")
    expect(workflow).toContain("!startsWith(github.event.head_commit.message, 'chore: generate')")
    expect(workflow).toContain("[nikcli autofix]")
  })

  it("runs validation CI on live-main without self-mutating release loops", async () => {
    const testWorkflow = await readRoot(".github/workflows/test.yml")
    const typecheckWorkflow = await readRoot(".github/workflows/typecheck.yml")
    const generateWorkflow = await readRoot(".github/workflows/generate.yml")
    const publishWorkflow = await readRoot(".github/workflows/publish.yml")

    expect(testWorkflow).toContain("- live-main")
    expect(typecheckWorkflow).toContain("- live-main")
    expect(typecheckWorkflow).toContain("branches: [live-main]")
    expect(generateWorkflow).toContain("- live-main")
    expect(generateWorkflow).toContain("group: generate-${{ github.ref }}")
    expect(generateWorkflow).toContain("if: github.ref_name != 'live-main'")
    expect(generateWorkflow).toContain("Verify live-main generated output")
    expect(publishWorkflow).toContain("./script/generate.ts")
  })

  it("keeps non-critical scheduled automations from making CI noisy", async () => {
    const docsWorkflow = await readRoot(".github/workflows/docs-update.yml")
    const statsWorkflow = await readRoot(".github/workflows/stats.yml")
    const nixWorkflow = await readRoot(".github/workflows/update-nix-hashes.yml")

    expect(docsWorkflow).toContain("continue-on-error: true")
    expect(docsWorkflow).toContain("src/index.ts run")
    expect(docsWorkflow).toContain("MINIMAX_API_KEY")
    expect(statsWorkflow).toContain("continue-on-error: true")
    expect(statsWorkflow).toContain("oven-sh/setup-bun@v2")
    expect(statsWorkflow).toContain("git pull --rebase --autostash")
    expect(nixWorkflow).toContain("continue-on-error: ${{ github.event_name != 'workflow_dispatch' }}")
    expect(nixWorkflow).toContain("timeout-minutes: 45")
  })

  it("keeps the automatic GitHub release path single-sourced", async () => {
    const createRelease = await readRoot(".github/workflows/nikcli-create-release.yml")
    const publishStart = await readRoot("script/publish-start.ts")

    expect(publishStart).toContain("gh release create v${Script.version}")
    expect(createRelease).toContain("workflow_dispatch:")
    expect(createRelease).not.toContain("tags:")
    expect(createRelease).not.toContain("- live-main")
  })

  it("builds release archives without platform metadata", async () => {
    const publishScript = await readRoot("packages/nikcli/script/publish.ts")
    const githubScript = await readRoot("script/release-github.ts")
    const manualWorkflow = await readRoot(".github/workflows/nikcli-create-release.yml")

    for (const source of [publishScript, githubScript, manualWorkflow]) {
      expect(source).toContain("COPYFILE_DISABLE")
      expect(source).toContain("--no-xattrs")
      expect(source).toContain("--exclude='._*'")
      expect(source).toContain("--exclude='.DS_Store'")
      expect(source).toContain("zip -X")
      expect(source).toContain("'*/._*'")
      expect(source).toContain("'*/.DS_Store'")
    }
  })

  it("uses v-prefixed release tags for installer downloads", async () => {
    const installer = await readRoot("install")

    expect(installer).toContain('release_tag="v${requested_version}"')
    // The download URL is assembled in two halves: the base is pinned to the
    // v-prefixed tag at resolution time, and `$filename` is appended at the
    // download site, once the baseline/musl target has been picked.
    expect(installer).toContain("releases/download/${release_tag}")
    expect(installer).toContain('"$release_url_primary/$filename"')
    expect(installer).toContain('"$release_url_fallback/$filename"')
    expect(installer).toContain("releases/tag/${release_tag}")
    expect(installer).not.toContain("releases/download/${requested_version}")
  })

  it("serves the same installer scripts the repo root holds", async () => {
    // The web package ships its own copies (Astro imports `../../install`, and
    // `public/` is the static fallback). They silently drifted once already —
    // `packages/web/install` stayed on a version that predated the Windows fixes.
    const pairs = [
      ["install", "packages/web/install"],
      ["install", "packages/web/public/install.sh"],
      ["install.ps1", "packages/web/install.ps1"],
      ["install.ps1", "packages/web/public/install.ps1"],
    ] as const

    for (const [source, copy] of pairs) {
      expect(await readRoot(copy)).toBe(await readRoot(source))
    }
  })

  it("resolves Windows release assets with the .exe suffix", async () => {
    const installer = await readRoot("install")
    const ps1 = await readRoot("install.ps1")

    // Bun's --compile emits nikcli.exe on Windows targets, so an installer that
    // looks for a bare `nikcli` inside the archive can never succeed there.
    expect(installer).toContain('BIN_NAME="$APP.exe"')
    expect(installer).toContain('mv "$extracted_binary" "$INSTALL_DIR/$BIN_NAME"')
    expect(installer).toContain("windows-x64|windows-arm64")
    expect(ps1).toContain('Filter "$App.exe"')

    // AVX2 must be probed on Windows too: the non-baseline build crashes with an
    // illegal instruction on CPUs without it.
    expect(installer).toContain("IsProcessorFeaturePresent(40)")
    expect(ps1).toContain("IsProcessorFeaturePresent(40)")
  })

  it("defers replacement when Windows locks the running executable", async () => {
    const ps1 = await readRoot("install.ps1")

    expect(ps1).toContain("NIKCLI_UPGRADE_PID")
    expect(ps1).toContain("Wait-Process -Id $upgradePid")
    expect(ps1).toContain("Move-Item -LiteralPath '$quotedPending'")
    expect(ps1).toContain("Start-Process -FilePath $powershellExe")

    // A staged binary the swap process never picked up must not be left behind.
    expect(ps1).toContain('Filter "$App.update.*.exe"')

    // Real Windows coverage: a plain parse cannot catch a swap that never runs.
    const workflow = await readRoot(".github/workflows/windows-compat.yml")
    expect(workflow).toContain("defers the swap when the target exe is locked")
    expect(workflow).toContain("$env:NIKCLI_UPGRADE_PID = $running.Id")
  })

  it("clears leaked mouse reporting before the upgrade command prints", async () => {
    // An older build could exit leaving mouse tracking on, which turns every
    // mouse move during `nikcli upgrade` into escape-sequence noise.
    const command = await readRoot("packages/nikcli/src/cli/handlers/upgrade.ts")

    expect(command).toContain("TERMINAL_RESET_SEQUENCE")
    expect(command).toContain("process.stdout.isTTY")
  })

  it("publishes the per-platform binary packages the npm wrapper depends on", async () => {
    const publishScript = await readRoot("packages/nikcli/script/publish.ts")

    // These are the wrapper's optionalDependencies. Skipping them publishes a
    // wrapper pointing at versions that do not exist on npm, which is what broke
    // `npm i -g nikcli-ai` on every platform between 1.15.0 and 1.210.0.
    expect(publishScript).not.toContain("isPublishable")
    expect(publishScript).toContain("optionalDependencies: binaries")
  })

  it("does not bypass release safety checks or expose token output", async () => {
    const workflow = await readRoot(".github/workflows/publish.yml")
    const publishStart = await readRoot("script/publish-start.ts")

    expect(workflow).not.toContain("npm whoami >/dev/null")
    expect(publishStart).not.toContain("--force")
    expect(publishStart).not.toContain("--no-verify")
    expect(publishStart).not.toContain("--tags")
    expect(publishStart).toContain("git add -A")
    expect(publishStart).toContain("git fetch origin ${branch}")
    // The release script pushes the branch (with a rebase-and-retry loop for
    // non-fast-forward races) and the tag as two separate pushes.
    expect(publishStart).toContain("git push origin HEAD:${branch}")
    expect(publishStart).toContain("git tag v${Script.version}")
    expect(publishStart).toContain("git push origin v${Script.version}")
  })

  it("publishes homebrew formula to the correct tap repository with proper checksums", async () => {
    const registriesScript = await readRoot("packages/nikcli/script/publish-registries.ts")

    // Must push to nikomatt69/homebrew-tap (not sst/homebrew-tap)
    expect(registriesScript).toContain("nikomatt69/homebrew-tap")

    // Must compute SHA256 checksums for each platform
    expect(registriesScript).toContain("sha256")

    // Must reference the correct GitHub release URLs
    expect(registriesScript).toContain("github.com/nikomatt69/nikcli/releases/download")

    // Must cover all four platform combos
    expect(registriesScript).toContain("darwin-x64")
    expect(registriesScript).toContain("darwin-arm64")
    expect(registriesScript).toContain("linux-x64")
    expect(registriesScript).toContain("linux-arm64")

    // Must use the correct archive naming convention (zip for macOS, tar.gz for Linux)
    expect(registriesScript).toContain("darwin-arm64.zip")
    expect(registriesScript).toContain("darwin-x64.zip")
    expect(registriesScript).toContain("linux-x64.tar.gz")
    expect(registriesScript).toContain("linux-arm64.tar.gz")

    // Must commit with a version-tagged message
    expect(registriesScript).toContain("nikcli v${Script.version}")

    // Must NOT reference the old sst org
    expect(registriesScript).not.toContain("sst/homebrew-tap")
  })

  it("publish-complete downloads release archives before updating registries", async () => {
    const completeScript = await readRoot("script/publish-complete.ts")

    // Must download archives from the GitHub release
    expect(completeScript).toContain("gh release download")

    // Must download the archive patterns needed for the homebrew formula
    expect(completeScript).toContain("nikcli-ai-linux")
    expect(completeScript).toContain("nikcli-ai-darwin")

    // Must import the registries script
    expect(completeScript).toContain("publish-registries")
  })
})

describe("ADE release integration", () => {
  it("attaches ADE to the validated nikcli release from live-main", async () => {
    const pipeline = await readRoot(".github/workflows/ci-pipeline.yml")
    const ade = pipeline.match(/^  ade:\n[\s\S]*?(?=^  \S)/m)?.[0]
    expect(ade).toBeDefined()
    expect(ade).toContain("needs: publish")
    expect(ade).toContain("needs.publish.result == 'success'")
    expect(ade).toContain("github.event_name == 'push'")
    expect(ade).toContain("github.ref == 'refs/heads/live-main'")
    expect(ade).toContain("github.repository == 'nikomatt69/nikcli'")
    expect(ade).toContain("uses: ./.github/workflows/ade-release.yml")
    expect(ade).toContain("tag: ${{ needs.publish.outputs.tag }}")
    expect(ade).toContain("attach_only: true")
    expect(ade).toContain("contents: write")
    expect(ade).toContain("secrets: inherit")
  })

  it("builds all six desktop targets and gates native builds on ADE checks", async () => {
    const [ade, desktop, checks] = await Promise.all([
      readRoot(".github/workflows/ade-release.yml"),
      readRoot(".github/workflows/desktop-release.yml"),
      readRoot(".github/workflows/ade-checks.yml"),
    ])
    const targets = (source: string) => [...source.matchAll(/^\s+target: (\S+)$/gm)].map((x) => x[1]).sort()
    expect(targets(ade)).toHaveLength(6)
    expect(targets(ade)).toEqual(targets(desktop))
    expect(ade).toContain("needs: [draft, checks]")
    expect(ade).toContain("uses: ./.github/workflows/ade-checks.yml")
    expect(ade).toContain("ref: ${{ inputs.tag || github.ref_name }}")
    expect(ade).toContain("(github.repository == 'nikomatt69/nikcli' && inputs.attach_only)")
    expect(checks).toContain("(github.repository == 'nikomatt69/nikcli' && inputs.ref != '')")
    expect(checks).toContain("ADE typecheck")
    expect(checks).toContain("ADE tests")
    expect(checks).toContain("Voice typecheck")
    expect(checks).toContain("Voice tests")
    expect(ade).not.toContain("continue-on-error:")
    expect(ade).toContain('echo "no bundles produced for ${{ matrix.target }}"\n            exit 1')
  })

  it("does not republish nikcli or overwrite its updater manifest", async () => {
    const ade = await readRoot(".github/workflows/ade-release.yml")
    expect(ade).toContain("- name: Verify existing nikcli release\n        if: inputs.attach_only")
    expect(ade).toContain("- name: Create draft release\n        if: ${{ !inputs.attach_only }}")
    expect(ade).toContain("  publish:\n    needs: build\n    if: ${{ !inputs.attach_only }}")
    expect(ade).toContain(
      'if [ "$ATTACH_ONLY" = "true" ]; then\n            # These are downloadable installers, not an ADE updater release.\n            UPDATER=false',
    )
    expect(ade).toContain('elif [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then')
    expect(ade).toContain('if [ "$ATTACH_ONLY" != "true" ]; then\n                cp "$BUNDLE/macos/ADE.app.tar.gz"')
    expect(ade).toContain('entry windows-aarch64 "ADE_${VERSION}_arm64-setup.exe"')
    expect(ade).toContain('gh release upload "$TAG" --clobber --repo "$GITHUB_REPOSITORY"')
  })

  it("accepts only the correct version tag for each release mode", async () => {
    const ade = await readRoot(".github/workflows/ade-release.yml")
    const script = ade.match(
      /          PREFIX="ade-v"\n[\s\S]*?          echo "version=\$VERSION" >> "\$GITHUB_OUTPUT"/,
    )?.[0]
    expect(script).toBeDefined()
    for (const [tag, attach, valid] of [
      ["v1.367.0", "true", true],
      ["ade-v1.2.3", "false", true],
      ["ade-v1.2.3", "true", false],
      ["v1.367.0", "false", false],
      ["1.2.3", "true", false],
      ["v1.2.3;exit 0", "true", false],
    ] as const) {
      const result = Bun.spawn(["bash", "-c", script!], {
        env: {
          ...process.env,
          TAG: tag,
          ATTACH_ONLY: attach,
          GITHUB_OUTPUT: "/dev/null",
        },
        stdout: "ignore",
        stderr: "ignore",
      })
      expect(await result.exited).toBe(valid ? 0 : 1)
    }
  })
})

describe("CI pipeline", () => {
  it("has the ci-pipeline orchestrator with validate, publish, autofix, and report-failure jobs", async () => {
    const pipeline = await readRoot(".github/workflows/ci-pipeline.yml")

    expect(pipeline).toContain("name: ci-pipeline")
    expect(pipeline).toContain("validate")
    expect(pipeline).toContain("publish")
    expect(pipeline).toContain("autofix")
    expect(pipeline).toContain("report-failure")
  })

  it("gates publish behind validate on live-main only", async () => {
    const pipeline = await readRoot(".github/workflows/ci-pipeline.yml")

    expect(pipeline).toContain("needs: validate")
    expect(pipeline).toContain("needs.validate.result == 'success'")
    expect(pipeline).toContain("refs/heads/live-main")
    expect(pipeline).toContain("nikomatt69/nikcli")
    expect(pipeline).toContain("secrets: inherit")
    expect(pipeline).toContain("!startsWith(github.event.head_commit.message, 'release: v')")
    expect(pipeline).toContain("!startsWith(github.event.head_commit.message, 'chore: generate')")
    expect(pipeline).toContain("!startsWith(github.event.head_commit.message, 'chore: update')")
    expect(pipeline).toContain("[nikcli autofix]")
  })

  it("autofix only runs on trusted contexts and skips bot/release/generated commits", async () => {
    const pipeline = await readRoot(".github/workflows/ci-pipeline.yml")

    expect(pipeline).toContain("needs.validate.result == 'failure'")
    expect(pipeline).toContain("github-actions[bot]")
    expect(pipeline).toContain("[nikcli autofix]")
    expect(pipeline).toContain("release: v")
    expect(pipeline).toContain("chore: generate")
  })

  it("publish.yml exposes workflow_call and does not publish on live-main push directly", async () => {
    const publish = await readRoot(".github/workflows/publish.yml")

    // Must have workflow_call for ci-pipeline to invoke it
    expect(publish).toContain("workflow_call:")

    // Must accept bump, version, and channel inputs via workflow_call
    expect(publish).toContain("bump:")
    expect(publish).toContain("version:")
    expect(publish).toContain("channel:")

    // Must NOT have live-main as a push trigger (only dev and snapshot-* remain)
    // Check that the push branches section does not contain live-main by extracting it
    const pushMatch = publish.match(/on:[\s\S]*?push:[\s\S]*?branches:[\s\S]*?(?=\n\s{0,2}\S|\n\s{0,2}workflow)/)
    if (pushMatch) {
      const pushBlock = pushMatch[0]
      // live-main should NOT appear in the push branches block
      const liveMainInPush = pushBlock.includes("live-main")
      expect(liveMainInPush).toBe(false)
    }
  })

  it("report-failure uses sticky marker and configurable mention, not raw logs", async () => {
    const pipeline = await readRoot(".github/workflows/ci-pipeline.yml")
    const script = await readRoot("script/ci-report-failure.ts")

    // Pipeline passes the mention env var
    expect(pipeline).toContain("NIKCLI_CI_FAILURE_MENTION")
    expect(pipeline).toContain("AUTOFIX_ATTEMPTED")

    // Script uses sticky marker for idempotent comments
    expect(script).toContain("<!-- nikcli-ci-autofix -->")

    // Script redacts tokens
    expect(script).toContain("[REDACTED]")

    // Script does NOT dump full env
    expect(script).not.toContain("process.env.NPM_TOKEN")
    expect(script).not.toContain("process.env.SST_GITHUB_TOKEN")

    // Pipeline does not print npm whoami output
    expect(pipeline).not.toContain("npm whoami\n")
  })

  it("ci-validate redacts token patterns from summaries", async () => {
    const script = await readRoot("script/ci-validate.ts")

    expect(script).toContain("[REDACTED]")
    // Must redact common token patterns
    expect(script).toContain("ghp_")
    expect(script).toContain("sk-")
    expect(script).toContain("npm_")
  })

  it("ci-autofix has anti-loop guards and trust checks", async () => {
    const script = await readRoot("script/ci-autofix.ts")

    // Must check for bot actor
    expect(script).toContain("github-actions[bot]")
    expect(script).toContain("nikcli-ci[bot]")

    // Must check skip patterns
    expect(script).toContain("[nikcli autofix]")
    expect(script).toContain("release: v")
    expect(script).toContain("chore: generate")

    // Must check repository trust
    expect(script).toContain("nikomatt69/nikcli")

    // Must check for the provider key used by the default MiniMax model
    expect(script).toContain("MINIMAX_API_KEY")

    // Must not push without validation passing
    expect(script).toContain("revalidateExit")

    // Must signal distinct exit code for autofix failure
    expect(script).toContain("process.exit(78)")
  })
})

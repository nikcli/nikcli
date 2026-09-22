import { describe, expect, it } from "bun:test"
import { Installation } from "@/installation"
import fs from "fs/promises"
import path from "path"

const root = path.resolve(import.meta.dir, "../../../..")
const readSrc = (rel: string) => fs.readFile(path.join(root, rel), "utf8")

const INSTALLATION_SRC = "packages/nikcli/src/installation/index.ts"

describe("upgrade strategy routing", () => {
  it("routes package-manager installs through their own manager, including on Windows", () => {
    // A standalone-installer run on Windows drops the binary in ~\.nikcli\bin
    // while the manager's shim (%AppData%\npm\nikcli.cmd, the choco/scoop bin)
    // still wins on PATH, so the upgrade reports success but is a no-op.
    for (const method of ["npm", "yarn", "pnpm", "bun", "brew", "choco", "scoop"] as Installation.Method[]) {
      expect(Installation.resolveUpgradeStrategy(method, "win32")).toEqual({
        type: "package-manager",
        method,
      })
      expect(Installation.resolveUpgradeStrategy(method, "darwin")).toEqual({
        type: "package-manager",
        method,
      })
    }
  })

  it("keeps standalone and undetected installs on the PowerShell installer on Windows", () => {
    for (const method of ["curl", "unknown"] as Installation.Method[]) {
      expect(Installation.resolveUpgradeStrategy(method, "win32")).toEqual({
        type: "windows-installer",
        script: Installation.WINDOWS_UPGRADE_SCRIPT,
      })
    }
    // ...and on the shell installer everywhere else.
    expect(Installation.resolveUpgradeStrategy("curl", "linux")).toEqual({
      type: "package-manager",
      method: "curl",
    })
  })

  it("has an upgrade command for every method the detector can return", async () => {
    const src = await readSrc(INSTALLATION_SRC)
    // "yarn" and "unknown" used to fall through to `throw new Error("Unknown method")`
    // even though methodImpl returns both.
    for (const method of ["curl", "unknown", "npm", "yarn", "pnpm", "bun", "brew", "choco", "scoop"]) {
      expect(src).toMatch(new RegExp(`case\\s+"${method}"\\s*:`))
    }
    expect(src).toContain("yarn global add nikcli-ai@${target}")
    // "unknown" shares the standalone installer branch with "curl".
    expect(src).toMatch(/case\s+"curl"\s*:\s*\n\s*case\s+"unknown"\s*:/)
  })

  it("offers every supported method on the CLI --method flag", async () => {
    // A flag's choices are a declaration, and declarations live in the spec tree
    // rather than beside the body that reads them.
    const src = await readSrc("packages/nikcli/src/cli/commands.ts")
    for (const method of ["curl", "npm", "yarn", "pnpm", "bun", "brew", "choco", "scoop"]) {
      expect(src).toContain(`"${method}"`)
    }
  })
})

describe("upgrade failure reporting", () => {
  it("carries the reason in stderr, since UpgradeFailedError.message is empty", () => {
    const err = new Installation.UpgradeFailedError({ stderr: "Could not write nikcli.exe" })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("")
    expect(err.stderr).toBe("Could not write nikcli.exe")
  })

  it("makes the TUI toast fall back to stderr instead of the empty message", async () => {
    const app = await readSrc("packages/tui/src/app.tsx")
    // Match on the name, never `instanceof`. The upgrade runs in the worker, so the error reaches
    // the terminal as a plain `Error` rebuilt by `Rpc` — the class does not cross the boundary and
    // the `instanceof` form this test used to require was dead, leaving the toast on its generic
    // fallback for every failed update. See test/tui/rpc-error.test.ts.
    expect(app).not.toContain("error instanceof Installation.UpgradeFailedError")
    expect(app).toContain('error.name === "UpgradeFailedError"')
    expect(app).toContain("? stderr")
    // The old handler showed a blank toast body for every failed update.
    expect(app).not.toContain('message: error instanceof Error ? error.message : "Update failed"')
  })

  it("never overwrites a real failure with the hardcoded choco elevation message", async () => {
    const src = await readSrc(INSTALLATION_SRC)
    expect(src).not.toContain('? "not running from an elevated command shell"')
    // Both the PowerShell installer and choco report on stdout, so both
    // streams must be considered.
    expect(src).toContain('result.stderr.toString("utf8").trim() ||')
    expect(src).toContain('result.stdout.toString("utf8").trim() ||')
    // The CLI still recognises the genuine chocolatey message when it appears.
    const cli = await readSrc("packages/nikcli/src/cli/handlers/upgrade.ts")
    expect(cli).toContain("not running from an elevated command shell")
  })
})

describe("post-upgrade verification", () => {
  it("probes nikcli on PATH rather than the old still-running binary", async () => {
    const src = await readSrc(INSTALLATION_SRC)
    // process.execPath is the running (old) binary - on Windows it is the very
    // file the installer could not replace - so probing it proves nothing.
    expect(src).not.toContain("$`${process.execPath} --version`")
    expect(src).toContain("$`nikcli --version`")
    expect(src).toContain("Upgrade did not take effect")
  })

  it("skips verification on Windows, where the swap is deferred by design", async () => {
    const src = await readSrc(INSTALLATION_SRC)
    expect(src).toMatch(/async function verifyUpgrade[^{]*\{\s*if \(process\.platform === "win32"\) return/)
  })

  it("does not claim completion while a Windows swap is still pending", async () => {
    const cli = await readSrc("packages/nikcli/src/cli/handlers/upgrade.ts")
    expect(cli).toContain('Installation.resolveUpgradeStrategy(method).type === "windows-installer"')
    expect(cli).toContain("Upgrade staged")
  })
})

describe("latest-version lookups for unpublished channels", () => {
  it("does not index blindly into an empty chocolatey feed", async () => {
    const src = await readSrc(INSTALLATION_SRC)
    // nikcli is not on Chocolatey today, so `data.d.results[0].Version` threw
    // an opaque TypeError that killed the whole update check.
    expect(src).toContain("data?.d?.results?.[0]?.Version")
    expect(src).toContain("nikcli is not published to Chocolatey")
  })

  it("reports a readable error for the missing scoop manifest", async () => {
    const src = await readSrc(INSTALLATION_SRC)
    expect(src).toContain("nikcli is not published to Scoop's Main bucket")
  })

  it("falls through to the GitHub release when the brew core formula is absent", async () => {
    const src = await readSrc(INSTALLATION_SRC)
    // There is no nikcli formula in homebrew-core (only nikomatt69/tap), so a
    // 404 there must not fail the update check.
    expect(src).toContain('await fetch("https://formulae.brew.sh/api/formula/nikcli.json").catch(() => null)')
    expect(src).toContain("api.github.com/repos/nikcli/nikcli/releases/latest")
  })
})

describe("deferred Windows swap (install.ps1)", () => {
  it("stays in sync across all served copies of the installer", async () => {
    const [root_, web, publicCopy] = await Promise.all([
      readSrc("install.ps1"),
      readSrc("packages/web/install.ps1"),
      readSrc("packages/web/public/install.ps1"),
    ])
    expect(web).toBe(root_)
    expect(publicCopy).toBe(root_)
  })

  it("retries long enough to move a large binary and falls back to rename-aside", async () => {
    const ps1 = await readSrc("install.ps1")
    // 100 x 100ms (~10s) was not enough to move a ~160MB exe on a slow disk.
    expect(ps1).not.toContain("`$attempt -lt 100;")
    expect(ps1).toContain("`$attempt -lt 480;")
    // Windows allows renaming a running exe even though it refuses to
    // overwrite it, so a relaunched nikcli no longer blocks the swap.
    expect(ps1).toContain("'.old.' + [System.Guid]::NewGuid().ToString('N')")
  })

  it("keeps the staged binary and logs the reason when the swap fails", async () => {
    const ps1 = await readSrc("install.ps1")
    // The old helper deleted the staged update and exited 1 in silence.
    expect(ps1).not.toMatch(/Remove-Item -LiteralPath '\$quotedPending' -Force[\s\S]{0,20}exit 1/)
    expect(ps1).toContain("$App.update.log")
    expect(ps1).toContain("Previous deferred update failed")
  })

  it("sweeps the renamed-aside binaries it leaves behind", async () => {
    const ps1 = await readSrc("install.ps1")
    expect(ps1).toContain('-Filter "$App.exe.old.*"')
  })

  it("applies a staged nikcli.update.*.exe on the next install run when the upgrade PID is gone", async () => {
    const ps1 = await readSrc("install.ps1")
    // The installation flow stages a new binary beside the running one when
    // the in-place copy is locked. The detached helper that should swap it
    // in runs after the installer exits, so if the user re-runs the
    // installer (or another `nikcli upgrade`) before the helper has had a
    // chance, the staged file must be applied instead of re-downloaded.
    expect(ps1).toContain("Applied staged update from")
    // The heuristic is the upgrade PID: if $env:NIKCLI_UPGRADE_PID points to
    // a still-running nikcli.exe, leave the staged file alone for the helper.
    expect(ps1).toContain("if ($env:NIKCLI_UPGRADE_PID)")
    expect(ps1).toContain("Get-Process -Id $staleUpgrader")
  })

  it("probes the swapped binary to confirm the version actually changed", async () => {
    const ps1 = await readSrc("install.ps1")
    // After a successful swap (loop or rename-aside fallback), the helper
    // probes the new binary's --version and writes a log line if it does
    // not match the expected version. Without this, a corrupted file or a
    // wrong target download would go unnoticed.
    expect(ps1).toContain("`$installed = (& '$quotedTarget' --version 2>`$null | Select-Object -First 1)")
    expect(ps1).toContain("probe reports '")
  })

  it("interpolates the expected version into the helper so the probe works on PS 5.1", async () => {
    const ps1 = await readSrc("install.ps1")
    // `Start-Process -Environment` was added in PowerShell 7, but Windows
    // Server 2022 and Windows 10 hosts still ship PowerShell 5.1 by default.
    // The expected version is therefore baked into the helper script at
    // build time via a quoted interpolation, instead of being passed via
    // -Environment / $env:NIKCLI_VERSION.
    expect(ps1).toContain("$quotedVersion = $version.Replace(")
    expect(ps1).not.toContain("-Environment @{ NIKCLI_VERSION = $env:NIKCLI_VERSION }")
  })
})

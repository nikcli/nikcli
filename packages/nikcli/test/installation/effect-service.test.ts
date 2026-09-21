import { describe, expect, it } from "bun:test"
import { Installation } from "@/installation"
import { shouldNotifyUpdate } from "@/cli/upgrade"
import { runPromiseWithLayer } from "@/effect"
import { Effect } from "effect"
import { createComponent, createRoot } from "solid-js"
import {
  checkUpgradeWhenSubscriptionReady,
  consumeGlobalEventStream,
  SDKProvider,
  useSDK,
  type GlobalEnvelope,
} from "@tui/context/sdk"
import fs from "fs/promises"
import path from "path"
import { TERMINAL_RESET_SEQUENCE } from "@nikcli-ai/util/win32"

const root = path.resolve(import.meta.dir, "../../../..")

async function readSrc(relative: string) {
  return fs.readFile(path.join(root, relative), "utf8")
}

function runInstallation<A, E>(effect: Effect.Effect<A, E, Installation.Service>) {
  return runPromiseWithLayer(Installation.defaultLayer, effect)
}

describe("Installation.Service", () => {
  it("provides the installation operations through the Effect service boundary", async () => {
    const operations = await runInstallation(
      Effect.gen(function* () {
        const installation = yield* Installation.Service
        return {
          info: typeof installation.info,
          latest: typeof installation.latest,
          method: typeof installation.method,
          upgrade: typeof installation.upgrade,
        }
      }),
    )

    expect(operations).toEqual({
      info: "function",
      latest: "function",
      method: "function",
      upgrade: "function",
    })
  })

  it("uses the PowerShell installer on Windows only for standalone installs", () => {
    for (const method of ["curl", "unknown"] as Installation.Method[]) {
      expect(Installation.resolveUpgradeStrategy(method, "win32")).toEqual({
        type: "windows-installer",
        script: "irm https://nikcli.store/install.ps1 | iex",
      })
    }

    // Package-manager installs must go through their own manager, whose shim
    // shadows ~\.nikcli\bin on PATH.
    for (const method of ["npm", "yarn", "pnpm", "bun", "brew", "scoop", "choco"] as Installation.Method[]) {
      expect(Installation.resolveUpgradeStrategy(method, "win32")).toEqual({
        type: "package-manager",
        method,
      })
    }
  })

  it("passes the running process ID to the lock-safe Windows installer", async () => {
    const source = await readSrc("packages/nikcli/src/installation/index.ts")
    expect(source).toContain("NIKCLI_UPGRADE_PID: process.pid.toString()")
  })

  it("keeps the detected package manager strategy on non-Windows platforms", () => {
    expect(Installation.resolveUpgradeStrategy("npm", "darwin")).toEqual({
      type: "package-manager",
      method: "npm",
    })
  })
})

describe("terminal teardown", () => {
  it("disables OpenTUI mouse reporting modes", () => {
    for (const mode of [1000, 1002, 1003, 1004, 1006, 1015]) {
      expect(TERMINAL_RESET_SEQUENCE).toContain(`\x1b[?${mode}l`)
    }
  })
})

describe("Homebrew installation support", () => {
  it("includes brew in the supported installation methods", () => {
    const methods: Installation.Method[] = ["curl", "npm", "yarn", "pnpm", "bun", "brew", "scoop", "choco", "unknown"]
    expect(methods).toContain("brew")
  })

  it("detects brew installations via both tap and core formulas", async () => {
    const source = await readSrc("packages/nikcli/src/installation/index.ts")

    // Must check for the tap formula first
    expect(source).toContain("nikomatt69/tap/nikcli")

    // Must also check core formula as fallback
    expect(source).toContain("brew list --formula nikcli")

    // Must have upgrade support for brew
    expect(source).toContain("brew upgrade")

    // Must disable auto-update during brew upgrade
    expect(source).toContain("HOMEBREW_NO_AUTO_UPDATE")
  })

  it("resolves latest version for brew via GitHub releases as fallback for tap formula", async () => {
    const source = await readSrc("packages/nikcli/src/installation/index.ts")

    // The tap formula should fall back to GitHub releases for version checking
    expect(source).toContain("api.github.com/repos/nikcli/nikcli/releases/latest")

    // Must handle brew.sh API for core formula
    expect(source).toContain("formulae.brew.sh")
  })

  it("exits with code 1 when upgrade fails", async () => {
    const upgradeSource = await readSrc("packages/nikcli/src/cli/handlers/upgrade.ts")
    expect(upgradeSource).toMatch(/if\s*\(\s*err\s*\)[\s\S]*process\.exit\(1\)/)
  })

  it("includes brew in the upgrade command choices", async () => {
    // The `--method` choices are a declaration, and declarations are in the
    // spec tree now rather than beside the body that reads them.
    const upgradeSource = await readSrc("packages/nikcli/src/cli/commands.ts")
    expect(upgradeSource).toContain('"brew"')

    const uninstallSource = await readSrc("packages/nikcli/src/cli/handlers/uninstall.ts")
    expect(uninstallSource).toContain("brew uninstall")
  })
})

describe("shouldNotifyUpdate (cross-platform update detection)", () => {
  it("returns false when current equals latest", () => {
    expect(shouldNotifyUpdate("1.137.0", "1.137.0")).toBe(false)
  })

  it("returns true when current is a lower semver than latest", () => {
    expect(shouldNotifyUpdate("1.136.9", "1.137.0")).toBe(true)
    expect(shouldNotifyUpdate("1.99.0", "2.0.0")).toBe(true)
  })

  it("returns false when current is equal or higher than latest", () => {
    expect(shouldNotifyUpdate("1.137.1", "1.137.0")).toBe(false)
    expect(shouldNotifyUpdate("2.0.0", "1.137.0")).toBe(false)
  })

  it("handles prerelease tags correctly (running a beta is older than stable)", () => {
    // Strict semver comparison: 1.137.0-beta.1 < 1.137.0 (prerelease lower
    // precedence than stable). Users running a prerelease should be
    // prompted to upgrade to the matching stable.
    expect(shouldNotifyUpdate("1.137.0-beta.1", "1.137.0")).toBe(true)
    // Inverse: latest is the older prerelease, current is stable.
    expect(shouldNotifyUpdate("1.137.0", "1.137.0-beta.1")).toBe(false)
  })

  it("treats non-semver 'local' build as older so dev builds are notified", () => {
    // Build embedded in source as "local" should always see a notification
    expect(shouldNotifyUpdate("local", "1.137.0")).toBe(true)
  })

  it("falls back to strict inequality when either side is not clean semver", () => {
    // A git short SHA is not valid semver; inequality must kick in so that
    // CI / dev builds are still surfaced to the user instead of being
    // misread (e.g. semver.coerce('abc123') would otherwise turn this
    // into the wildcard '123.0.0', which is semantically wrong).
    expect(shouldNotifyUpdate("abc123", "1.137.0")).toBe(true)
    expect(shouldNotifyUpdate("1.137.0", "1.137.0")).toBe(false)
  })
})

describe("Update dialog wiring (cross-platform)", () => {
  it("declares the update-available event with version, method and current", async () => {
    const source = await readSrc("packages/nikcli/src/installation/index.ts")
    expect(source).toContain("UpdateAvailable")
    // The name itself lives in @nikcli-ai/util/version, so clients can subscribe without loading
    // the upgrade subsystem. Assert the wire value there and the reference here.
    expect(source).toContain("InstallationEventName.updateAvailable")
    const names = await readSrc("packages/util/src/version.ts")
    expect(names).toContain('updateAvailable: "installation.update-available"')
    expect(source).toMatch(/version:\s*Schema\.String/)
    expect(source).toMatch(/current:\s*Schema\.optional\(Schema\.String\)/)
  })

  it("the TUI drives the confirm dialog off the check result, not the event stream", async () => {
    const source = await readSrc("packages/tui/src/app.tsx")
    expect(source).toContain("DialogConfirm.show(")
    expect(source).toContain("Update Available")
    // The dialog must hang off `checkUpgrade`'s return value. Subscribing to
    // the event instead is the regression this test exists for: the check runs
    // in the CLI process (it replaces the installed binary, so it cannot run in
    // the background service) while the event stream comes from that service,
    // and the Bus is per-process — so the event never arrived and the TUI
    // silently stopped offering updates.
    expect(source).toContain("offerUpdate(available)")
    expect(source).not.toContain("InstallationEventName.updateAvailable")
  })

  it("the TUI dialog passes the detected install method to upgradeNow", async () => {
    const source = await readSrc("packages/tui/src/app.tsx")
    expect(source).toContain("upgradeNow?.(method")
  })

  it("establishes HTTP readiness from server.connected and continues consuming events", async () => {
    const connected: GlobalEnvelope = {
      payload: { type: "server.connected", properties: {} },
    }
    const update = {
      payload: {
        type: "installation.update-available",
        properties: { version: "2.0.0" },
      },
    } as GlobalEnvelope
    const sequence: string[] = []

    await consumeGlobalEventStream({
      stream: (async function* () {
        yield connected
        yield update
      })(),
      signal: new AbortController().signal,
      onConnected: () => sequence.push("ready"),
      onEnvelope: (envelope) => sequence.push(envelope.payload.type),
    })

    expect(sequence).toEqual(["ready", "server.connected", "installation.update-available"])
  })

  it("mounts SDK provider children without treating subscription readiness as provider readiness", () => {
    let mounted = false
    let dispose = () => {}

    createRoot((cleanup) => {
      dispose = cleanup
      const provider = createComponent(SDKProvider, {
        url: "http://nikcli.test",
        events: { subscribe: async () => () => {} },
        get children() {
          useSDK()
          mounted = true
          return null
        },
      })
      ;(provider as unknown as () => unknown)()
    })

    expect(mounted).toBe(true)
    dispose()
  })

  it("waits for event subscription establishment before checking for upgrades", async () => {
    let establish = () => {}
    const established = new Promise<void>((resolve) => {
      establish = resolve
    })
    let checked = false
    let subscriptionReady: Promise<void> | undefined
    let checkPromise: Promise<void> | undefined
    let dispose = () => {}

    createRoot((cleanup) => {
      dispose = cleanup
      const provider = createComponent(SDKProvider, {
        url: "http://nikcli.test",
        events: {
          subscribe: async () => {
            await established
            return () => {}
          },
        },
        get children() {
          const sdk = useSDK()
          subscriptionReady = sdk.subscriptionReady
          checkPromise = checkUpgradeWhenSubscriptionReady(sdk.subscriptionReady, async () => {
            checked = true
          })
          return null
        },
      })
      ;(provider as unknown as () => unknown)()
    })

    await Promise.resolve()
    expect(checked).toBe(false)

    establish()
    await subscriptionReady
    await checkPromise
    expect(checked).toBe(true)
    dispose()

    const [thread, app] = await Promise.all([
      readSrc("packages/nikcli/src/cli/handlers/default.ts"),
      readSrc("packages/tui/src/app.tsx"),
    ])
    expect(thread).toContain('client.call("checkUpgrade"')
    expect(thread).toContain("upgrade check failed")
    expect(thread).not.toContain('setTimeout(() => {\n        client.call("checkUpgrade"')
    // Whitespace-insensitive: prettier rewraps this call whenever the arguments or the print
    // width move, and the wiring is what matters, not where the line broke.
    expect(app).toMatch(/checkUpgradeWhenSubscriptionReady\(\s*sdk\.subscriptionReady,\s*props\.checkUpgrade,?\s*\)/)
    // Both host paths must hand the result back rather than fire and forget:
    // that return value is the only thing the TUI's dialog is driven by.
    expect(thread.replace(/\s+/g, " ")).toContain('return client.call("checkUpgrade"')
    expect(thread.replace(/\s+/g, " ")).toContain("return upgrade()")
  })

  it("hands the check result back to the caller instead of relying on the bus", async () => {
    let subscribed = () => {}
    const established = new Promise<void>((resolve) => {
      subscribed = resolve
    })
    let result: unknown
    let dispose = () => {}

    createRoot((cleanup) => {
      dispose = cleanup
      const provider = createComponent(SDKProvider, {
        url: "http://nikcli.test",
        events: {
          subscribe: async () => {
            await established
            return () => {}
          },
        },
        get children() {
          const sdk = useSDK()
          void checkUpgradeWhenSubscriptionReady(sdk.subscriptionReady, async () => ({
            version: "1.355.0",
            method: "curl" as const,
            current: "1.354.0",
          })).then((value) => {
            result = value
          })
          return null
        },
      })
      ;(provider as unknown as () => unknown)()
    })

    subscribed()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result).toEqual({ version: "1.355.0", method: "curl", current: "1.354.0" })
    dispose()
  })

  it("upgrade() publishes the event for every supported install method", async () => {
    const source = await readSrc("packages/nikcli/src/cli/upgrade.ts")
    // publish path must exist regardless of how the user invokes nikcli (TUI, CLI, ...)
    expect(source).toContain("Bus.publish(Installation.Event.UpdateAvailable")
    // it must consult semver, not string-equality
    expect(source).toContain("shouldNotifyUpdate")
    // ...and it must also *return* what it found, which is what the TUI acts on
    expect(source).toContain("Promise<UpdateAvailable | undefined>")
    expect(source).toContain("return available")
  })

  it("every install method has a working upgrade command (per platform)", async () => {
    const source = await readSrc("packages/nikcli/src/installation/index.ts")

    // macOS / Linux / Windows package manager install paths all covered
    // (regex tolerates spaces around the colon since prettier normalises them)
    expect(source).toMatch(/case\s+"curl"\s*:/) // mac/linux installer
    expect(source).toMatch(/case\s+"npm"\s*:/) // all OS
    expect(source).toMatch(/case\s+"pnpm"\s*:/) // all OS
    expect(source).toMatch(/case\s+"bun"\s*:/) // all OS
    expect(source).toMatch(/case\s+"brew"\s*:/) // mac/linux
    expect(source).toMatch(/case\s+"choco"\s*:/) // windows
    expect(source).toMatch(/case\s+"scoop"\s*:/) // windows

    // Each command must actually do an install for the right package
    expect(source).toContain("npm install -g nikcli-ai@${target}")
    expect(source).toContain("pnpm install -g nikcli-ai@${target}")
    expect(source).toContain("bun install -g nikcli-ai@${target}")
    expect(source).toContain("brew upgrade ${formula}")
    expect(source).toContain("choco upgrade nikcli --version=${target}")
    expect(source).toContain("scoop install nikcli@${target}")
    expect(source).toContain("https://nikcli.store/install")
  })

  it("every install method has a working latest-version fetch (per platform)", async () => {
    const source = await readSrc("packages/nikcli/src/installation/index.ts")

    // npm/pnpm/bun share the registry endpoint. The source uses a
    // template literal so the on-disk text contains the variable
    // expansion syntax (${registry}/nikcli-ai/${channel}).
    expect(source).toMatch(/\$\{registry\}\/nikcli-ai\/\$\{channel\}/)
    // brew core formula
    expect(source).toContain("formulae.brew.sh/api/formula/nikcli.json")
    // choco
    expect(source).toContain("community.chocolatey.org")
    // scoop manifest
    expect(source).toContain("ScoopInstaller/Main")
    // github fallback for unknown / brew-tap
    expect(source).toContain("api.github.com/repos/nikcli/nikcli/releases/latest")
  })

  it("the default config triggers the dialog (only opt-out via autoupdate:false or env)", async () => {
    const source = await readSrc("packages/nikcli/src/cli/upgrade.ts")
    expect(source).toMatch(/config\.autoupdate\s*===\s*false/)
    expect(source).toContain("NIKCLI_DISABLE_AUTOUPDATE")
    // The check must NOT be silently disabled when config is undefined
    // (the default case is "show dialog and ask").
    expect(source).not.toMatch(/config\.autoupdate\s*===\s*undefined/)
    expect(source).not.toMatch(/config\.autoupdate\s*===\s*true/)
  })
})

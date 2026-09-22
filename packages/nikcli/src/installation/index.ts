import { BusEvent } from "@/bus/bus-event"
import path from "path"
import { $ } from "bun"
import { Log } from "@nikcli-ai/util/log"
import { iife } from "@nikcli-ai/util/iife"
import { Flag } from "@nikcli-ai/util/flag"
import { bunUtils } from "@/bun"
import { zodObject } from "@nikcli-ai/util/effect-zod"
import { Context, Effect, Layer, Schema } from "effect"
import * as BuildVersion from "@nikcli-ai/util/version"

export namespace Installation {
  const log = Log.create({ service: "installation" })

  export type Method = BuildVersion.InstallMethod

  export const Event = {
    Updated: BusEvent.schema(
      BuildVersion.InstallationEventName.updated,
      Schema.Struct({
        version: Schema.String,
      }),
    ),
    UpdateAvailable: BusEvent.schema(
      BuildVersion.InstallationEventName.updateAvailable,
      Schema.Struct({
        version: Schema.String,
        method: Schema.optional(
          Schema.Literals(["curl", "npm", "yarn", "pnpm", "bun", "brew", "scoop", "choco", "unknown"]),
        ),
        current: Schema.optional(Schema.String),
      }),
    ),
  }

  const InfoSchema = Schema.Struct({
    version: Schema.String,
    latest: Schema.String,
  }).annotate({ identifier: "InstallationInfo" })
  export const Info = zodObject(InfoSchema)
  export type Info = Schema.Schema.Type<typeof InfoSchema>

  export class Service extends Context.Service<
    Service,
    {
      info(): Effect.Effect<Info, unknown>
      method(): Effect.Effect<Method, unknown>
      latest(installMethod?: Method): Effect.Effect<string, unknown>
      upgrade(method: Method, target: string): Effect.Effect<void, unknown>
    }
  >()("Installation.Service") {}

  export const layer = Layer.succeed(
    Service,
    Service.of({
      info: () => Effect.tryPromise(() => infoImpl()),
      method: () => Effect.tryPromise(() => methodImpl()),
      latest: (installMethod) => Effect.tryPromise(() => latestImpl(installMethod)),
      upgrade: (method, target) =>
        Effect.tryPromise({
          try: () => upgradeImpl(method, target),
          catch: (error) => error,
        }),
    }),
  )

  export const defaultLayer = layer

  async function infoImpl() {
    return {
      version: VERSION,
      latest: await latestImpl(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export function isStandaloneExecutable() {
    return bunUtils.isStandaloneExecutable
  }

  async function methodImpl(): Promise<Method> {
    if (process.execPath.includes(path.join(".nikcli", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".local", "bin"))) return "curl"
    const exec = process.execPath.toLowerCase()

    const checks = [
      {
        name: "npm" as const,
        command: () => $`npm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "yarn" as const,
        command: () => $`yarn global list`.throws(false).quiet().text(),
      },
      {
        name: "pnpm" as const,
        command: () => $`pnpm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "bun" as const,
        command: () => $`bun pm ls -g`.throws(false).quiet().text(),
      },
      {
        name: "brew" as const,
        command: () => $`brew list --formula nikcli`.throws(false).quiet().text(),
      },
      {
        name: "scoop" as const,
        command: () => $`scoop list nikcli`.throws(false).quiet().text(),
      },
      {
        name: "choco" as const,
        command: () => $`choco list --limit-output nikcli`.throws(false).quiet().text(),
      },
    ]

    checks.sort((a, b) => {
      const aMatches = exec.includes(a.name)
      const bMatches = exec.includes(b.name)
      if (aMatches && !bMatches) return -1
      if (!aMatches && bMatches) return 1
      return 0
    })

    for (const check of checks) {
      const output = await check.command()
      const installedName =
        check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "nikcli" : "nikcli-ai"
      if (output.includes(installedName)) {
        return check.name
      }
    }

    return "unknown"
  }

  export class UpgradeFailedError extends Schema.TaggedError<UpgradeFailedError>()("UpgradeFailedError", {
    stderr: Schema.String,
  }) {}

  export const WINDOWS_UPGRADE_SCRIPT = "irm https://nikcli-ai.dev/install.ps1 | iex"

  export type UpgradeStrategy =
    | { type: "windows-installer"; script: typeof WINDOWS_UPGRADE_SCRIPT }
    | { type: "package-manager"; method: Method }

  export function resolveUpgradeStrategy(
    method: Method,
    platform: NodeJS.Platform = process.platform,
  ): UpgradeStrategy {
    // On Windows only standalone installs (the "curl" method, i.e. the binary
    // in ~/.nikcli/bin) and undetected installs go through the PowerShell
    // installer. Package-manager installs must upgrade through their own
    // manager: the manager's shim (%AppData%\npm\nikcli.cmd, the choco or
    // scoop bin) comes before ~\.nikcli\bin on PATH, so a standalone
    // installer run would report success while the command the user actually
    // runs stays on the old version.
    if (platform === "win32" && (method === "curl" || method === "unknown")) {
      return { type: "windows-installer", script: WINDOWS_UPGRADE_SCRIPT }
    }
    return { type: "package-manager", method }
  }

  async function getBrewFormula() {
    const tapFormula = await $`brew list --formula nikomatt69/tap/nikcli`.throws(false).quiet().text()
    if (tapFormula.includes("nikcli")) return "nikomatt69/tap/nikcli"
    const coreFormula = await $`brew list --formula nikcli`.throws(false).quiet().text()
    if (coreFormula.includes("nikcli")) return "nikcli"
    return "nikcli"
  }

  async function upgradeImpl(method: Method, target: string) {
    let cmd
    const strategy = resolveUpgradeStrategy(method)
    if (strategy.type === "windows-installer") {
      cmd = $`powershell -NoProfile -NonInteractive -Command ${strategy.script}`.env({
        ...process.env,
        NIKCLI_VERSION: target,
        NIKCLI_UPGRADE_PID: process.pid.toString(),
      })
    } else
      switch (strategy.method) {
        case "curl":
        case "unknown":
          // "unknown" means detection failed and the user explicitly chose to
          // install anyway — fall back to the standalone installer instead of
          // throwing.
          cmd = $`curl -fsSL https://nikcli-ai.dev/install | bash`.env({
            ...process.env,
            VERSION: target,
          })
          break
        case "npm":
          cmd = $`npm install -g nikcli-ai@${target}`
          break
        case "yarn":
          cmd = $`yarn global add nikcli-ai@${target}`
          break
        case "pnpm":
          cmd = $`pnpm install -g nikcli-ai@${target}`
          break
        case "bun":
          cmd = $`bun install -g nikcli-ai@${target}`
          break
        case "brew": {
          const formula = await getBrewFormula()
          cmd = $`brew upgrade ${formula}`.env({
            HOMEBREW_NO_AUTO_UPDATE: "1",
            ...process.env,
          })
          break
        }
        case "choco":
          cmd = $`echo Y | choco upgrade nikcli --version=${target}`
          break
        case "scoop":
          cmd = $`scoop install nikcli@${target}`
          break
        default:
          throw new Error(`Unknown method: ${method}`)
      }
    const result = await cmd.quiet().throws(false)
    if (result.exitCode !== 0) {
      // Never overwrite the real failure reason: both the PowerShell installer
      // and chocolatey report their errors on stdout rather than stderr, so
      // prefer whichever stream actually carries a message.
      const stderr =
        result.stderr.toString("utf8").trim() ||
        result.stdout.toString("utf8").trim() ||
        `Upgrade command exited with code ${result.exitCode}`
      throw new UpgradeFailedError({
        stderr: stderr,
      })
    }
    log.info("upgraded", {
      method,
      target,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    await verifyUpgrade(target)
  }

  /**
   * Best-effort check that the upgrade actually took effect.
   *
   * Probing `process.execPath` proves nothing: that is the still-running old
   * binary, and on Windows it is the locked file the installer could not even
   * replace. What matters is what `nikcli` resolves to on PATH, which is where
   * a package-manager shim would keep shadowing a standalone install.
   *
   * Skipped on Windows, where the swap is deliberately deferred until the
   * current process exits (see install.ps1), so the old version is still the
   * one on disk at this point by design.
   */
  async function verifyUpgrade(target: string) {
    if (process.platform === "win32") return
    const probe = (
      await $`nikcli --version`
        .nothrow()
        .quiet()
        .text()
        .catch(() => "")
    ).trim()
    const installed = probe.replace(/^v/, "")
    const expected = target.replace(/^v/, "")
    // Only fail on a clean, different semver. An unparseable probe (nikcli not
    // on PATH in this shell, a wrapper printing a banner, ...) means we cannot
    // verify, so trust the installer's exit code rather than block a real
    // upgrade.
    if (/^\d+\.\d+\.\d+/.test(installed) && installed !== expected) {
      throw new UpgradeFailedError({
        stderr: `Upgrade did not take effect: nikcli on PATH reports ${installed}, expected ${expected}.`,
      })
    }
  }

  // Defined in @nikcli-ai/util/version; re-exported so existing `Installation.VERSION` callers
  // keep working while new ones can take the constant without the upgrade subsystem.
  export const VERSION = BuildVersion.VERSION
  export const CHANNEL = BuildVersion.CHANNEL
  export const REVISION = BuildVersion.REVISION
  export const hasRevision = BuildVersion.hasRevision
  export const USER_AGENT = `nikcli/${CHANNEL}/${VERSION}/${Flag.NIKCLI_CLIENT}`

  export function getReleaseType(current: string, latest: string): "major" | "minor" | "patch" {
    const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number)
    const [curMaj, curMin] = parse(current)
    const [latMaj, latMin] = parse(latest)
    if (latMaj > curMaj) return "major"
    if (latMin > curMin) return "minor"
    return "patch"
  }

  async function latestImpl(installMethod?: Method) {
    const detectedMethod = installMethod || (await methodImpl())

    if (detectedMethod === "brew") {
      const formula = await getBrewFormula()
      if (formula === "nikcli") {
        // There is no nikcli formula in homebrew-core today (only the
        // nikomatt69/tap one), so this 404s. If it is ever published we use
        // it; until then fall through to the GitHub release below instead of
        // failing the whole update check.
        const res = await fetch("https://formulae.brew.sh/api/formula/nikcli.json").catch(() => null)
        if (res?.ok) {
          // SAFETY: only `versions.stable` is read, optional-chained on the next
          // line, so a brew response of any other shape yields undefined and
          // falls through to the GitHub release path below.
          const data = (await res.json()) as { versions?: { stable?: string } }
          if (data.versions?.stable) return data.versions.stable
        }
      }
    }

    if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
      const registry = await iife(async () => {
        const r = (await $`npm config get registry`.quiet().nothrow().text()).trim()
        const reg = r || "https://registry.npmjs.org"
        return reg.endsWith("/") ? reg.slice(0, -1) : reg
      })
      const channel = CHANNEL
      return fetch(`${registry}/nikcli-ai/${channel}`)
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    if (detectedMethod === "choco") {
      return fetch(
        "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27nikcli%27%20and%20IsLatestVersion&$select=Version",
        { headers: { Accept: "application/json;odata=verbose" } },
      )
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => {
          // The feed is empty while nikcli is unpublished on Chocolatey;
          // indexing straight into it throws an opaque TypeError.
          const version = data?.d?.results?.[0]?.Version
          if (!version) throw new Error("nikcli is not published to Chocolatey")
          return version
        })
    }

    if (detectedMethod === "scoop") {
      return fetch("https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/nikcli.json", {
        headers: { Accept: "application/json" },
      })
        .then((res) => {
          if (!res.ok) throw new Error("nikcli is not published to Scoop's Main bucket")
          return res.json()
        })
        .then((data: any) => {
          if (!data?.version) throw new Error("nikcli is not published to Scoop's Main bucket")
          return data.version
        })
    }

    return fetch("https://api.github.com/repos/nikcli/nikcli/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}

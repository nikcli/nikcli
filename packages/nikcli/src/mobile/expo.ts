import z from "zod"
import { Log } from "@nikcli-ai/util/log"

const log = Log.create({ service: "expo" })

export namespace Expo {
  export const StartOptions = z.object({
    platform: z.enum(["ios", "android", "web"]).optional(),
    clear: z.boolean().optional(),
    port: z.number().optional(),
  })
  export type StartOptions = z.infer<typeof StartOptions>

  export const BuildOptions = z.object({
    platform: z.enum(["ios", "android", "all"]),
    profile: z.string().optional(),
    clearCache: z.boolean().optional(),
  })
  export type BuildOptions = z.infer<typeof BuildOptions>

  export async function available(): Promise<boolean> {
    return (await Bun.which("npx")) !== null
  }

  /**
   * Probe arguments for `npx`.
   *
   * `--no-install` is what keeps a version check from becoming a download:
   * plain `npx expo --version` on a machine without the package *fetches it
   * from the registry first*, so a probe meant to answer "is this installed"
   * takes however long the network does, and installs the thing it was asking
   * about. Actions the user asked for (`start`, `build`, `install`, `publish`)
   * deliberately do not pass this — there, fetching is the point.
   */
  const PROBE = ["--no-install"]

  /**
   * How long a single "is this CLI here" probe may take. Short on purpose:
   * the answer is a local file lookup, and anything slower is a probe that
   * has gone to the network despite `--no-install`.
   */
  const PROBE_TIMEOUT_MS = 3_000

  async function exec(args: string[], opts?: { cwd?: string; timeout?: number }): Promise<string> {
    const proc = Bun.spawn(["npx", ...args], {
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts?.cwd,
      env: process.env as Record<string, string>,
    })

    const timeout = opts?.timeout ?? 120000
    const timer = setTimeout(() => proc.kill(), timeout)
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    clearTimeout(timer)

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `npx ${args.join(" ")} exited with code ${exitCode}`)
    }

    return stdout.trim()
  }

  export async function version(): Promise<string> {
    try {
      const output = await exec([...PROBE, "expo", "--version"], { timeout: PROBE_TIMEOUT_MS })
      return output
    } catch {
      return "not available"
    }
  }

  export async function start(opts: StartOptions & { cwd?: string }): Promise<{
    url: string
    pid: number
  }> {
    const args = ["expo", "start"]
    if (opts.platform) args.push("--", `--${opts.platform}`)
    if (opts.clear) args.push("--clear")
    if (opts.port) args.push("--port", String(opts.port))

    const proc = Bun.spawn(["npx", ...args], {
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
      env: process.env as Record<string, string>,
    })

    const stdout = proc.stdout
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    let url = ""

    const timeoutMs = 30000
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value)
      output += text

      const urlMatch = output.match(/exp:\/\/[\d.]+:\d+/)
      if (urlMatch) {
        url = urlMatch[0]
        break
      }

      const metroMatch = output.match(/Metro waiting on (exp:\/\/[^\s]+)/)
      if (metroMatch) {
        url = metroMatch[1]
        break
      }
    }

    reader.releaseLock()

    if (!url) {
      const urlMatch = output.match(/exp:\/\/[\d.]+:\d+/)
      url = urlMatch?.[0] ?? `http://localhost:${opts.port ?? 8081}`
    }

    log.info("expo dev server started", { url, pid: proc.pid })

    return { url, pid: proc.pid ?? 0 }
  }

  export async function build(opts: BuildOptions & { cwd?: string }): Promise<string> {
    const args = ["eas", "build", "--non-interactive"]
    args.push("--platform", opts.platform)
    if (opts.profile) args.push("--profile", opts.profile)
    if (opts.clearCache) args.push("--clear-cache")

    const output = await exec(args, { cwd: opts.cwd, timeout: 600000 })
    log.info("eas build completed", { platform: opts.platform, profile: opts.profile })
    return output
  }

  export async function installPackages(packages: string[], opts?: { cwd?: string }): Promise<string> {
    const args = ["expo", "install", ...packages]
    const output = await exec(args, { cwd: opts?.cwd, timeout: 120000 })
    log.info("expo install completed", { packages })
    return output
  }

  export async function publish(opts?: { message?: string; cwd?: string }): Promise<string> {
    const args = ["expo", "publish"]
    if (opts?.message) args.push("--message", opts.message)
    const output = await exec(args, { cwd: opts?.cwd, timeout: 120000 })
    log.info("expo publish completed")
    return output
  }

  export async function listProfiles(opts?: { cwd?: string }): Promise<string[]> {
    try {
      const proc = Bun.spawn(["npx", "eas", "build:list", "--json", "--limit", "0"], {
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts?.cwd,
        env: process.env as Record<string, string>,
      })
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
      if (exitCode === 0) {
        const data = JSON.parse(stdout)
        if (Array.isArray(data)) {
          const profiles = new Set<string>()
          for (const item of data) {
            if (item.buildProfile) profiles.add(item.buildProfile)
          }
          return [...profiles]
        }
      }
    } catch {}
    return []
  }

  export async function doctor(opts?: { cwd?: string }): Promise<{
    expoCli: boolean
    easCli: boolean
    nodeVersion: string
    details: string[]
  }> {
    // Concurrently: three independent "is this here" questions, each paying a
    // process spawn. Run in sequence they added up to seconds on a route the
    // app calls on every connect, for an answer that is the same either way.
    // `details` is assembled afterwards so its order stays stable regardless
    // of which probe finishes first.
    const [node, expoVersion, easVersion] = await Promise.all([
      (async () => {
        try {
          const proc = Bun.spawn(["node", "--version"], { windowsHide: true, stdout: "pipe", stderr: "pipe" })
          const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS)
          const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
          clearTimeout(timer)
          return code === 0 ? out.trim() : undefined
        } catch {
          return undefined
        }
      })(),
      version().then((value) => (value === "not available" ? undefined : value)),
      // Through `exec`, so this one is bounded too. Spawned directly it had no
      // timer at all — `doctor` is reached from `GET /mobile/bootstrap`, so an
      // `npx` that sat waiting on the registry held a request open for as long
      // as it liked.
      exec([...PROBE, "eas", "--version"], { cwd: opts?.cwd, timeout: PROBE_TIMEOUT_MS }).catch(() => undefined),
    ])

    const details: string[] = []
    if (node) details.push(`Node.js: ${node}`)
    else details.push("Node.js: not found")
    details.push(`Expo CLI: ${expoVersion ?? "not installed"}`)
    details.push(`EAS CLI: ${easVersion ?? "not installed"}`)

    return {
      expoCli: Boolean(expoVersion),
      easCli: Boolean(easVersion),
      nodeVersion: node ?? "",
      details,
    }
  }
}

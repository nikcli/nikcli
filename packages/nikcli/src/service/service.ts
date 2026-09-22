import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomBytes, randomUUID } from "crypto"
import { Global } from "@nikcli-ai/util/global"
import { Log } from "@nikcli-ai/util/log"
import { Installation } from "@/installation"
import { Flag } from "@nikcli-ai/util/flag"

const log = Log.create({ service: "background-service" })

/**
 * The persistent background server every client shares.
 *
 * nikcli used to evaluate its whole engine graph per invocation, in the client
 * process *and* again in the TUI's worker isolate. A long-lived service pays it
 * once per machine and leaves clients as thin HTTP consumers — the shape
 * `nikcli attach <url>` has always run in.
 *
 * The lifecycle here follows opencode v2's CLI daemon (`services/daemon.ts` in
 * its `packages/cli`, formerly `services/service-{config,registration}.ts`),
 * including the parts that are not obvious:
 *
 * - **Per-channel registration and port.** A `local` dev build and an installed
 *   release must not fight over one service; each channel gets its own file and
 *   its own default port.
 * - **Atomic registration writes** (temp file + rename), so a client polling
 *   during startup never parses a half-written file.
 * - **A service that loses ownership shuts itself down.** Each instance stamps a
 *   random `id`; a watchdog re-reads the file every 5s and exits if the entry is
 *   no longer its own. That, not locking, is what keeps two services from
 *   serving the same channel indefinitely.
 * - **Ownership-checked cleanup**, so an older instance exiting cannot delete a
 *   newer one's registration.
 * - **A pid is signalled only once it is proven to be the service** — the
 *   registered URL answers health with the registered version — because a
 *   registration outlives a crash and the OS reuses pids.
 * - **A private password per channel**, as opencode's daemon has: generated once
 *   into a 0600 file, read by the service itself, sent by every client. Loopback
 *   is not a boundary on its own — every local user and any web page can reach
 *   the port — and the file is readable only by the user the service runs as.
 *
 * See `specs/background-service.md`.
 */
export namespace BackgroundService {
  export interface Registration {
    readonly id: string
    readonly pid: number
    readonly url: string
    readonly version: string
    readonly startedAt: number
  }

  const START_TIMEOUT_MS = 30_000
  const HEALTH_TIMEOUT_MS = 2_000
  /**
   * How long a service that accepts connections but does not answer is given
   * before it is written off. A turn that blocks the event loop for a few
   * seconds is a busy engine, not a dead one, and writing it off evicts it —
   * suspending every session it is running.
   */
  const BUSY_GRACE_MS = 6_000
  const POLL_INTERVAL_MS = 100
  const STOP_TIMEOUT_MS = 10_000
  const OWNERSHIP_INTERVAL_MS = 5_000

  /** Channels that share the default name, mirroring opencode's list. */
  const SHARED_CHANNELS = new Set(["latest", "dev", "beta", "next"])

  /**
   * One registration per channel.
   *
   * Without this a `local` build and an installed release discover each other's
   * service and restart it on every version check, forever.
   */
  export function filename(channel = Installation.CHANNEL): string {
    if (SHARED_CHANNELS.has(channel)) return "service.json"
    return `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
  }

  /**
   * A stable, per-channel default port instead of an ephemeral one.
   *
   * Predictable enough to curl by hand, and distinct per channel so two builds
   * never race for the same socket. `serve` still falls back to an ephemeral
   * port if it is taken, and the registration records whatever was actually
   * bound, so nothing depends on getting this port.
   */
  export function defaultPort(channel = Installation.CHANNEL): number {
    if (SHARED_CHANNELS.has(channel)) return 0xc0de
    if (channel === "local") return 0xc0df
    let hash = 0
    for (const char of channel) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return 10_000 + (hash % 50_000)
  }

  /**
   * Whether a discovered service's version counts as "this build".
   *
   * Exact equality is wrong for preview channels, whose versions carry a build
   * counter (`0.0.0-<channel>-<n>`): every rebuild would look like skew and
   * restart the service, so the engine would never actually stay warm.
   */
  export function versionBelongsToChannel(
    version: string | undefined,
    channel = Installation.CHANNEL,
    installed = Installation.VERSION,
  ): boolean {
    if (version === undefined) return false
    if (version === installed) return true
    const prefix = `0.0.0-${channel}-`
    if (!version.startsWith(prefix)) return false
    return /^\d+(?:\.\d+)?$/.test(version.slice(prefix.length))
  }

  /**
   * Resolved per call, never cached: `Global.Path.state` is a getter that follows
   * `NIKCLI_TEST_HOME`, which tests swap per file.
   */
  function registrationPath() {
    return path.join(Global.Path.state, filename())
  }

  function lockPath() {
    return path.join(Global.Path.state, `${filename()}.lock`)
  }

  /** The Basic-auth username of the service's credentials. `Auth` uses the same literal. */
  export const USERNAME = "nikcli"

  function passwordPath() {
    return path.join(Global.Path.state, filename().replace(/\.json$/, ".password"))
  }

  async function readPassword(): Promise<string> {
    return fs
      .readFile(passwordPath(), "utf8")
      .then((raw) => raw.trim())
      .catch(() => "")
  }

  /**
   * The channel's service password, generated on first use; `value` replaces it.
   *
   * One credential kept across restarts, as opencode's daemon keeps its own, so
   * a client that discovers the service can authenticate with no flag or
   * environment variable. Replacing it leaves a running service on the old one:
   * `nikcli service password <value>` stops the service once the file is written.
   */
  export async function password(value?: string): Promise<string> {
    if (value !== undefined) {
      const next = value.trim()
      if (!next) throw new Error("The service password cannot be empty")
      await writePassword(next, "replace")
      return next
    }
    const existing = await readPassword()
    if (existing) return existing
    return writePassword(randomBytes(32).toString("base64url"), "create")
  }

  /**
   * `create` publishes only if nobody else has: two clients starting at once
   * would otherwise each write their own, and whichever password the service
   * did not read is refused on every request. A hard link is the atomic
   * create-if-absent for a file whose content is already complete.
   */
  async function writePassword(secret: string, mode: "create" | "replace"): Promise<string> {
    const file = passwordPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(temp, secret, { mode: 0o600 })
    try {
      if (mode === "create") {
        try {
          await fs.link(temp, file)
          return secret
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
            const existing = await readPassword()
            if (existing) return existing
          }
          // An empty file names no password, and a volume without hard links
          // cannot create-if-absent: replacing is the fallback for both.
        }
      }
      await fs.rename(temp, file)
      return secret
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {})
    }
  }

  /** The Basic `Authorization` value for a password — the service's own username unless told otherwise. */
  export function authorization(secret: string, username = USERNAME): string {
    return `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`
  }

  /**
   * Whether `url` addresses the registered service, without probing it.
   *
   * Loopback names are one host: the registration says `127.0.0.1`, and a user
   * typing `localhost` means the same socket.
   */
  export async function isServiceUrl(url: string): Promise<boolean> {
    const registration = await readRegistration()
    if (!registration) return false
    const a = URL.parse(registration.url)
    const b = URL.parse(url)
    if (!a || !b) return false
    const host = (value: URL) =>
      value.hostname === "localhost" || value.hostname === "127.0.0.1" || value.hostname === "[::1]"
        ? "loopback"
        : value.hostname
    return a.protocol === b.protocol && a.port === b.port && host(a) === host(b)
  }

  /**
   * Put the server's `credentials` on a request, beside the user identity it
   * may already carry. The one client-side rule, for every transport: the
   * service's `fetch`, `attach`, and the in-process clients.
   *
   * A request that carries a bearer — the `/user/*` calls send the terminal's
   * issuer token — keeps it as `?token=`, the `auth_token` scheme the server
   * accepts wherever it accepts a bearer header: one `Authorization` header
   * cannot hold both, and without the bearer the call loses its identity while
   * without the credential it is refused. Any other `Authorization` the caller
   * chose is its own decision; `false` means it was left alone.
   */
  export function withCredentials(target: URL, headers: Headers, credentials: string): boolean {
    const existing = headers.get("authorization")
    const bearer = existing ? /^Bearer\s+(.+)$/i.exec(existing)?.[1]?.trim() : undefined
    if (existing && !bearer) return false
    if (bearer && !target.searchParams.has("token")) target.searchParams.set("token", bearer)
    headers.set("authorization", credentials)
    return true
  }

  /**
   * A `fetch` that presents `credentials` to the server at `url`, and only to
   * it: the TUI sends every request through one function, other hosts
   * included, and the password must not leave for them.
   */
  export function authorizedFetch(url: string, credentials: string): typeof fetch {
    const origin = new URL(url).origin
    const authorized = async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : String(input))
      if (target.origin !== origin) return fetch(input, init)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      if (!withCredentials(target, headers, credentials)) return fetch(input, init)
      return fetch(input instanceof Request ? new Request(target, input) : target, { ...init, headers })
    }
    return Object.assign(authorized, { preconnect: fetch.preconnect }) as typeof fetch
  }

  /**
   * How a client reaches the server at `url`.
   *
   * The shared service takes its channel password, and it has no directory of
   * its own — it serves every project from the user's home — so a client of it
   * names the directory it runs in (`service: true`). Any other server takes
   * `NIKCLI_SERVER_PASSWORD` when it is set, as opencode's client falls back to
   * its own, and keeps meaning "the server's directory" when none is named.
   */
  export async function connection(url: string): Promise<{ fetch?: typeof fetch; service: boolean }> {
    if (await isServiceUrl(url)) return { fetch: authorizedFetch(url, authorization(await password())), service: true }
    const secret = Flag.NIKCLI_SERVER_PASSWORD?.trim()
    if (!secret) return { service: false }
    return {
      fetch: authorizedFetch(url, authorization(secret, Flag.NIKCLI_SERVER_USERNAME?.trim() || USERNAME)),
      service: false,
    }
  }

  /**
   * What reading the registration found.
   *
   * `unreadable` is kept apart from `absent` for the watchdog: a read that
   * failed (EMFILE under fd pressure, EIO) says nothing about who owns the
   * channel, and treating it as "gone" made a busy service evict itself.
   */
  type ReadResult =
    | { readonly kind: "present"; readonly registration: Registration }
    | { readonly kind: "absent" }
    | { readonly kind: "unreadable" }

  function parseRegistration(raw: string): Registration | undefined {
    try {
      const parsed = JSON.parse(raw) as Partial<Registration>
      if (typeof parsed.pid !== "number" || typeof parsed.url !== "string") return undefined
      return {
        id: typeof parsed.id === "string" ? parsed.id : "",
        pid: parsed.pid,
        url: parsed.url,
        version: typeof parsed.version === "string" ? parsed.version : "",
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      }
    } catch {
      return undefined
    }
  }

  async function readRegistrationResult(): Promise<ReadResult> {
    let raw: string
    try {
      raw = await fs.readFile(registrationPath(), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { kind: "absent" }
      return { kind: "unreadable" }
    }
    // Writes are temp + rename, so a file that does not parse was not written
    // by a service: it names no owner.
    const registration = parseRegistration(raw)
    return registration ? { kind: "present", registration } : { kind: "absent" }
  }

  async function readRegistration(): Promise<Registration | undefined> {
    const result = await readRegistrationResult()
    return result.kind === "present" ? result.registration : undefined
  }

  function owns(found: Registration | undefined, mine: Registration): boolean {
    return found !== undefined && found.id === mine.id && found.pid === mine.pid && found.url === mine.url
  }

  /**
   * Remove the registration only if it is still `expected`.
   *
   * Every removal goes through here, the disposer's included. Between
   * reading an entry and deciding it is stale — seconds, when a probe waits out
   * a busy service — another client can start a new service, and deleting
   * *its* entry makes its watchdog stand it down.
   */
  async function removeIfUnchanged(expected: Registration): Promise<void> {
    const found = await readRegistration()
    if (!owns(found, expected)) return
    await fs.rm(registrationPath(), { force: true }).catch(() => {})
  }

  /**
   * Publish this process as the service for its channel, and start the watchdog
   * that stands it down if another instance takes over.
   *
   * Returns the disposer `serve` calls on shutdown — it removes the file only if
   * this instance still owns it, so an older process exiting cannot delete a
   * newer one's entry.
   *
   * `intervalMs` exists for tests; the service always runs the default.
   */
  export async function register(
    url: string,
    onEvicted?: () => void,
    options?: { readonly intervalMs?: number },
  ): Promise<() => Promise<void>> {
    const registration: Registration = {
      id: randomUUID(),
      pid: process.pid,
      url,
      version: Installation.VERSION,
      startedAt: Date.now(),
    }

    const file = registrationPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Temp + rename: a client polling `discover()` during startup must never
    // parse a partially written file.
    const temp = `${file}.${registration.id}.tmp`
    await fs.writeFile(temp, JSON.stringify(registration), { mode: 0o600 })
    await fs.rename(temp, file)
    log.info("service registered", registration)

    // Set by the disposer. A tick already reading when shutdown removes the
    // file would otherwise see it gone and "evict" a service that is draining —
    // and a second SIGTERM makes `serve` force-exit mid-drain.
    let disposed = false
    const watchdog = setInterval(() => {
      void readRegistrationResult().then((result) => {
        if (disposed || result.kind === "unreadable") return
        const found = result.kind === "present" ? result.registration : undefined
        if (owns(found, registration)) return
        log.warn("service registration replaced; standing down", {
          id: registration.id,
          pid: registration.pid,
          observedId: found?.id,
          observedPid: found?.pid,
        })
        clearInterval(watchdog)
        onEvicted?.()
      })
    }, options?.intervalMs ?? OWNERSHIP_INTERVAL_MS)
    // Never hold the process open on our own account.
    watchdog.unref?.()

    return async () => {
      disposed = true
      clearInterval(watchdog)
      await removeIfUnchanged(registration)
    }
  }

  function alive(pid: number): boolean {
    try {
      // Signal 0 performs the existence and permission checks without delivering.
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * One health probe, classified.
   *
   * `busy` means the connection was accepted but no answer came in time — the
   * shape of a live service whose event loop is blocked. `down` is everything
   * that is definitely not a healthy service: refused, unreachable, or an answer
   * without `healthy: true`.
   */
  type Probe = { readonly state: "healthy"; readonly version: string } | { readonly state: "busy" | "down" }

  async function probe(url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Probe> {
    try {
      const response = await fetch(new URL("/global/health", url), {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return { state: "down" }
      const body = (await response.json()) as { healthy?: boolean; version?: string }
      if (body.healthy !== true) return { state: "down" }
      return { state: "healthy", version: typeof body.version === "string" ? body.version : "" }
    } catch (error) {
      return { state: (error as { name?: unknown } | undefined)?.name === "TimeoutError" ? "busy" : "down" }
    }
  }

  /**
   * Probe until the answer is final: a refusal is final at once, a timeout only
   * once it has lasted `BUSY_GRACE_MS`. A crashed service costs no extra wait;
   * a busy one is not written off for a single slow answer.
   */
  async function probeWithGrace(url: string): Promise<Probe> {
    const deadline = Date.now() + BUSY_GRACE_MS
    while (true) {
      const result = await probe(url)
      if (result.state !== "busy" || Date.now() >= deadline) return result
      await Bun.sleep(POLL_INTERVAL_MS)
    }
  }

  /** `undefined` when the server does not answer; never throws. */
  export async function health(url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<{ version: string } | undefined> {
    const result = await probe(url, timeoutMs)
    return result.state === "healthy" ? { version: result.version } : undefined
  }

  /**
   * The live service for this channel, or `undefined`.
   *
   * Believed only after the file parses, the pid is alive and health answers —
   * cheapest check first. Anything else means the entry is stale, and a stale
   * entry is removed rather than reported: a machine that crashed mid-session
   * must start cleanly, not fail. A service that is only slow to answer gets
   * `BUSY_GRACE_MS` first, because removing its entry evicts it.
   */
  export async function discover(): Promise<Registration | undefined> {
    const registration = await readRegistration()
    if (!registration) return undefined
    if (!alive(registration.pid)) {
      log.info("removing stale registration (process gone)", { pid: registration.pid })
      await removeIfUnchanged(registration)
      return undefined
    }
    const result = await probeWithGrace(registration.url)
    if (result.state !== "healthy") {
      log.info("removing stale registration (unhealthy)", {
        pid: registration.pid,
        url: registration.url,
        health: result.state,
      })
      await removeIfUnchanged(registration)
      return undefined
    }
    return { ...registration, version: result.version || registration.version }
  }

  /**
   * The argv that re-runs this same build.
   *
   * A standalone executable is its own interpreter; from source the interpreter
   * is bun and the entry has to be passed along or the child starts a REPL.
   */
  function selfCommand(extra: string[]): string[] {
    if (Installation.isStandaloneExecutable()) return [process.execPath, ...extra]
    const entry = process.argv[1]
    if (!entry) throw new Error("cannot locate the nikcli entrypoint to spawn a background service")
    return [process.execPath, entry, ...extra]
  }

  async function acquireLock(): Promise<boolean> {
    await fs.mkdir(path.dirname(lockPath()), { recursive: true })
    try {
      // `wx` fails if the file exists, which is the atomic part.
      const handle = await fs.open(lockPath(), "wx")
      await handle.writeFile(String(process.pid))
      await handle.close()
      return true
    } catch {
      // A lock older than a whole start timeout belongs to a client that died
      // mid-spawn. Leaving it would wedge every later start.
      try {
        const stat = await fs.stat(lockPath())
        if (Date.now() - stat.mtimeMs > START_TIMEOUT_MS) {
          log.warn("removing abandoned service lock", { ageMs: Date.now() - stat.mtimeMs })
          await fs.rm(lockPath(), { force: true })
          return acquireLock()
        }
      } catch {}
      return false
    }
  }

  async function releaseLock(): Promise<void> {
    await fs.rm(lockPath(), { force: true }).catch(() => {})
  }

  async function waitFor(predicate: () => Promise<Registration | undefined>, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await predicate()
      if (found) return found
      await Bun.sleep(POLL_INTERVAL_MS)
    }
    return undefined
  }

  /**
   * Spawn a service and wait for it to register.
   *
   * `detached` puts the child in its own process group, so a Ctrl+C aimed at the
   * client's foreground group does not reach it; every stdio stream is ignored,
   * because a daemon whose stdout stays piped to a parent that then exits takes
   * EPIPE on its next write.
   */
  export async function start(): Promise<Registration> {
    const held = await acquireLock()
    if (!held) {
      // Someone else is spawning. Wait for their service rather than starting a
      // second engine.
      const found = await waitFor(discover, START_TIMEOUT_MS)
      if (found) return found
      throw new Error("timed out waiting for another client to start the background service")
    }

    try {
      // The caller's `discover()` ran before the lock was ours, so whoever held
      // it may have finished in between. Spawning anyway would start a second
      // engine whose registration evicts the one just started.
      const raced = await discover()
      if (raced) {
        if (versionBelongsToChannel(raced.version)) return raced
        await stop()
      }

      // Imported here, not at module scope: `config.ts` imports this module
      // back, and a client that only discovers a running service never needs it.
      const { ServiceConfig } = await import("./config")
      const settings = await ServiceConfig.read()
      const args = [
        "serve",
        "--service",
        "--port",
        String(settings.port ?? defaultPort()),
        "--hostname",
        settings.hostname ?? "127.0.0.1",
      ]
      for (const origin of settings.cors ?? []) args.push("--cors", origin)
      const command = selfCommand(args)
      log.info("starting background service", { command })
      const child = Bun.spawn(command, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        // Not the spawning client's directory. The service outlives it and
        // serves every project; requests name their own directory, and a
        // project cwd would leak into whatever still falls back to it — and pin
        // a directory that may later be deleted or sit on an unmounted volume.
        cwd: os.homedir(),
        env: { ...process.env, ...settings.env },
      })
      child.unref()

      const found = await waitFor(discover, START_TIMEOUT_MS)
      if (!found) {
        child.kill()
        throw new Error(`background service did not become healthy within ${START_TIMEOUT_MS}ms`)
      }
      return found
    } finally {
      await releaseLock()
    }
  }

  /**
   * The service to talk to, starting one if needed.
   *
   * Version skew is restarted, not tolerated: both sides of the HTTP contract are
   * generated from the same source tree, so a client must never drive a service
   * built from different code.
   */
  export async function ensure(): Promise<Registration> {
    const existing = await discover()
    if (existing) {
      if (versionBelongsToChannel(existing.version)) return existing
      log.info("restarting background service for version mismatch", {
        service: existing.version,
        client: Installation.VERSION,
      })
      await stop()
    }
    return start()
  }

  /**
   * Whether the process behind `registration` is provably the service.
   *
   * A registration outlives a crash, and the OS reuses pids: a live pid alone
   * may be any process of this user's. The registered URL answering health
   * with the registered version ties the pid to the service. `busy` is taken
   * as the service too — something is holding the registered port and not
   * answering, which is a wedged service, the case `stop` exists for.
   */
  function verified(registration: Registration, result: Probe): boolean {
    if (result.state !== "healthy") return result.state === "busy"
    return registration.version === "" || result.version === registration.version
  }

  /** `false` when there was nothing to stop. */
  export async function stop(): Promise<boolean> {
    const registration = await readRegistration()
    if (!registration) return false
    if (!alive(registration.pid)) {
      await removeIfUnchanged(registration)
      return false
    }
    if (!verified(registration, await probeWithGrace(registration.url))) {
      log.warn("registered service does not answer as itself; leaving its pid alone", {
        pid: registration.pid,
        url: registration.url,
      })
      await removeIfUnchanged(registration)
      return false
    }

    // SIGTERM, not SIGKILL: `serve` handles it by suspending live sessions so
    // the next start can resume them.
    try {
      process.kill(registration.pid, "SIGTERM")
    } catch {
      await removeIfUnchanged(registration)
      return false
    }

    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!alive(registration.pid)) {
        await removeIfUnchanged(registration)
        return true
      }
      await Bun.sleep(POLL_INTERVAL_MS)
    }

    log.warn("background service did not exit on SIGTERM; sending SIGKILL", { pid: registration.pid })
    try {
      process.kill(registration.pid, "SIGKILL")
    } catch {}
    await removeIfUnchanged(registration)
    return true
  }

  export interface Status {
    readonly running: boolean
    readonly registration?: Registration
    readonly versionMatches?: boolean
    readonly channel: string
    readonly file: string
  }

  export async function status(): Promise<Status> {
    const registration = await discover()
    const base = { channel: Installation.CHANNEL, file: registrationPath() }
    if (!registration) return { running: false, ...base }
    return {
      running: true,
      registration,
      versionMatches: versionBelongsToChannel(registration.version),
      ...base,
    }
  }
}

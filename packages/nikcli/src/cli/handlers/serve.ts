import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { Server } from "@/server/server"
import { resolveNetworkOptions } from "@/cli/network"
import { Flag } from "@nikcli-ai/util/flag"
import { Workspace } from "@/workspace"
import { Project } from "@/project/project"
import { Installation } from "@/installation"
import { Log } from "@nikcli-ai/util/log"
import { BrowserControl } from "@/browser-control/browser-control"
import { errorMessage } from "@nikcli-ai/util/error-format"
import { Effect } from "effect"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { PromptState } from "@/session/prompt-state"
import { SessionRepo } from "@/session/repo"
import { Auth } from "@/server/httpapi/auth"

export const log = Log.create({ service: "serve" })

export function runProject<A, E>(effect: Effect.Effect<A, E, Project.Service>) {
  return runPromiseWithLayer(Project.defaultLayer, effect)
}

export async function maybeStartRemoteSync(): Promise<{ stop(): Promise<void> } | undefined> {
  const { SyncConfig } = await import("@/sync/sync-config")
  const resolved = await SyncConfig.resolve()
  if (!resolved.url || !resolved.token) return undefined
  // Lazy import to avoid pulling the remote client into the local-only path
  const { SyncCliInit } = await import("@/sync/cli-init")
  return SyncCliInit.startForAllProjects({
    url: resolved.url,
    token: resolved.token,
  })
}

/**
 * Resume the sessions a previous server suspended when it shut down
 * gracefully.
 *
 * Claiming and clearing happen in one statement, so two servers racing on the
 * same data directory resume each session exactly once. The resume itself is
 * advisory: `loop` re-derives continuation from projected history, so a turn
 * that already finished is a no-op and one that did not continues from its
 * last durable step. See `specs/v2/session-restart-continuation.md`.
 */
export async function resumeSuspendedSessions(): Promise<number> {
  const claimed = Effect.runSync(SessionRepo.consumeSuspended())
  if (claimed.length === 0) return 0

  const { InstanceBootstrap } = await import("@/project/bootstrap")
  const { SessionPrompt } = await import("@/session/prompt")
  const { withInstanceAsync } = await import("@/effect")

  for (const { id, directory } of claimed) {
    // Fire and forget: a resumed turn can run for minutes, and startup must
    // not wait on it. Failures are logged, never fatal — the server is up
    // either way, and the transcript is durable either way.
    void withInstanceAsync({ directory, init: InstanceBootstrap }, async () =>
      runPromiseWithLayer(
        SessionPrompt.defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            const sessionPrompt = yield* SessionPrompt.Service
            return yield* sessionPrompt.loop(id)
          }),
        ),
      ),
    ).catch((error) => {
      log.warn("resume failed", { sessionID: id, error })
    })
  }
  log.info("resuming suspended sessions", { count: claimed.length })
  return claimed.length
}

/**
 * Mark everything this process is running as suspended, so the next server
 * picks it up.
 *
 * Deliberately synchronous and first in the shutdown path: it must land before
 * the aborts, and it must not compete with the 5s force-exit timer.
 */
export function suspendActiveSessions(): number {
  try {
    const ids = PromptState.activeSessions()
    if (ids.length === 0) return 0
    Effect.runSync(SessionRepo.suspend(ids))
    log.info("suspended active sessions", { count: ids.length })
    return ids.length
  } catch (error) {
    // Never block shutdown on this. A missed suspension costs a turn, the
    // same as today; a thrown shutdown costs the drain.
    log.warn("suspend failed", { error })
    return 0
  }
}

/**
 * Probe the public health endpoint until the full route stack (middleware
 * chain included) answers, so `serve` only reports readiness once the server
 * actually responds — not merely once the socket is bound. `/global/health`
 * is a public path (httpapi/auth.ts), so the probe works regardless of
 * NIKCLI_SERVER_PASSWORD.
 */
export async function waitForHealthy(url: URL, timeoutMs = 10_000): Promise<void> {
  const health = new URL("/global/health", url)
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(health, {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return
      lastError = new Error(`health check returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(50)
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms: ${lastError}`)
}

/**
 * Resolves on the first SIGINT/SIGTERM so graceful cleanup runs. A second
 * signal force-exits immediately in case cleanup wedges.
 */
export function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    let intercepted = false
    const handler = () => {
      if (intercepted) process.exit(1)
      intercepted = true
      resolve()
    }
    process.on("SIGINT", handler)
    process.on("SIGTERM", handler)
  })
}

export default Runtime.handler(Commands.commands["serve"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    port: input["port"],
    hostname: input["hostname"],
    mdns: input["mdns"],
    cors: [...input["cors"]],
    stdio: input["stdio"],
    service: input["service"],
  }
  const opts = await resolveNetworkOptions(args as Parameters<typeof resolveNetworkOptions>[0])
  // In --stdio mode stdout carries only the machine-readable handshake;
  // all diagnostics go to stderr.
  const warn = args.stdio ? console.error : console.log

  const loopback = opts.hostname === "127.0.0.1" || opts.hostname === "::1" || opts.hostname === "localhost"
  const tailscaleAuthActive = Flag.NIKCLI_SERVER_TAILSCALE_AUTH && loopback

  if (Flag.NIKCLI_SERVER_TAILSCALE_AUTH && !loopback) {
    warn(
      "Warning: NIKCLI_SERVER_TAILSCALE_AUTH is set but hostname is not loopback; Tailscale identity headers will not be trusted.",
    )
  }

  // The shared service is never unauthenticated. It reads the channel's
  // password itself — the file its clients read too — and adopts it before
  // the socket exists, so there is no moment it answers without one.
  if (args.service) {
    const { BackgroundService } = await import("@/service/service")
    Auth.useServicePassword(await BackgroundService.password())
  } else if (!Flag.NIKCLI_SERVER_PASSWORD && !tailscaleAuthActive) {
    warn("Warning: NIKCLI_SERVER_PASSWORD is not set; server is unsecured.")
  }

  const server = Server.listen(opts)
  // Announce the address only once the server has answered a real request, so
  // a broken route table surfaces here instead of on the client's first call.
  // If readiness probing fails, stop the server before propagating the error
  // so we don't leak a bound-but-unhealthy listener.
  try {
    await waitForHealthy(server.url)
  } catch (error) {
    await server.stop(true).catch(() => undefined)
    throw error
  }
  if (args.stdio) {
    console.log(JSON.stringify({ url: server.url.origin }))
  } else {
    console.log(`nikcli server listening on http://${server.hostname}:${server.port}`)
  }

  // Published only after the health probe above, so a client that discovers a
  // registration can rely on the route stack already answering. The service
  // owns this file rather than its spawner: it is the only party that knows
  // which port it actually got, and the only one that can remove the file on
  // a clean exit. See `specs/background-service.md`.
  let releaseRegistration: (() => Promise<void>) | undefined
  if (args.service) {
    const { BackgroundService } = await import("@/service/service")
    // The watchdog's callback is how two services for one channel stop
    // coexisting: whoever loses the registration stands down instead of
    // lingering as a second engine nobody talks to.
    releaseRegistration = await BackgroundService.register(server.url.origin, () => {
      warn("another nikcli service took over this channel; shutting down")
      process.kill(process.pid, "SIGTERM")
    })
  }

  let workspaceSync: Array<ReturnType<typeof Workspace.startSyncing>> = []
  let remoteSync: Awaited<ReturnType<typeof maybeStartRemoteSync>>
  try {
    if (Installation.isLocal()) {
      const projects = await runProject(
        Effect.gen(function* () {
          const project = yield* Project.Service
          return yield* project.list()
        }),
      )
      workspaceSync = projects.map((project) => Workspace.startSyncing(project))
    }

    // Phase 2: optional bidirectional sync to a remote hub
    // (e.g. https://s.nikcli-ai.dev). Activated by NIKCLI_REMOTE_URL +
    // NIKCLI_REMOTE_TOKEN or the config file's `sync` block. Zero impact
    // when neither is set.
    remoteSync = await maybeStartRemoteSync()
  } catch (error) {
    // The registration is already out. Withdraw it before failing, or clients
    // keep discovering a server that never finished starting.
    if (releaseRegistration) await releaseRegistration()
    throw error
  }

  await resumeSuspendedSessions().catch((error) => {
    log.warn("resume sweep failed", { error })
  })

  await waitForShutdownSignal()

  // Suspend before anything interrupts: instance disposal aborts every live
  // controller, and a session marked after that is a session already lost.
  suspendActiveSessions()

  // Graceful shutdown: close keep-alive connections (SSE streams hold
  // sockets open and would otherwise hang the exit), then stop sync
  // services. Force-exit if any of this hangs for more than 5s.
  log.info("shutting down")
  warn("shutting down...")
  // Before the drain, not after: a client probing during a slow shutdown must
  // see "gone" rather than connect to a server that is closing. Ownership is
  // checked inside, so an instance that was already replaced does not delete
  // its successor's entry on the way out.
  if (releaseRegistration) await releaseRegistration()
  const force = setTimeout(() => {
    console.error("graceful shutdown timed out, forcing exit")
    process.exit(1)
  }, 5_000)
  try {
    // The pairing listener is a second socket on this process; the main
    // server's stop does not know about it.
    await Server.stopMobile()
    await server.stop(true)
    if (remoteSync) await remoteSync.stop()
    await Promise.all(workspaceSync.map((item) => item.stop()))
    // Stop the browser-control daemons so their Chromium/WebView children
    // die with the server instead of being reaped only by the 10-minute
    // idle timer (or, worse, never — when sessions outlive `serve`).
    // `serve` stands in no instance scope, so `closeAll()` resolves this
    // process's own workspace from `process.cwd()`, and closes every other
    // workspace a session reached a daemon for as well.
    await BrowserControl.closeAll().catch((error) => {
      log.warn("browser-control shutdown failed", {
        error: errorMessage(error),
      })
    })
  } finally {
    clearTimeout(force)
  }
  process.exit(0)
})

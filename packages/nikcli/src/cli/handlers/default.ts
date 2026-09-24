import { Option } from "effect"
import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { Rpc } from "@tui/util/rpc"
import { type rpc } from "@/cli/cmd/tui/worker"
import path from "path"
import { UI } from "@/cli/ui"
import { localPluginHost } from "@/cli/cmd/tui/plugin/host-local"
import { TuiConfig } from "@/config/tui"
import { iife } from "@nikcli-ai/util/iife"
import { Log } from "@nikcli-ai/util/log"
import { resolveNetworkOptions, shouldStartHttpServer } from "@/cli/network"
import { createNikcliClient, type Event } from "@nikcli-ai/sdk/httpapi"
import type { EventSource } from "@nikcli-ai/tui/context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "@nikcli-ai/util/win32"
import { errorMessage } from "@nikcli-ai/util/error-format"
import { HerdrBridge } from "@nikcli-ai/util/herdr-bridge"
import { Process } from "@nikcli-ai/util/process"
import { SessionPrimitives } from "@nikcli-ai/util/session-primitives"

declare global {
  const NIKCLI_WORKER_PATH: string
}

export type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

export const WORKER_SHUTDOWN_TIMEOUT_MS = 5_000

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: Timer | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
      timeout.unref?.()
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

export function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

export function createEventSource(client: RpcClient): EventSource {
  // The worker forwards every GlobalBus event over the "global.event" RPC
  // channel with its {directory, payload} envelope intact, so the TUI sees
  // events from every instance (root + worktree workspaces) — same contract
  // as the HTTP /global/event stream.
  return {
    subscribe: async (_directory, handler) => {
      const unsub = client.on<{ directory?: string; payload: Event }>("global.event", (envelope) => {
        if (!envelope?.payload?.type) return
        handler(envelope)
      })
      return unsub
    },
  }
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = path.resolve(envPWD ?? cwd)
  if (!project) return path.resolve(cwd)
  return path.resolve(path.isAbsolute(project) ? project : path.join(root, project))
}

export function createWorkerEnv(overrides: Record<string, string> = {}) {
  return Process.sanitizedEnv({
    [Process.ROLE_ENV]: "worker",
    [Process.RUN_ID_ENV]: Process.ensureRunID(),
    // One log per session: the worker appends to ours instead of truncating it.
    ...(Log.file() ? { [Log.FILE_ENV]: Log.file() } : {}),
    ...overrides,
  })
}

export function shouldTerminateWorker(platform = process.platform): boolean {
  return platform !== "win32"
}

/**
 * The slice of a worker handle this module drives.
 *
 * `unref` is optional because it is a Bun extension that the DOM `Worker` type
 * does not declare; `terminate` is required so a bare `{ unref }` object cannot
 * pass for a worker. Naming the shape also removes the assertion this function
 * used to need.
 */
export type WorkerHandle = {
  terminate: () => void
  unref?: () => void
}

export function releaseWorkerWithoutTermination(worker: WorkerHandle): void {
  worker.unref?.()
}

export async function shutdownWorker(input: {
  shutdown: () => Promise<void>
  terminate: () => void
  release: () => void
  platform?: typeof process.platform
  timeoutMs?: number
}) {
  const terminate = shouldTerminateWorker(input.platform)
  if (!terminate) {
    input.release()
    void withTimeout(input.shutdown(), input.timeoutMs ?? WORKER_SHUTDOWN_TIMEOUT_MS).catch(() => undefined)
    return
  }
  try {
    await withTimeout(input.shutdown(), input.timeoutMs ?? WORKER_SHUTDOWN_TIMEOUT_MS)
  } finally {
    input.terminate()
  }
}

/**
 * How long the server worker may take to start listening before the TUI gives
 * up on it. A safety net, not a budget: a normal start is a few seconds, and
 * this only turns "waits forever on a worker that will never answer" into an
 * error the user can see. Generous on purpose, so a slow disk or a loaded
 * machine is never mistaken for a dead worker.
 */
export const WORKER_READY_TIMEOUT_MS = 120_000

/**
 * Fail the RPC client when its worker cannot answer any more.
 *
 * A request to a worker that exited — or crashed while loading, before it ever
 * listened — used to wait forever: `Rpc.client.call` has no timeout, and the
 * first bootstrap waiting on it kept the TUI from ever painting
 * (`specs/effect-tui/00-startup-hang.md`). Closing the client makes those calls
 * reject, and the bootstrap turns a failed essential request into a visible exit.
 *
 * `stopping` is checked so a worker we terminated ourselves is not reported as
 * a failure. Returns a disposer that stops supervising.
 */
export function superviseWorker(input: {
  worker: Pick<Worker, "addEventListener" | "removeEventListener">
  client: Pick<RpcClient, "ready" | "close">
  stopping: () => boolean
  readyTimeoutMs?: number
}): () => void {
  const timeoutMs = input.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS
  const onClose = (event: globalThis.Event) => {
    clearTimeout(timer)
    if (input.stopping()) return
    const code = (event as globalThis.Event & { code?: number }).code
    Log.Default.error("server worker exited", { code })
    input.client.close(new Error(`The nikcli server worker exited unexpectedly (code ${code ?? "unknown"})`))
  }
  const timer = setTimeout(() => {
    if (input.stopping()) return
    Log.Default.error("server worker did not start listening", { timeoutMs })
    input.client.close(new Error(`The nikcli server worker did not start within ${Math.round(timeoutMs / 1000)}s`))
  }, timeoutMs)
  timer.unref?.()
  void input.client.ready.then(() => clearTimeout(timer))
  input.worker.addEventListener("close", onClose)
  return () => {
    clearTimeout(timer)
    input.worker.removeEventListener("close", onClose)
  }
}

/** Attempt chdir for TUI thread bootstrap; false when the path is invalid. */
export function chdirToThreadDirectory(cwd: string): boolean {
  try {
    process.chdir(cwd)
    return true
  } catch {
    return false
  }
}

/** Change process cwd or exit 1 with a user-facing error (TUI thread entry). */
export function changeDirectoryOrExit(cwd: string): void {
  if (!chdirToThreadDirectory(cwd)) {
    UI.error("Failed to change directory to " + cwd)
    process.exit(1)
  }
}

export async function validateSession(input: {
  url: string
  sessionID?: string
  directory?: string
  fetch?: typeof fetch
}) {
  if (!input.sessionID) return

  const parsed = SessionPrimitives.ID.safeParse(input.sessionID)
  if (!parsed.success) {
    throw new Error(`Invalid session ID: ${input.sessionID}`)
  }

  await createNikcliClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
  }).session.get({ sessionID: parsed.data }, { throwOnError: true })
}

export default Runtime.handler(Commands, async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    port: input["port"],
    hostname: input["hostname"],
    mdns: input["mdns"],
    cors: [...input["cors"]],
    project: Option.getOrUndefined(input["project"]),
    standalone: input["standalone"],
    model: Option.getOrUndefined(input["model"]),
    continue: Option.getOrUndefined(input["continue"]),
    session: Option.getOrUndefined(input["session"]),
    prompt: Option.getOrUndefined(input["prompt"]),
    agent: Option.getOrUndefined(input["agent"]),
  }
  // Resolve relative paths against PWD to preserve behavior when using --cwd flag.
  const cwd = resolveThreadDirectory(args.project)
  // Three layouts, in the order they are tried below: a compiled binary (the
  // `NIKCLI_WORKER_PATH` define, resolved against the bunfs root), a published dist where this
  // command is inlined into the root entry, and a dev checkout where it is a sibling file.
  const localWorker = new URL("./worker.ts", import.meta.url)
  const distWorker = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  const workerPath = await iife(async () => {
    if (typeof NIKCLI_WORKER_PATH !== "undefined") return NIKCLI_WORKER_PATH
    if (await Bun.file(distWorker).exists()) return distWorker
    return localWorker
  })
  try {
    process.chdir(cwd)
  } catch {
    UI.error("Failed to change directory to " + cwd)
    process.exit(1)
  }

  // Background-service path — the default.
  //
  // The engine graph — ~23K FunctionExecutable and ~125MB of JS heap — is
  // evaluated once per machine in a long-lived server instead of once per
  // invocation in this process *and* again in its worker isolate. There is no
  // worker here at all: the client is a plain HTTP consumer, exactly the shape
  // `nikcli attach <url>` has always run in.
  //
  // Kept as an early return rather than threaded through the worker setup
  // below: the two paths share nothing but the `tui()` call itself, and
  // conflating them is how the private path would quietly acquire a
  // regression. See `specs/background-service.md`.
  //
  // Default on, as in opencode: `--standalone` (or `NIKCLI_SERVICE=0`) takes
  // the private in-process path instead. Drive mode is always private — its
  // deterministic mock lives in this process and the worker is routed to it.
  // Explicit network options mean the caller wants their *own* listener, so
  // they keep the path that starts one.
  const wantsOwnServer = shouldStartHttpServer(
    await resolveNetworkOptions(args as Parameters<typeof resolveNetworkOptions>[0]),
  )
  //
  // A test home opts out unless asked for explicitly: the service outlives the
  // client by design, so a suite that boots the TUI would leave one daemon per
  // test home behind — and stray nikcli processes are already a documented
  // source of bogus measurements and flaky runs.
  const testHome = Boolean(process.env.NIKCLI_TEST_HOME) && process.env.NIKCLI_SERVICE !== "1"
  const useService =
    !args.standalone && process.env.NIKCLI_SERVICE !== "0" && !process.env.NIKCLI_DRIVE && !wantsOwnServer && !testHome

  if (useService) {
    const { BackgroundService } = await import("@/service/service")
    const { localPluginHost } = await import("@/cli/cmd/tui/plugin/host-local")
    // A service that will not start must not take the TUI down with it: fall
    // through to the private path, loudly. The failure modes here are
    // environmental (a wedged port, a killed spawn), and a user who cannot
    // open their editor has a worse problem than a cold engine.
    // The password belongs to the connection: a service this client cannot
    // authenticate to is as unusable as one that did not start.
    const connection = await BackgroundService.ensure()
      .then(async (registration) => ({
        registration,
        fetch: BackgroundService.authorizedFetch(
          registration.url,
          BackgroundService.authorization(await BackgroundService.password()),
        ),
      }))
      .catch((error) => {
        Log.Default.warn("background service unavailable; falling back to a private in-process server", {
          error: errorMessage(error),
        })
        return undefined
      })
    if (connection) {
      const { registration } = connection
      Log.Default.info("using background service", { url: registration.url, pid: registration.pid })
      const { tui } = await import("@nikcli-ai/tui/app")
      const tuiConfig = await TuiConfig.get().catch(() => undefined)
      // Upgrade runs in *this* process, not the service: it replaces the
      // installed binary, and the service is a different (older) copy of it.
      // Imported inside the callbacks so the upgrade chain — and the instance
      // bootstrap it needs — stays out of the boot graph; both are rare,
      // user-initiated, and already slow.
      const withUpgradeInstance = async <T>(fn: () => Promise<T>): Promise<T> => {
        const { InstanceBootstrap } = await import("@/project/bootstrap")
        const { withInstanceAsync } = await import("@/effect")
        return withInstanceAsync({ directory: cwd, init: InstanceBootstrap }, fn)
      }

      await tui({
        url: registration.url,
        fetch: connection.fetch,
        pluginHost: localPluginHost,
        tuiConfig,
        directory: cwd,
        args: {
          continue: args.continue,
          sessionID: args.session,
          agent: args.agent,
          model: args.model,
          prompt: args.prompt,
        },
        checkUpgrade: async () => {
          return withUpgradeInstance(async () => {
            const { upgrade } = await import("@/cli/upgrade")
            return upgrade()
          }).catch((error) => {
            Log.Default.debug("upgrade check failed", { error: errorMessage(error) })
            return undefined
          })
        },
        upgradeNow: async (method: string, version: string) => {
          await withUpgradeInstance(async () => {
            const { upgradeNow } = await import("@/cli/upgrade")
            await upgradeNow(method as import("@/installation").Installation.Method, version)
          })
        },
      })
      return
    }
  }

  // Drive mode: the deterministic OpenAI mock and the driver control
  // websocket run in this (TUI) process; the worker is routed to them via
  // NIKCLI_CONFIG_CONTENT so its default model resolves against the mock.
  const simulation = await iife(async () => {
    if (!process.env.NIKCLI_DRIVE) return undefined
    // Resolve the @napi-rs/canvas CJS binding before `./app` loads
    // TuiPluginRuntime: OpenTUI's runtime Bun plugin registers a catch-all
    // async onLoad, after which require() of a not-yet-cached CJS dep
    // fails. Only the binding is preloaded (dependency-free module) — the
    // frontend graph itself must load *after* the plugin so the harness
    // and the app share one rewritten module graph.
    const canvas = await import("@nikcli-ai/simulation/frontend/canvas")
    canvas.preload()
    const { SimulationBackend, simulationWorkerEnv } = await import("@nikcli-ai/simulation/backend")
    const backend = await SimulationBackend.start()
    return { backend, env: simulationWorkerEnv(backend.openai) }
  })

  const worker = new Worker(workerPath, {
    env: createWorkerEnv(simulation?.env),
  })
  worker.onerror = (e) => {
    Log.Default.error("worker error", {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      error: e.error ? errorMessage(e.error) : undefined,
    })
  }
  const client = Rpc.client<typeof rpc>(worker)
  // The worker cannot bind the browser-control daemon itself: its sessions are
  // Bun.WebViews, and those only exist on a main thread. This is that thread.
  // Imported on demand — a session that never opens a browser should not pay
  // for the package (ffmpeg, evidence, renderers) during TUI startup.
  client.on<{ socket: string }>("browser-control.host-daemon", ({ socket }) => {
    import("@nikcli-ai/browser-control/daemon")
      .then(({ startDaemon }) => startDaemon(socket, { exitProcess: false }))
      .catch((e) => {
        Log.Default.error("browser-control daemon failed to bind", { error: errorMessage(e) })
      })
  })
  const error = (e: unknown) => {
    Log.Default.error("process error", { error: errorMessage(e) })
  }
  const reload = () => {
    client.call("reload", undefined).catch((error) => {
      Log.Default.warn("worker reload failed", {
        error: errorMessage(error),
      })
    })
  }
  process.on("uncaughtException", error)
  process.on("unhandledRejection", error)
  process.on("SIGUSR2", reload)

  let stopped = false
  const unsupervise = superviseWorker({ worker, client, stopping: () => stopped })
  const stop = async () => {
    if (stopped) return
    stopped = true
    unsupervise()
    process.off("uncaughtException", error)
    process.off("unhandledRejection", error)
    process.off("SIGUSR2", reload)
    // Bound shutdown on every platform. Windows releases the worker without
    // terminating it so MCP subprocess teardown cannot detach the console.
    await shutdownWorker({
      shutdown: async () => {
        await client.call("shutdown", undefined)
      },
      terminate: () => worker.terminate(),
      release: () => releaseWorkerWithoutTermination(worker),
    }).catch((error) => {
      Log.Default.warn("worker shutdown failed", {
        error: errorMessage(error),
      })
    })
    // The worker owns the herdr plugin, but on Windows its shutdown is
    // fire-and-forget (see shutdownWorker), so the plugin's dispose is cut
    // off before it can hand the pane back. This is the process that is
    // actually about to exit, so release from here. Synchronous and
    // idempotent; a no-op outside a herdr pane.
    HerdrBridge.releasePaneSync()
    simulation?.backend.stop()
  }

  const restart = async () => {
    await stop()
    process.exitCode = 0
    // Re-exec the current process with the same arguments
    Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      windowsHide: true,
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
      detached: true,
    })
    process.exit(0)
  }

  // Mobile (and any nikcli-managed PTY) sets NIKCLI_TERMINAL=1 in env. Bun can still report
  // `stdin.isTTY === false` in that PTY, which would incorrectly take the "piped stdin" path
  // below and block forever on `Bun.stdin.text()` — so the OpenTUI renderer never starts.
  const stdinProbablyInteractive = process.stdin.isTTY || process.env.NIKCLI_TERMINAL === "1"

  const prompt = await iife(async () => {
    const piped = stdinProbablyInteractive ? undefined : await Bun.stdin.text()
    if (!args.prompt) return piped
    return piped ? piped + "\n" + args.prompt : args.prompt
  })

  const networkOpts = await resolveNetworkOptions(args as Parameters<typeof resolveNetworkOptions>[0])
  const shouldStartServer = shouldStartHttpServer(networkOpts)

  let url: string
  let customFetch: typeof fetch | undefined
  let events: EventSource | undefined

  if (shouldStartServer) {
    // Start HTTP server for external access
    const server = await client.call("server", networkOpts)
    url = server.url
  } else {
    // Use direct RPC communication (no HTTP)
    url = "http://nikcli.local"
    customFetch = createWorkerFetch(client)
    events = createEventSource(client)
  }

  try {
    await validateSession({
      url,
      sessionID: args.session,
      directory: cwd,
      fetch: customFetch,
    })
  } catch (error) {
    UI.error(errorMessage(error))
    process.exitCode = 1
    await stop()
    return
  }

  const unguard = win32InstallCtrlCGuard()
  try {
    win32DisableProcessedInput()

    const { tui } = await import("@nikcli-ai/tui/app")
    // Read here, not in the terminal: it feeds the renderer config, so it is
    // needed before any transport exists. See `tui()`'s `tuiConfig` prop.
    const tuiConfig = await TuiConfig.get().catch(() => undefined)

    const tuiPromise = tui({
      url,
      pluginHost: localPluginHost,
      tuiConfig,
      directory: cwd,
      fetch: customFetch,
      events,
      args: {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
      },
      onExit: stop,
      onRestart: restart,
      checkUpgrade: async () => {
        return client.call("checkUpgrade", { directory: cwd }).catch((error) => {
          Log.Default.warn("upgrade check failed", {
            error: errorMessage(error),
          })
          return undefined
        })
      },
      upgradeNow: async (method: string, version: string) => {
        // Re-throw worker errors so the TUI toast in app.tsx can show the
        // real reason. Without this, a failed upgrade silently disappears:
        // the toast "Updating to v..." shows for 30s and the user is left
        // with the old version and no explanation. The RPC layer preserves
        // UpgradeFailedError.stderr across the worker hop (see
        // test/tui/rpc-error.test.ts), so the toast only needs the error
        // to actually reach it.
        await client.call("upgradeNow", { directory: cwd, method, version }).catch((error) => {
          Log.Default.error("upgrade failed", {
            error: errorMessage(error),
          })
          throw error
        })
      },
      startServer: !shouldStartServer
        ? async (options = {}) => {
            const result = await client.call("server", {
              port: options.port ?? 0,
              hostname: options.hostname ?? "127.0.0.1",
              mdns: options.mdns,
            })
            return result.url
          }
        : undefined,
    })

    try {
      await tuiPromise
    } finally {
      await stop()
    }
  } finally {
    unguard?.()
  }
})

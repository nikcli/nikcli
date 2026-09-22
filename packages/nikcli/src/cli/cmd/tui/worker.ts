import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@nikcli-ai/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { withInstanceAsync } from "@/effect"
import { Rpc } from "@tui/util/rpc"
import { setMainThreadDaemonHost } from "@nikcli-ai/browser-control/daemon-client"
import { upgrade, upgradeNow } from "@/cli/upgrade"
import { GlobalBus } from "@nikcli-ai/util/global-bus"
import { createNikcliClient, type Event } from "@nikcli-ai/sdk/httpapi"
import { Process } from "@nikcli-ai/util/process"
import { IslandBridge } from "@nikcli-ai/util/island-bridge"
import { BrowserControl } from "@/browser-control/browser-control"
import { errorMessage } from "@nikcli-ai/util/error-format"
import { Diagnostics } from "@/cli/diagnostics"

Process.ensureMetadata("worker")

// The session runs here, not on the main thread, so a CPU profile of the main
// process would miss every token of streaming work. Arm the worker separately.
Diagnostics.listen()

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

// Browser sessions live in a Bun.WebView, which cannot be constructed on a
// worker thread. This is the worker, so the daemon that owns those views has to
// be bound by the TUI process's main thread instead; it answers on the same
// socket, so nothing else about the client changes.
setMainThreadDaemonHost((socket) => Rpc.emit("browser-control.host-daemon", { socket }))

let server: ReturnType<typeof Server.listen> | undefined
let shuttingDown: Promise<void> | undefined

const eventStreams = new Map<string, AbortController>()

function startEventStream(directory: string) {
  const id = crypto.randomUUID()
  const abort = new AbortController()
  eventStreams.set(id, abort)
  const signal = abort.signal

  const sdk = createNikcliClient({
    baseUrl: "http://nikcli.local",
    directory,
    fetch: Server.localFetch,
    signal,
  })

  ;(async () => {
    while (!signal.aborted) {
      const events = await Promise.resolve(
        sdk.event.subscribe(
          {},
          {
            signal,
          },
        ),
      ).catch(() => undefined)

      if (!events) {
        await Bun.sleep(250)
        continue
      }

      try {
        for await (const event of events.stream) {
          Rpc.emit("event", { id, event: event as Event })
        }
      } catch (error) {
        // A dropped stream must not kill the subscription loop — log and reconnect.
        if (signal.aborted) return
        Log.Default.warn("event stream interrupted, reconnecting", {
          error: error instanceof Error ? error.message : error,
        })
      }

      if (!signal.aborted) {
        await Bun.sleep(250)
      }
    }
  })().catch((error) => {
    if (signal.aborted) return
    Log.Default.error("event stream error", {
      error: error instanceof Error ? error.message : error,
    })
  })

  return id
}

function stopEventStream(id: string) {
  eventStreams.get(id)?.abort()
  eventStreams.delete(id)
}

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const response = await Server.localFetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
    })
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (shuttingDown) {
      await shuttingDown
      shuttingDown = undefined
    }
    if (server) await server.stop(true)
    server = Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    // Returns the result rather than relying on the published event: the TUI
    // runs on the other side of this RPC hop and `Bus` does not cross it in
    // the background-service path. See `upgrade()`'s doc.
    return withInstanceAsync({ directory: input.directory, init: InstanceBootstrap }, async () => {
      return upgrade().catch((error) => {
        Log.Default.debug("upgrade check failed", {
          error: error instanceof Error ? error.message : String(error),
        })
        return undefined
      })
    })
  },
  async upgradeNow(input: { directory: string; method: string; version: string }) {
    await withInstanceAsync({ directory: input.directory, init: InstanceBootstrap }, async () => {
      await upgradeNow(input.method as Installation.Method, input.version)
    })
  },
  async reload() {
    await Instance.disposeAll()
  },
  async subscribe(input: { directory: string | undefined }) {
    return startEventStream(input.directory || process.cwd())
  },
  async unsubscribe(input: { id: string }) {
    stopEventStream(input.id)
  },
  async shutdown() {
    const shutdown = (shuttingDown ??= (async () => {
      Log.Default.info("worker shutting down")
      for (const id of eventStreams.keys()) {
        stopEventStream(id)
      }
      // Stop the browser-control daemons (and any Chromium/WebView children
      // they spawned) before tearing the HTTP server and Instances down.
      // `closeAll()` sweeps every workspace this process resolved a socket
      // for, so it does not depend on standing in an instance scope — this
      // RPC handler stands in none.
      await BrowserControl.closeAll().catch((error) => {
        Log.Default.warn("browser-control shutdown failed", {
          error: errorMessage(error),
        })
      })
      await Instance.disposeAll()
      // The pairing listener is a second socket this process may have opened;
      // the main server's stop does not know about it.
      await Server.stopMobile()
      if (server) {
        const current = server
        server = undefined
        current.stop(true)
      }
      // Explicit, not process.on("exit", ...): this worker's own `process` is
      // shared with the parent thread, so an "exit" listener here would fire
      // on the wrong signal (see IslandBridge.stop()'s doc for how this was
      // found). This IS the real, deterministic end of this worker's life.
      IslandBridge.stop()
    })())
    await shutdown
    if (shuttingDown === shutdown) shuttingDown = undefined
  },
}

Rpc.listen(rpc)

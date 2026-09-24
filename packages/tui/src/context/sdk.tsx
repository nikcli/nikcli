import { createNikcliClient, type Event } from "@nikcli-ai/sdk/httpapi"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { createWakeDedup, type WakeDedup } from "../util/wake-dedup"
import { createQueueMeter } from "../util/event-queue-meter"
import { Log } from "@nikcli-ai/util/log"
import { reconnectDelay, sleepUnlessAborted } from "../util/reconnect"

const log = Log.create({ service: "tui.sdk" })

/**
 * Depth at which the client's event batch is reported as overloaded. Chosen to
 * sit far above a normal streaming burst (a fast turn flushes tens of
 * envelopes per 16 ms window) so that crossing it means the consumer is not
 * keeping up, not that the model is answering quickly.
 */
const EVENT_QUEUE_OVERLOAD = 2048

/**
 * GlobalBus envelope as forwarded by `/global/event` (HTTP mode) and the
 * worker's `global.event` RPC channel (embedded mode). `directory` is the
 * instance directory the event was published on — worktree instances carry
 * their worktree path here, which is how workspace-session events are told
 * apart from root-instance events (opencode parity: the TUI listens to the
 * global stream and filters client-side, instead of an instance-scoped SSE
 * that would never see worktree events).
 */
export type GlobalEnvelope = {
  directory?: string
  payload: Event
}

export type EventSource = {
  subscribe: (directory: string | undefined, handler: (event: GlobalEnvelope) => void) => Promise<() => void>
}

/**
 * Liveness of the event stream backing the TUI.
 *
 * `connecting` is the pre-first-connect state the startup screen already covers,
 * so only `reconnecting` is worth interrupting the user for — see
 * `component/reconnecting.tsx`. Embedded (worker) mode has no reconnect loop:
 * it reports `connected` once the RPC subscription is live and never leaves it.
 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting"

/**
 * Runs the update check once the TUI is actually up, and hands back what it
 * found so the caller can open the dialog. The result is returned rather than
 * awaited for an event: the check runs in the CLI process, not in the server
 * this stream comes from.
 */
export async function checkUpgradeWhenSubscriptionReady<T>(
  subscriptionReady: Promise<void>,
  checkUpgrade: (() => Promise<T>) | undefined,
): Promise<T | undefined> {
  await subscriptionReady
  return checkUpgrade?.()
}

export async function consumeGlobalEventStream(input: {
  stream: AsyncIterable<GlobalEnvelope>
  signal: AbortSignal
  onConnected: () => void
  onEnvelope: (envelope: GlobalEnvelope) => void
}) {
  for await (const envelope of input.stream) {
    if (input.signal.aborted) break
    try {
      if (envelope?.payload?.type === "server.connected") input.onConnected()
      input.onEnvelope(envelope)
    } catch (error) {
      console.error("[sse]", "handleEnvelope threw", error)
    }
  }
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { url: string; directory?: string; fetch?: typeof fetch; events?: EventSource }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    function createSDK() {
      return createNikcliClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
      })
    }

    let sdk = createSDK()
    let resolveSubscriptionReady!: () => void
    const subscriptionReady = new Promise<void>((resolve) => {
      resolveSubscriptionReady = resolve
    })
    let subscriptionReadyResolved = false
    const markSubscriptionReady = () => {
      if (subscriptionReadyResolved) return
      subscriptionReadyResolved = true
      resolveSubscriptionReady()
    }

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    const envelopeHandlers = new Set<(envelope: GlobalEnvelope) => void>()

    // Liveness of the event stream, surfaced so the app can tell the user the
    // TUI is waiting on the server rather than hung. `attempt` counts
    // consecutive failed reconnects and resets on every successful connect.
    const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>("connecting")
    const [connectionAttempt, setConnectionAttempt] = createSignal(0)
    const [connectionError, setConnectionError] = createSignal<string | undefined>(undefined)

    const markConnected = () => {
      batch(() => {
        setConnectionStatus("connected")
        setConnectionAttempt(0)
        setConnectionError(undefined)
      })
      markSubscriptionReady()
    }

    const markReconnecting = (error: unknown) => {
      batch(() => {
        setConnectionStatus("reconnecting")
        setConnectionAttempt((value) => value + 1)
        setConnectionError(error === undefined ? undefined : error instanceof Error ? error.message : String(error))
      })
    }

    let queue: GlobalEnvelope[] = []
    let timer: Timer | undefined
    let last = 0

    // The batch has no cap. Before one can be added, overload has to be
    // observable: a cap that silently drops a permission prompt or a final
    // outcome would trade correctness for a faster view.
    const queueMeter = createQueueMeter(EVENT_QUEUE_OVERLOAD, (snapshot) => {
      log.warn("event batch depth crossed the overload threshold", {
        depth: snapshot.depth,
        highWater: snapshot.highWater,
        threshold: EVENT_QUEUE_OVERLOAD,
        overloads: snapshot.overloads,
      })
    })

    // Consumer-side dedup for wake-shaped envelopes. The "parent ↔
    // child wake ordering race" can cause the same event to be
    // delivered twice through the bus; without this filter every
    // handler below would re-run on the duplicate (e.g. two
    // refreshBackgroundJobs, two "Woke parent session" log lines).
    // The LRU is bounded to 256 entries × 60s TTL (~8 KB) so it cannot
    // grow unbounded even under sustained bursts. See
    // `util/wake-dedup.ts` for the policy and Level-2 follow-ups.
    const wakeDedup: WakeDedup = createWakeDedup(
      (envelope) => {
        const payload = (envelope as { payload?: { type?: string; properties?: unknown } }).payload
        const type = payload?.type
        const props = (payload?.properties ?? {}) as Record<string, unknown>
        switch (type) {
          case "delegation.completed":
            return `delegation:${props?.delegationID}:${props?.status}`
          case "loop.run.finished":
            return `loop:${props?.runID}:${props?.status}`
          case "loop.runtime.changed":
            return `loop-runtime:${props?.loopID}`
          case "mission.finished":
            return `mission:${props?.missionID}`
          case "mission.exec.finished":
            return `mission-exec:${props?.execID}:${props?.status}`
          case "session.goal":
            return `goal:${props?.sessionID}:${(props?.goal as { status?: string } | null)?.status ?? "null"}`
          default:
            return undefined
        }
      },
      { maxEntries: 256, ttlMs: 60_000 },
    )

    const flush = () => {
      if (queue.length === 0) return
      const envelopes = queue
      queue = []
      queueMeter.flush(envelopes.length)
      timer = undefined
      last = Date.now()
      // Filter wake-shaped envelopes that have already been seen in
      // the dedup window. The filter is O(n) over the queue and runs
      // before the batch, so the rest of the pipeline (handlers,
      // emitter) sees only fresh envelopes.
      const fresh: GlobalEnvelope[] = []
      for (const envelope of envelopes) {
        if (wakeDedup.shouldProcess(envelope as { type?: string; properties?: unknown })) {
          fresh.push(envelope)
        }
      }
      if (fresh.length === 0) return
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const envelope of fresh) {
          for (const handler of envelopeHandlers) handler(envelope)
          emitter.emit(envelope.payload.type, envelope.payload)
        }
      })
    }

    const handleEnvelope = (envelope: GlobalEnvelope) => {
      const type = (envelope?.payload as { type?: string } | undefined)?.type
      if (!type) return
      if (type === "server.heartbeat" || type === "server.connected") return
      queue.push(envelope)
      queueMeter.admit()
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      const stopped = AbortSignal.any([abort.signal, ctrl.signal])
      // Consecutive reconnects without a successful subscribe. Every exit from a
      // stream waits before the next attempt — a clean EOF included, as upstream
      // does — so a server that closes on every connect cannot spin this loop.
      let failures = 0
      void (async () => {
        try {
          while (true) {
            if (abort.signal.aborted || ctrl.signal.aborted) break
            try {
              // Global stream: events from every instance (root + worktrees)
              // wrapped in {directory, payload} envelopes.
              const events = await sdk.global.event({
                signal: ctrl.signal,
              })
              // successful connect → reset backoff
              failures = 0
              markConnected()

              await consumeGlobalEventStream({
                stream: events.stream as AsyncIterable<GlobalEnvelope>,
                signal: ctrl.signal,
                onConnected: markConnected,
                onEnvelope: handleEnvelope,
              })

              if (timer) clearTimeout(timer)
              if (queue.length > 0) flush()

              // The stream ended without throwing (server closed it cleanly).
              // The UI should say so at once — otherwise a dead server looks
              // like a frozen TUI — and the retry still waits its turn.
              if (stopped.aborted) break
              markReconnecting(undefined)
              await sleepUnlessAborted(reconnectDelay(++failures), stopped)
            } catch (loopError) {
              if (stopped.aborted) break
              markReconnecting(loopError)
              const delay = reconnectDelay(++failures)
              console.warn(
                "[sse]",
                "subscribe failed, retrying in",
                Math.round(delay),
                "ms",
                loopError instanceof Error ? loopError.message : loopError,
              )
              await sleepUnlessAborted(delay, stopped)
            }
          }
        } catch (fatalError) {
          // Should never happen — the outer try is a safety net so an
          // unhandled rejection here can't crash the TUI process.
          console.error("[sse]", "fatal loop error", fatalError)
        }
      })()
    }

    onMount(() => {
      if (props.events) {
        let active = true
        let unsubscribe: (() => void) | undefined
        onCleanup(() => {
          active = false
          unsubscribe?.()
        })

        let subscription: Promise<() => void>
        try {
          subscription = props.events.subscribe(props.directory, handleEnvelope)
        } catch (error) {
          console.error("[events]", "subscribe failed", error)
          markReconnecting(error)
          return
        }
        void subscription
          .then((unsub) => {
            if (!active) {
              unsub()
              return
            }
            unsubscribe = unsub
            markConnected()
            markSubscriptionReady()
          })
          .catch((error) => {
            if (!active) return
            console.error("[events]", "subscribe failed", error)
            markReconnecting(error)
          })
        return
      }

      startSSE()
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
      envelopeHandlers.clear()
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      /** Subscribe to raw {directory, payload} envelopes when the consumer
       *  needs to know which instance emitted the event (e.g. vcs updates). */
      onEnvelope(handler: (envelope: GlobalEnvelope) => void) {
        envelopeHandlers.add(handler)
        return () => {
          envelopeHandlers.delete(handler)
        }
      },
      fetch: props.fetch ?? fetch,
      url: props.url,
      subscriptionReady,
      connection: {
        status: connectionStatus,
        attempt: connectionAttempt,
        error: connectionError,
      },
    }
  },
})

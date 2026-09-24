import type { ConnectionStatus } from "@tui/context/sdk"

/**
 * Decides when a connection transition means the client has to refetch.
 *
 * The event stream is a live fan-out with a per-connection lag budget, not a
 * journal: there is no cursor to resume from, so anything published while the
 * stream was down is simply gone. Resuming it without refetching leaves the
 * stores with a hole while the UI says "connected".
 *
 * The rule is narrow on purpose. Only a transition that passed through
 * `reconnecting` counts; the first `connecting` → `connected` is the initial
 * connection, whose state the caller loads on mount. Refetching there too would
 * double every startup.
 */
export function createReconnectGate() {
  let sawDisconnect = false
  return {
    /** True when this transition means the caller must refetch its state. */
    observe(status: ConnectionStatus): boolean {
      if (status === "reconnecting") {
        sawDisconnect = true
        return false
      }
      if (status !== "connected" || !sawDisconnect) return false
      sawDisconnect = false
      return true
    },
    /** Whether a disconnect is still waiting to be recovered from. */
    get pending() {
      return sawDisconnect
    },
  }
}

export type ReconnectGate = ReturnType<typeof createReconnectGate>

/** First retry delay for the event stream, in milliseconds. */
export const RECONNECT_BASE_MS = 250

/** Ceiling for the event stream's retry delay, in milliseconds. */
export const RECONNECT_MAX_MS = 5_000

/**
 * How long to wait before the `failures`-th consecutive reconnect.
 *
 * Capped exponential backoff with equal jitter, per
 * `specs/effect-tui/04-event-delivery.md` recovery step 1 (250 ms base, 5 s cap).
 * Half the step is fixed and half is random: the fixed half keeps a floor under
 * every retry, so a server that closes the stream cleanly on every connect cannot
 * turn the loop into a tight one, and the random half keeps many clients that
 * lost the same server from reconnecting in lockstep.
 */
export function reconnectDelay(failures: number, random: () => number = Math.random): number {
  const step = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, failures - 1), RECONNECT_MAX_MS)
  return step / 2 + random() * (step / 2)
}

/**
 * Wait `ms`, or less if `signal` aborts first. A reconnect delay that outlives
 * its owner keeps a loop — and whatever it closes over — alive after cleanup.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

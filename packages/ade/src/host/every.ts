/**
 * A repeating job that knows whether anyone is looking.
 *
 * Every poll in ADE used to be a bare `setInterval`, so a minimised window
 * kept reading the process table, the usage files and the mailbox exactly as
 * often as a focused one. Most of that work only feeds what is on screen and
 * can stop outright while the page is hidden; some of it (delivering messages
 * between sessions) has to go on, but can go on slower.
 *
 * Built on a chained `setTimeout` rather than `setInterval`: a tick that
 * awaits a slow host call is never overlapped by the next one, and each delay
 * is chosen after the previous tick finished.
 *
 * Plain `.ts`, so the timing rules can be tested under `bun test`.
 */

export interface EveryOptions {
  /**
   * What to do while the page is hidden: a slower delay in ms, or `"pause"`
   * to skip ticks until it is visible again. Defaults to `"pause"`.
   */
  readonly whenHidden?: number | "pause"
  /** Run the first tick now rather than after one delay. */
  readonly immediate?: boolean
  /** Injected in tests. */
  readonly isHidden?: () => boolean
  readonly onVisible?: (listener: () => void) => () => void
}

export function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
}

function listenVisible(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {}
  const handler = () => {
    if (!pageHidden()) listener()
  }
  document.addEventListener("visibilitychange", handler)
  return () => document.removeEventListener("visibilitychange", handler)
}

/** Starts the job; the returned function stops it. */
export function every(ms: number, tick: () => unknown, options: EveryOptions = {}): () => void {
  const isHidden = options.isHidden ?? pageHidden
  const whenHidden = options.whenHidden ?? "pause"
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let busy = false

  const schedule = () => {
    if (stopped) return
    clearTimeout(timer)
    if (isHidden() && whenHidden === "pause") return // resumed by the visibility listener
    timer = setTimeout(run, isHidden() ? (whenHidden as number) : ms)
  }

  const run = async () => {
    if (stopped || busy) return
    if (isHidden() && whenHidden === "pause") return
    busy = true
    try {
      await tick()
    } catch {
      // A failed tick is retried on the next one; the job never dies of it.
    } finally {
      busy = false
      schedule()
    }
  }

  // Coming back into view: catch up at once instead of waiting a full delay.
  const unlisten = (options.onVisible ?? listenVisible)(() => {
    if (!stopped && !busy) void run()
  })

  if (options.immediate) void run()
  else schedule()

  return () => {
    stopped = true
    clearTimeout(timer)
    unlisten()
  }
}

/**
 * The live telemetry panel's record buffer: bounded and coalesced.
 *
 * `specs/effect-tui/13-observability-pipeline.md` requires the panel to be
 * bounded and rate-limited, and never to block the input thread. It was bounded
 * and nothing else: every `telemetry.record` event wrote a Solid signal, and
 * each write rebuilt a 2000-element array. A busy turn emits spans far faster
 * than a terminal can usefully repaint, so the panel did a full re-render per
 * span to show frames nobody could read.
 *
 * Coalescing is what the bound alone cannot give. The cap limits how much is
 * *kept*; the flush window limits how often the rest of the app is told, which
 * is the part the input thread pays for.
 *
 * `schedule` is injected so the behaviour can be tested without waiting on a
 * real timer — a test that sleeps to observe a throttle is a test that loses
 * under CI load (`specs/effect-tui/20-testing-architecture-harnesses.md`).
 */
export type TelemetryBufferOptions<T> = {
  /** Most records kept. Older ones are dropped from the front. */
  readonly max?: number
  /** Minimum gap between flushes, in milliseconds. */
  readonly flushMs?: number
  /** Called with the whole retained window whenever a flush lands. */
  readonly onFlush: (records: readonly T[]) => void
  /** Timer seam. Defaults to `setTimeout`; tests pass their own clock. */
  readonly schedule?: (fn: () => void, ms: number) => void
}

export const DEFAULT_MAX_RECORDS = 2000
export const DEFAULT_FLUSH_MS = 250

export function createTelemetryBuffer<T>(options: TelemetryBufferOptions<T>) {
  const max = options.max ?? DEFAULT_MAX_RECORDS
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
  const schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms))

  let records: T[] = []
  let pending = false
  let dropped = 0

  function flush() {
    pending = false
    options.onFlush(records)
  }

  return {
    /**
     * Take one record. Synchronous, allocation-light, and it never calls the
     * sink inline — that is the "does not block the input thread" half.
     */
    push(record: T) {
      records.push(record)
      if (records.length > max) {
        // Drop from the front: the panel shows the most recent spans, and the
        // oldest are the ones already scrolled past.
        dropped += records.length - max
        records = records.slice(records.length - max)
      }
      if (pending) return
      pending = true
      schedule(flush, flushMs)
    },
    /** Flush now, if anything is waiting. For teardown and for tests. */
    flushNow() {
      if (!pending) return
      flush()
    },
    clear() {
      records = []
    },
    get size() {
      return records.length
    },
    /** How many records the cap discarded. A panel that lies about this is worse than one that scrolls. */
    get dropped() {
      return dropped
    },
  }
}

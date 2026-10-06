/**
 * Native-LLM route coverage.
 *
 * Native `@nikcli-ai/llm` streaming is the only runtime, so the question this answers is no longer "how
 * much would move over" but "which turns could not run, and why": a model no route can carry, a missing
 * credential, a request a route refused. Every verdict is computed in `session/llm.ts`; this module keeps
 * them, so the answer is in the service's redacted log (one bounded line every `LOG_EVERY` turns)
 * instead of being thrown away with the error.
 *
 * Discipline, following `effect/lifecycle-counters.ts`:
 *
 *  - **Every outcome has exactly one call site.** A counter nobody can increment
 *    reads as "measured, none" when it means "never measured". The four below are
 *    the four branches `session/llm.ts` can take, and adding a fifth means
 *    adding the branch that emits it.
 *  - **Bounded cardinality** (EOT-01 requirement 6). Custom provider ids are
 *    arbitrary: retain at most PROVIDER_CAP, plus a reserved overflow bucket.
 *    Model ids are *not* keys; they go in a
 *    capped set instead, so "which models" stays answerable without an unbounded
 *    map. Refusal reasons are bounded the same way.
 *  - **No session ids, prompts, tokens or paths are accepted.** Only catalog
 *    identifiers and refusal reasons are retained; logs use the redacted sink.
 *
 * Nothing here branches production behaviour. Recording is the whole job.
 */

import { Log } from "@nikcli-ai/util/log"

const log = Log.create({ service: "llm-coverage" })

/**
 * What happened to one turn, with respect to the native route.
 *
 * The first three end the turn with an error; `native` is a turn that streamed.
 */
export type Outcome =
  /** No `ModelRef` at all: `mapToModelRef` could not map this model. */
  | "unmapped"
  /** The pre-flight `LLMNativeRuntime.status()` refused. A configuration verdict. */
  | "ineligible"
  /** The route or request builder refused once it saw the request. A protocol verdict. */
  | "ineligible-late"
  /** The native runtime returned a stream (not proof of completion). */
  | "native"
  /** The native runtime refused or failed; the AI SDK fallback finished the turn. */
  | "fallback"

export const OUTCOMES: readonly Outcome[] = ["unmapped", "ineligible", "ineligible-late", "native", "fallback"] as const

/**
 * Distinct refusal reasons kept before the rest bucket into `other`.
 *
 * The reasons `native-runtime.ts` produces are literals, so this never binds in
 * practice. It exists because one of them interpolates a value, and a reason
 * string that starts carrying a model id would otherwise turn a bounded map into
 * an unbounded one without anybody noticing.
 */
const REASON_CAP = 32
const PROVIDER_CAP = 32
const PROVIDER_OVERFLOW = "other"

/**
 * Distinct `provider/model` pairs kept for the refused set.
 *
 * Bounded deliberately (EOT-05 requirement 7: a stated, tested bound rather than
 * an exception). Sixty-four is several times the size of a realistic catalog
 * slice for one process, and the counters — not this set — are the measurement.
 */
const MODEL_CAP = 64

/**
 * Turns between aggregate log lines.
 *
 * A process-local counter is only evidence if somebody can read it after the
 * fact. The background service is long-lived by design, so one bounded `info`
 * line every `LOG_EVERY` turns leaves the soak in the service's own redacted log
 * without adding a route, a file, or a timer.
 */
const LOG_EVERY = 25

const counts = new Map<string, Map<Outcome, number>>()
const overflowCounts = new Map<Outcome, number>()
const reasons = new Map<string, number>()
let reasonOverflow = 0
const refusedModels = new Set<string>()
let refusedOverflow = 0
let turns = 0

function bump<K extends string>(map: Map<K, number>, key: K) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * Record one turn's verdict.
 *
 * `reason` belongs to the two ineligible outcomes and is ignored elsewhere;
 * `modelID` is kept only for the outcomes that represent a refusal, because a
 * model that ran does not need to be listed for anyone to find it.
 */
export function record(input: {
  readonly outcome: Outcome
  readonly providerID: string
  readonly modelID: string
  readonly reason?: string
}): void {
  // Reserve `other` before admission; neither literal ids nor later arrivals
  // may consume another named slot or collide with the overflow counters.
  let provider = counts.get(input.providerID)
  if (!provider && input.providerID !== PROVIDER_OVERFLOW && counts.size < PROVIDER_CAP) {
    provider = new Map<Outcome, number>()
    counts.set(input.providerID, provider)
  }
  bump(provider ?? overflowCounts, input.outcome)
  turns++

  if (input.reason && (input.outcome === "ineligible" || input.outcome === "ineligible-late")) {
    // Past the cap a new reason is still counted, just not named. Dropping it
    // entirely would make the totals disagree with the counters.
    if (input.reason === "other" || (reasons.size >= REASON_CAP && !reasons.has(input.reason))) reasonOverflow++
    else bump(reasons, input.reason)
  }

  if (input.outcome === "unmapped" || input.outcome === "ineligible" || input.outcome === "ineligible-late") {
    const pair = `${input.providerID}/${input.modelID}`
    if (refusedModels.has(pair)) {
      // already named
    } else if (refusedModels.size < MODEL_CAP) {
      refusedModels.add(pair)
    } else {
      refusedOverflow++
    }
  }

  if (turns % LOG_EVERY === 0) log.info("native route coverage", report())
}

export type Snapshot = {
  readonly turns: number
  /** `providerID:outcome` → count. */
  readonly counts: Readonly<Record<string, number>>
  /** Refusal reason → count, with everything past the cap under `other`. */
  readonly reasons: Readonly<Record<string, number>>
  /** Up to `MODEL_CAP` distinct `provider/model` pairs the native route refused. */
  readonly refusedModels: readonly string[]
  /** Refusal observations not retained after the cap, including repeated pairs. */
  readonly refusedOverflow: number
}

/** A stable snapshot. Do not mutate the result. */
export function snapshot(): Snapshot {
  return {
    turns,
    counts: Object.fromEntries(
      providerEntries().flatMap(([id, values]) => [...values].map(([outcome, n]) => [`${id}:${outcome}`, n])),
    ),
    reasons: Object.fromEntries(
      [...reasons.entries()]
        .sort(([a], [b]) => compare(a, b))
        .concat(reasonOverflow ? [["other", reasonOverflow]] : []),
    ),
    refusedModels: [...refusedModels].sort(),
    refusedOverflow,
  }
}

/**
 * Totals per outcome, collapsed across providers.
 *
 * This is the shape the periodic log line carries and the shape the soak is read
 * in: the per-provider keys answer "who", this answers "how much".
 */
export function summary(): Readonly<Record<Outcome | "turns", number>> {
  const out = { turns } as Record<Outcome | "turns", number>
  for (const outcome of OUTCOMES) out[outcome] = 0
  for (const [, values] of providerEntries()) for (const [outcome, n] of values) out[outcome] += n
  return out
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function providerEntries(): [string, Map<Outcome, number>][] {
  const entries = [...counts.entries()]
  if (overflowCounts.size) entries.push([PROVIDER_OVERFLOW, overflowCounts])
  return entries.sort(([a], [b]) => compare(a, b))
}

export type ProviderReport = Readonly<Record<Outcome | "turns", number>> & {
  readonly providerID: string
  readonly overflow: boolean
  readonly mapped: number
  /** Turns the route or pre-flight refused after a mapping existed. */
  readonly eligibilityRefused: number
}

/** Cumulative, deterministic decision inputs, without model ids or request data. */
export function report() {
  const providers: ProviderReport[] = providerEntries().map(([providerID, values]) => {
    const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, values.get(outcome) ?? 0])) as Record<
      Outcome,
      number
    >
    const total = OUTCOMES.reduce((sum, outcome) => sum + outcomes[outcome], 0)
    return {
      providerID,
      overflow: providerID === PROVIDER_OVERFLOW,
      ...outcomes,
      turns: total,
      mapped: total - outcomes.unmapped,
      eligibilityRefused: outcomes.ineligible + outcomes["ineligible-late"],
    }
  })
  // Reasons are values in the log payload: the redactor does not sanitize
  // arbitrary object keys, which could otherwise carry an interpolated secret.
  return {
    ...summary(),
    providers,
    reasons: Object.entries(snapshot().reasons).map(([reason, count]) => ({
      reason,
      count,
    })),
  }
}

/**
 * Clear every counter.
 *
 * Module state, so `bun test` shares it across a run: a test that reads these
 * resets in `beforeEach`, not only in `afterEach`, or it inherits whatever an
 * earlier file left behind.
 */
export function reset(): void {
  counts.clear()
  overflowCounts.clear()
  reasons.clear()
  reasonOverflow = 0
  refusedModels.clear()
  refusedOverflow = 0
  turns = 0
}

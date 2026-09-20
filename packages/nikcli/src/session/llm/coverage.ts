/**
 * Native-LLM route coverage.
 *
 * `specs/effect-tui/11-provider-inference-streaming.md` scopes converging the AI
 * SDK path onto `@nikcli-ai/llm`. `specs/v2/todo.md` names what blocks deciding
 * it: `mapToModelRef` returns `undefined` for anything it cannot map, which is a
 * safe fallback and an invisible one — nothing reports that a model silently took
 * the AI SDK path. Every verdict was already computed in `session/llm.ts` and
 * written to `l.debug`, which is to say thrown away.
 *
 * This module keeps them. It is deliberately readable with
 * `experimental.nativeLlm` **off**, which is the point: `session/llm.ts` already
 * compiles the native request in shadow when the flag is down, so `disabled`
 * answers "how many turns would have gone native, and for which providers"
 * without flipping anything on. The soak the todo asks for is this, not the flag.
 *
 * Discipline, following `effect/lifecycle-counters.ts`:
 *
 *  - **Every outcome has exactly one call site.** A counter nobody can increment
 *    reads as "measured, none" when it means "never measured". The six below are
 *    the six branches `session/llm.ts` can take, and adding a seventh means
 *    adding the branch that emits it.
 *  - **Fixed cardinality** (EOT-01 requirement 6). The counter key is
 *    `providerID:outcome` — both bounded. Model ids are *not* keys; they go in a
 *    capped set instead, so "which models" stays answerable without an unbounded
 *    map. Refusal reasons are bounded the same way.
 *  - **No session ids, prompts, tokens or paths.** Provider and model ids are
 *    catalog identifiers, not user data.
 *
 * Nothing here branches production behaviour. Recording is the whole job.
 */

import { Log } from "@nikcli-ai/util/log"

const log = Log.create({ service: "llm-coverage" })

/**
 * What happened to one turn, with respect to the native route.
 *
 * Read the six as two groups: the first two are what the AI SDK path costs us
 * today, the last four are what the native path does when it is switched on.
 */
export type Outcome =
  /** No `ModelRef` at all: `mapToModelRef` could not map this model. */
  | "unmapped"
  /** The flag is off, but a `ModelRef` exists — this turn *would* have gone native. */
  | "disabled"
  /** Flag on; the pre-flight `LLMNativeRuntime.status()` refused. A configuration verdict. */
  | "ineligible"
  /** Flag on; `streamRequestOnly` refused once it saw the route. A protocol verdict. */
  | "ineligible-late"
  /** Flag on; the native runtime streamed the whole turn. */
  | "native"
  /** Flag on; native started, threw mid-stream, and the AI SDK finished the turn. */
  | "fallback"

export const OUTCOMES: readonly Outcome[] = [
  "unmapped",
  "disabled",
  "ineligible",
  "ineligible-late",
  "native",
  "fallback",
] as const

/**
 * Distinct refusal reasons kept before the rest bucket into `other`.
 *
 * The reasons `native-runtime.ts` produces are literals, so this never binds in
 * practice. It exists because one of them interpolates a value, and a reason
 * string that starts carrying a model id would otherwise turn a bounded map into
 * an unbounded one without anybody noticing.
 */
const REASON_CAP = 32

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

const counts = new Map<string, number>()
const reasons = new Map<string, number>()
const refusedModels = new Set<string>()
let refusedOverflow = 0
let turns = 0

function bump(map: Map<string, number>, key: string) {
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
  bump(counts, `${input.providerID}:${input.outcome}`)
  turns++

  if (input.reason && (input.outcome === "ineligible" || input.outcome === "ineligible-late")) {
    // Past the cap a new reason is still counted, just not named. Dropping it
    // entirely would make the totals disagree with the counters.
    if (reasons.size >= REASON_CAP && !reasons.has(input.reason)) bump(reasons, "other")
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

  if (turns % LOG_EVERY === 0) log.info("native route coverage", summary())
}

export type Snapshot = {
  readonly turns: number
  /** `providerID:outcome` → count. */
  readonly counts: Readonly<Record<string, number>>
  /** Refusal reason → count, with everything past the cap under `other`. */
  readonly reasons: Readonly<Record<string, number>>
  /** Up to `MODEL_CAP` distinct `provider/model` pairs the native route refused. */
  readonly refusedModels: readonly string[]
  /** Distinct pairs seen after the cap was reached. */
  readonly refusedOverflow: number
}

/** A stable snapshot. Do not mutate the result. */
export function snapshot(): Snapshot {
  return {
    turns,
    counts: Object.fromEntries(counts),
    reasons: Object.fromEntries(reasons),
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
  for (const [key, n] of counts) {
    const outcome = key.slice(key.indexOf(":") + 1) as Outcome
    if (outcome in out) out[outcome] += n
  }
  return out
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
  reasons.clear()
  refusedModels.clear()
  refusedOverflow = 0
  turns = 0
}

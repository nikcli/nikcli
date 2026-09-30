import { Effect } from "effect"
import { Agent, textOf, type ModelRef } from "./agent"

export type BenchSample = {
  readonly model: ModelRef
  readonly run: number
  /** Wall clock measured here, including the native proxy and session setup. */
  readonly wallMs: number
  /** Time between the server creating and completing the assistant message. */
  readonly serverMs?: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cacheRead: number
  readonly cost: number
  readonly tokensPerSecond?: number
  readonly text: string
  readonly error?: string
}

export type ModelBenchInput = {
  readonly prompt: string
  readonly system?: string
  readonly models: readonly ModelRef[]
  readonly runs: number
  /** Run the different models at the same time; repetitions of one model stay sequential. */
  readonly parallel: boolean
  readonly agent?: string
  readonly onSample?: (s: BenchSample) => void
}

const sample = (input: ModelBenchInput, model: ModelRef, run: number) =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const started = performance.now()
    return yield* agent
      .ask({
        title: `[devhub bench] ${model.modelID}`,
        text: input.prompt,
        system: input.system,
        model,
        agent: input.agent,
      })
      .pipe(
        Effect.match({
          onFailure: (e): BenchSample => ({
            model,
            run,
            wallMs: performance.now() - started,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheRead: 0,
            cost: 0,
            text: "",
            error: e.message,
          }),
          onSuccess: (m): BenchSample => {
            const t = m.info.tokens
            const serverMs =
              m.info.time.completed !== undefined ? m.info.time.completed - m.info.time.created : undefined
            const out = (t?.output ?? 0) + (t?.reasoning ?? 0)
            return {
              model,
              run,
              wallMs: performance.now() - started,
              serverMs,
              inputTokens: t?.input ?? 0,
              outputTokens: t?.output ?? 0,
              reasoningTokens: t?.reasoning ?? 0,
              cacheRead: t?.cache.read ?? 0,
              cost: m.info.cost ?? 0,
              tokensPerSecond: serverMs && serverMs > 0 && out > 0 ? out / (serverMs / 1000) : undefined,
              text: textOf(m),
              error: m.info.error ? (m.info.error.data?.message ?? m.info.error.name ?? "model error") : undefined,
            }
          },
        }),
        Effect.tap((s) => Effect.sync(() => input.onSample?.(s))),
      )
  })

export const runModelBench = (input: ModelBenchInput) =>
  Effect.forEach(
    input.models,
    (model) =>
      Effect.forEach(
        Array.from({ length: input.runs }, (_, i) => i + 1),
        (run) => sample(input, model, run),
      ),
    { concurrency: input.parallel ? "unbounded" : 1 },
  ).pipe(Effect.map((perModel) => perModel.flat()))

// ── aggregation (pure) ───────────────────────────────────────────────────────

export type ModelStats = {
  readonly model: ModelRef
  readonly ok: number
  readonly failed: number
  readonly medianMs: number
  readonly p95Ms: number
  readonly minMs: number
  readonly maxMs: number
  readonly meanTps?: number
  readonly outputTokens: number
  readonly cost: number
}

export const percentile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : 0

export function summarize(samples: readonly BenchSample[]): ModelStats[] {
  const by = new Map<string, BenchSample[]>()
  for (const s of samples) {
    const k = `${s.model.providerID}/${s.model.modelID}`
    by.set(k, [...(by.get(k) ?? []), s])
  }
  return [...by.values()]
    .map((list) => {
      const ok = list.filter((s) => !s.error)
      const ms = ok.map((s) => s.serverMs ?? s.wallMs).sort((a, b) => a - b)
      const tps = ok.map((s) => s.tokensPerSecond).filter((x): x is number => x !== undefined)
      return {
        model: list[0].model,
        ok: ok.length,
        failed: list.length - ok.length,
        medianMs: percentile(ms, 0.5),
        p95Ms: percentile(ms, 0.95),
        minMs: ms[0] ?? 0,
        maxMs: ms[ms.length - 1] ?? 0,
        meanTps: tps.length ? tps.reduce((a, b) => a + b, 0) / tps.length : undefined,
        outputTokens: ok.reduce((a, s) => a + s.outputTokens + s.reasoningTokens, 0),
        cost: list.reduce((a, s) => a + s.cost, 0),
      }
    })
    .sort((a, b) => (a.ok ? a.medianMs : Infinity) - (b.ok ? b.medianMs : Infinity))
}

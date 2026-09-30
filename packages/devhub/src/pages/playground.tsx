import { shortcut } from "../lib/platform"
import { Effect } from "effect"
import { For, Match, Show, Switch as SolidSwitch, createMemo, createSignal } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { Checkbox } from "@nikcli-ai/ui/checkbox"
import { Select } from "@nikcli-ai/ui/select"
import { Switch } from "@nikcli-ai/ui/switch"
import { Tabs } from "@nikcli-ai/ui/tabs"
import { Agent, Gateway, textOf, type ModelRef } from "../lib/agent"
import { runModelBench, summarize, percentile, type BenchSample } from "../lib/modelbench"
import { createModels, modelKey } from "../lib/models"
import { native } from "../lib/native"
import { runApp } from "../lib/runtime"
import { app, toastError, toastOk } from "../lib/store"
import { runner } from "../lib/tasks"
import { compact, duration, ms, when } from "../lib/format"
import { Empty, Page, Panel, Spark } from "../components/kit"
import { RunLog, RunSummary } from "./tests"

const store = <T,>(key: string, fallback: T) => {
  const read = (): T => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback
    }
  }
  const write = (v: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(v))
    } catch {}
  }
  return { read, write }
}

// ── model bench ───────────────────────────────────────────────────────────────

type ModelSet = { id: string; at: number; prompt: string; runs: number; samples: BenchSample[] }
const setsStore = store<ModelSet[]>("devhub.play.modelsets", [])

function ModelBench() {
  const { models, loading, error } = createModels()
  const [prompt, setPrompt] = createSignal("Explain in two sentences why the sky is blue.")
  const [system, setSystem] = createSignal("")
  const [picked, setPicked] = createSignal<ModelRef[]>([])
  const [q, setQ] = createSignal("")
  const [runs, setRuns] = createSignal("3")
  const [parallel, setParallel] = createSignal(true)
  const [samples, setSamples] = createSignal<BenchSample[]>([])
  const [running, setRunning] = createSignal(false)
  const [sets, setSets] = createSignal<ModelSet[]>(setsStore.read())
  const [sel, setSel] = createSignal<string>()
  let abort: AbortController | undefined

  const shown = createMemo(() => {
    const needle = q().toLowerCase()
    return models()
      .filter((m) => !needle || `${m.providerName} ${m.name} ${m.modelID}`.toLowerCase().includes(needle))
      .slice(0, 80)
  })
  const isPicked = (m: ModelRef) => picked().some((p) => modelKey(p) === modelKey(m))
  const total = () => picked().length * (Number(runs()) || 1)
  const view = createMemo(() => (sel() ? sets().find((s) => s.id === sel())?.samples : undefined) ?? samples())
  const stats = createMemo(() => summarize(view()))
  const fastest = () =>
    Math.min(
      ...stats()
        .filter((s) => s.ok)
        .map((s) => s.medianMs),
      Infinity,
    )

  const start = async () => {
    if (!picked().length) return toastError("Pick at least one model", "Select models from the list on the left")
    setSel(undefined)
    setSamples([])
    setRunning(true)
    abort = new AbortController()
    const n = Math.min(Math.max(Number(runs()) || 1, 1), 10)
    try {
      const all = await runApp(
        runModelBench({
          prompt: prompt(),
          system: system().trim() || undefined,
          models: picked(),
          runs: n,
          parallel: parallel(),
          onSample: (s) => setSamples((x) => [...x, s]),
        }),
        abort.signal,
      )
      const set: ModelSet = { id: Date.now().toString(36), at: Date.now(), prompt: prompt(), runs: n, samples: all }
      const next = [set, ...sets()].slice(0, 15)
      setSets(next)
      setsStore.write(next)
      toastOk("Model benchmark finished", `${all.length} samples`)
    } catch (e) {
      if (!abort?.signal.aborted) toastError("Benchmark failed", e)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div class="dh-grid" data-cols="split">
      <div class="dh-stack">
        <Panel title={`Models · ${picked().length} selected`} class="flush">
          <div class="dh-toolbar" style={{ padding: "10px 12px" }}>
            <input
              class="dh-input"
              style={{ flex: 1 }}
              placeholder={loading() ? "Loading models…" : `Search ${models().length} models…`}
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
            />
            <Show when={picked().length}>
              <Button size="small" variant="ghost" onClick={() => setPicked([])}>
                Clear
              </Button>
            </Show>
          </div>
          <Show when={error()}>
            <div class="dh-action__error" style={{ margin: "0 12px 10px" }}>
              {error()}
            </div>
          </Show>
          <div class="dh-scroll" style={{ "max-height": "44vh" }}>
            <Show
              when={shown().length}
              fallback={<Empty>{loading() ? "Loading…" : "No connected models match."}</Empty>}
            >
              <table class="dh-table">
                <tbody>
                  <For each={shown()}>
                    {(m) => (
                      <tr
                        data-clickable="true"
                        onClick={() =>
                          setPicked((p) =>
                            isPicked(m)
                              ? p.filter((x) => modelKey(x) !== modelKey(m))
                              : [...p, { providerID: m.providerID, modelID: m.modelID }].slice(0, 12),
                          )
                        }
                      >
                        <td style={{ width: "32px" }}>
                          <Checkbox checked={isPicked(m)} onChange={() => undefined} />
                        </td>
                        <td class="dh-fill">
                          <div class="dh-ellipsis" title={m.modelID}>
                            {m.name}
                          </div>
                          <div class="dh-sub">
                            {m.providerName}
                            {m.context ? ` · ${compact(m.context)} ctx` : ""}
                          </div>
                        </td>
                        <td class="dh-num dh-sub">
                          {m.inputCost !== undefined ? `$${m.inputCost}/${m.outputCost ?? "?"}` : "free/unknown"}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </Panel>
        <Panel title="History" class="flush">
          <Show when={sets().length} fallback={<Empty>No finished model benchmarks yet.</Empty>}>
            <div class="dh-scroll" style={{ "max-height": "22vh" }}>
              <table class="dh-table">
                <tbody>
                  <For each={sets()}>
                    {(s) => (
                      <tr
                        data-clickable="true"
                        data-selected={sel() === s.id}
                        onClick={() => setSel(sel() === s.id ? undefined : s.id)}
                      >
                        <td class="dh-fill" title={s.prompt}>
                          <div class="dh-ellipsis">{s.prompt}</div>
                        </td>
                        <td class="dh-num">
                          {new Set(s.samples.map((x) => modelKey(x.model))).size} models × {s.runs}
                        </td>
                        <td class="dh-sub">{when(s.at)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Panel>
      </div>

      <div class="dh-stack">
        <Panel title="Prompt">
          <textarea
            class="dh-input"
            placeholder="What should every model answer?"
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
          />
          <input
            class="dh-input"
            style={{ width: "100%", "margin-top": "8px" }}
            placeholder="System prompt (optional)"
            value={system()}
            onInput={(e) => setSystem(e.currentTarget.value)}
          />
          <div class="dh-toolbar" style={{ "margin-top": "10px" }}>
            <label class="dh-field">
              Runs each
              <input
                class="dh-input"
                style={{ width: "64px", "min-width": "64px" }}
                value={runs()}
                onInput={(e) => setRuns(e.currentTarget.value)}
              />
            </label>
            <Switch checked={parallel()} onChange={setParallel}>
              Models in parallel
            </Switch>
            <span class="dh-sub" style={{ "margin-left": "auto" }}>
              {total()} requests
            </span>
            <Show
              when={running()}
              fallback={
                <Button variant="primary" size="small" onClick={() => void start()}>
                  Run benchmark
                </Button>
              }
            >
              <Button size="small" onClick={() => abort?.abort()}>
                Stop · {samples().length}/{total()}
              </Button>
            </Show>
          </div>
        </Panel>

        <Show
          when={stats().length}
          fallback={
            <Panel title="Results">
              <Empty>
                Select models, write a prompt and run. Every number comes from a real call to the model through nikcli.
              </Empty>
            </Panel>
          }
        >
          <Panel title={`Results · ${view().length} samples`} class="flush">
            <table class="dh-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th class="dh-num">OK</th>
                  <th class="dh-num">median</th>
                  <th class="dh-num">p95</th>
                  <th class="dh-num">min–max</th>
                  <th class="dh-num">tok/s</th>
                  <th class="dh-num">cost</th>
                  <th>speed</th>
                </tr>
              </thead>
              <tbody>
                <For each={stats()}>
                  {(s) => (
                    <tr>
                      <td>
                        <div class="dh-ellipsis" style={{ "max-width": "200px" }} title={modelKey(s.model)}>
                          {s.model.modelID}
                        </div>
                        <div class="dh-sub">{s.model.providerID}</div>
                      </td>
                      <td class="dh-num" classList={{ "dh-delta-bad": s.failed > 0 }}>
                        {s.ok}/{s.ok + s.failed}
                      </td>
                      <td class="dh-num">{s.ok ? ms(s.medianMs) : "—"}</td>
                      <td class="dh-num">{s.ok ? ms(s.p95Ms) : "—"}</td>
                      <td class="dh-num dh-sub">{s.ok ? `${ms(s.minMs)}–${ms(s.maxMs)}` : "—"}</td>
                      <td class="dh-num">{s.meanTps ? s.meanTps.toFixed(1) : "—"}</td>
                      <td class="dh-num">${s.cost.toFixed(4)}</td>
                      <td style={{ width: "110px" }}>
                        <Show when={s.ok}>
                          <div class="dh-bar" data-tone="ok">
                            <div style={{ width: `${Math.min(100, (fastest() / s.medianMs) * 100)}%` }} />
                          </div>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Panel>
          <Panel title="Answers" class="flush">
            <div class="dh-scroll" style={{ "max-height": "40vh" }}>
              <For each={view()}>
                {(s) => (
                  <details class="dh-answer">
                    <summary>
                      <span class="dh-chip" data-tone={s.error ? "bad" : "ok"}>
                        {s.error ? "error" : ms(s.serverMs ?? s.wallMs)}
                      </span>
                      {s.model.modelID} · run {s.run}
                      <span class="dh-sub">
                        {s.outputTokens + s.reasoningTokens} tok{s.cost ? ` · $${s.cost.toFixed(4)}` : ""}
                      </span>
                    </summary>
                    <pre>{s.error ?? s.text}</pre>
                  </details>
                )}
              </For>
            </div>
          </Panel>
        </Show>
      </div>
    </div>
  )
}

// ── endpoint load test ────────────────────────────────────────────────────────

type Load = {
  id: string
  at: number
  method: string
  path: string
  total: number
  concurrency: number
  wallMs: number
  lat: number[]
  status: Record<string, number>
  errors: number
}
const loadStore = store<Load[]>("devhub.play.loads", [])
const PATHS = [
  "/global/health",
  "/doctor",
  "/config",
  "/session?limit=20",
  "/analytics/global",
  "/provider",
  "/mcp",
  "/agent",
]

function stats(lat: number[]) {
  const s = [...lat].sort((a, b) => a - b)
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0
  return {
    min: s[0] ?? 0,
    p50: percentile(s, 0.5),
    p90: percentile(s, 0.9),
    p95: percentile(s, 0.95),
    p99: percentile(s, 0.99),
    max: s[s.length - 1] ?? 0,
    mean,
  }
}

function LoadTest() {
  const [method, setMethod] = createSignal("GET")
  const [path, setPath] = createSignal("/global/health")
  const [body, setBody] = createSignal("")
  const [total, setTotal] = createSignal("200")
  const [conc, setConc] = createSignal("8")
  const [running, setRunning] = createSignal(false)
  const [done, setDone] = createSignal(0)
  const [result, setResult] = createSignal<Load>()
  const [history, setHistory] = createSignal<Load[]>(loadStore.read())
  let abort: AbortController | undefined

  const start = async () => {
    const n = Math.min(Math.max(Number(total()) || 1, 1), 5000)
    const c = Math.min(Math.max(Number(conc()) || 1, 1), 64)
    if (method() !== "GET" && !confirm(`Fire ${n} ${method()} requests at ${path()}? This changes data.`)) return
    setRunning(true)
    setDone(0)
    setResult(undefined)
    abort = new AbortController()
    const lat: number[] = []
    const status: Record<string, number> = {}
    let errors = 0
    const wall = performance.now()
    try {
      const one = Effect.gen(function* () {
        const gw = yield* Gateway
        const t = performance.now()
        const r = yield* gw
          .raw({ method: method(), path: path(), body: body().trim() ? JSON.parse(body()) : undefined })
          .pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: (res) => res,
            }),
          )
        const took = performance.now() - t
        if (!r) errors++
        else (lat.push(took), (status[String(r.status)] = (status[String(r.status)] ?? 0) + 1))
        setDone((d) => d + 1)
      })
      await runApp(
        Effect.forEach(Array.from({ length: n }), () => one, { concurrency: c, discard: true }),
        abort.signal,
      )
      const r: Load = {
        id: Date.now().toString(36),
        at: Date.now(),
        method: method(),
        path: path(),
        total: n,
        concurrency: c,
        wallMs: performance.now() - wall,
        lat,
        status,
        errors,
      }
      setResult(r)
      const next = [r, ...history()].slice(0, 20)
      setHistory(next)
      loadStore.write(next)
    } catch (e) {
      if (!abort?.signal.aborted) toastError("Load test failed", e)
    } finally {
      setRunning(false)
    }
  }

  const r = () => result()
  const st = createMemo(() => (r() ? stats(r()!.lat) : undefined))
  const hist = createMemo(() => {
    const l = r()?.lat ?? []
    if (!l.length) return []
    const s = stats(l)
    const buckets = new Array(24).fill(0)
    const span = Math.max(s.p99 - s.min, 1e-6)
    for (const v of l) buckets[Math.min(23, Math.floor(((Math.min(v, s.p99) - s.min) / span) * 24))]++
    return buckets as number[]
  })
  const peak = () => Math.max(1, ...hist())

  return (
    <div class="dh-grid" data-cols="split">
      <div class="dh-stack">
        <Panel title="Target">
          <div class="dh-toolbar">
            <Select
              size="small"
              options={["GET", "POST", "PUT", "DELETE"]}
              current={method()}
              onSelect={(m) => m && setMethod(m)}
            />
            <input
              class="dh-input"
              style={{ flex: 1 }}
              value={path()}
              list="dh-paths"
              onInput={(e) => setPath(e.currentTarget.value)}
            />
            <datalist id="dh-paths">
              <For each={PATHS}>{(p) => <option value={p} />}</For>
            </datalist>
          </div>
          <Show when={method() !== "GET"}>
            <textarea
              class="dh-input"
              style={{ "margin-top": "8px" }}
              placeholder="JSON body"
              value={body()}
              onInput={(e) => setBody(e.currentTarget.value)}
            />
          </Show>
          <div class="dh-toolbar" style={{ "margin-top": "10px" }}>
            <label class="dh-field">
              Requests
              <input
                class="dh-input"
                style={{ width: "84px", "min-width": "84px" }}
                value={total()}
                onInput={(e) => setTotal(e.currentTarget.value)}
              />
            </label>
            <label class="dh-field">
              Concurrency
              <input
                class="dh-input"
                style={{ width: "64px", "min-width": "64px" }}
                value={conc()}
                onInput={(e) => setConc(e.currentTarget.value)}
              />
            </label>
            <Show
              when={running()}
              fallback={
                <Button variant="primary" size="small" style={{ "margin-left": "auto" }} onClick={() => void start()}>
                  Run load test
                </Button>
              }
            >
              <Button size="small" style={{ "margin-left": "auto" }} onClick={() => abort?.abort()}>
                Stop · {done()}/{total()}
              </Button>
            </Show>
          </div>
          <p class="dh-sub" style={{ margin: "10px 0 0" }}>
            Latency includes the native IPC hop and proxy; it is identical for every run, so comparisons are fair.
          </p>
        </Panel>
        <Panel title="History" class="flush">
          <Show when={history().length} fallback={<Empty>No load tests yet.</Empty>}>
            <div class="dh-scroll" style={{ "max-height": "30vh" }}>
              <table class="dh-table">
                <thead>
                  <tr>
                    <th>Endpoint</th>
                    <th class="dh-num">n×c</th>
                    <th class="dh-num">p50</th>
                    <th class="dh-num">p95</th>
                    <th class="dh-num">req/s</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={history()}>
                    {(h) => {
                      const s = stats(h.lat)
                      return (
                        <tr data-clickable="true" onClick={() => setResult(h)}>
                          <td class="dh-mono dh-fill" title={when(h.at)}>
                            <div class="dh-ellipsis">
                              {h.method} {h.path}
                            </div>
                          </td>
                          <td class="dh-num">
                            {h.total}×{h.concurrency}
                          </td>
                          <td class="dh-num">{ms(s.p50)}</td>
                          <td class="dh-num">{ms(s.p95)}</td>
                          <td class="dh-num">{(h.lat.length / (h.wallMs / 1000)).toFixed(0)}</td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Panel>
      </div>
      <div class="dh-stack">
        <Show
          when={r() && st()}
          fallback={
            <Panel title="Results">
              <Empty>Pick an endpoint and run. Requests are real and authenticated.</Empty>
            </Panel>
          }
        >
          <div class="dh-grid" data-cols="4">
            <div class="dh-metric">
              <span>median</span>
              <strong>{ms(st()!.p50)}</strong>
            </div>
            <div class="dh-metric">
              <span>p95</span>
              <strong>{ms(st()!.p95)}</strong>
            </div>
            <div class="dh-metric">
              <span>p99</span>
              <strong>{ms(st()!.p99)}</strong>
            </div>
            <div class="dh-metric">
              <span>throughput</span>
              <strong>{(r()!.lat.length / (r()!.wallMs / 1000)).toFixed(0)}/s</strong>
            </div>
          </div>
          <Panel title={`${r()!.method} ${r()!.path} · ${r()!.total} requests × ${r()!.concurrency}`}>
            <div class="dh-hist">
              <For each={hist()}>
                {(b) => <div style={{ height: `${(b / peak()) * 100}%` }} title={`${b} requests`} />}
              </For>
            </div>
            <div class="dh-toolbar dh-sub" style={{ "justify-content": "space-between", "margin-top": "6px" }}>
              <span>{ms(st()!.min)}</span>
              <span>latency distribution (clipped at p99)</span>
              <span>{ms(st()!.p99)}</span>
            </div>
            <Spark values={r()!.lat} height={60} />
            <div class="dh-toolbar" style={{ "margin-top": "10px" }}>
              <For each={Object.entries(r()!.status)}>
                {([code, n]) => (
                  <span class="dh-chip" data-tone={code.startsWith("2") ? "ok" : "bad"}>
                    {code} × {n}
                  </span>
                )}
              </For>
              <Show when={r()!.errors}>
                <span class="dh-chip" data-tone="bad">
                  transport errors × {r()!.errors}
                </span>
              </Show>
              <span class="dh-chip">mean {ms(st()!.mean)}</span>
              <span class="dh-chip">min {ms(st()!.min)}</span>
              <span class="dh-chip">max {ms(st()!.max)}</span>
              <span class="dh-chip">{duration(r()!.wallMs / 1000)} total</span>
            </div>
          </Panel>
        </Show>
      </div>
    </div>
  )
}

// ── script lab ────────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, { kind: "script" | "test"; code: string }> = {
  "Micro-benchmark": {
    kind: "script",
    code: `// Micro-benchmark template: warm up, sample, report. Runs with Bun inside packages/nikcli.
const cases: Record<string, () => unknown> = {
  "JSON.parse(stringify)": () => JSON.parse(JSON.stringify({ a: [1, 2, 3], b: "x".repeat(64) })),
  "structuredClone": () => structuredClone({ a: [1, 2, 3], b: "x".repeat(64) }),
}

const WARMUP = 2_000
const SAMPLES = 40
const ITERATIONS = 5_000

for (const [name, fn] of Object.entries(cases)) {
  for (let i = 0; i < WARMUP; i++) fn()
  const times: number[] = []
  for (let s = 0; s < SAMPLES; s++) {
    const t = performance.now()
    for (let i = 0; i < ITERATIONS; i++) fn()
    times.push(((performance.now() - t) * 1000) / ITERATIONS) // µs per op
  }
  times.sort((a, b) => a - b)
  const at = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)]
  console.log(\`\${name.padEnd(24)} median \${at(0.5).toFixed(3)} µs  p95 \${at(0.95).toFixed(3)} µs  min \${times[0].toFixed(3)}  max \${times.at(-1)!.toFixed(3)}  (\${(1e6 / at(0.5)).toFixed(0)} ops/s)\`)
}
`,
  },
  "Memory probe": {
    kind: "script",
    code: `// Allocation / memory probe using Bun's runtime counters.
const mb = (n: number) => (n / 1048576).toFixed(1) + " MB"
Bun.gc(true)
const before = process.memoryUsage()
const keep: object[] = []
const t = performance.now()
for (let i = 0; i < 200_000; i++) keep.push({ id: i, name: "item-" + i, tags: ["a", "b", "c"] })
const took = performance.now() - t
const after = process.memoryUsage()
console.log("allocated 200k objects in", took.toFixed(1), "ms")
console.log("heap  ", mb(before.heapUsed), "→", mb(after.heapUsed), "(+" + mb(after.heapUsed - before.heapUsed) + ")")
console.log("rss   ", mb(before.rss), "→", mb(after.rss))
console.log("per object ≈", ((after.heapUsed - before.heapUsed) / keep.length).toFixed(0), "bytes")
`,
  },
  "bun:test": {
    kind: "test",
    code: `import { expect, test } from "bun:test"

test("arithmetic still works", () => {
  expect(1 + 1).toBe(2)
})

test("a measured assertion", () => {
  const t = performance.now()
  for (let i = 0; i < 1e6; i++) Math.sqrt(i)
  expect(performance.now() - t).toBeLessThan(250)
})
`,
  },
}

const GEN_SYSTEM = `You write self-contained Bun TypeScript files for a developer's benchmark playground. Reply with EXACTLY ONE fenced \`\`\`ts code block and no prose.
- Benchmarks: warm up first, collect many samples with performance.now(), print median, p95, min, max and ops/sec per case with console.log. Keep total runtime under ~20 seconds.
- Tests: use bun:test (import { test, expect } from "bun:test").
- The file runs with Bun inside the nikcli monorepo (packages/nikcli), so it may import repo modules via relative paths. Do not install packages. No network access unless the user asks for it.`

function ScriptLab() {
  const [tpl, setTpl] = createSignal("Micro-benchmark")
  const [code, setCode] = createSignal(TEMPLATES["Micro-benchmark"].code)
  const [kind, setKind] = createSignal<"script" | "test">("script")
  const [describeText, setDescribe] = createSignal("")
  const [generating, setGenerating] = createSignal(false)
  const [runId, setRunId] = createSignal<string>()
  const run = createMemo(() => runner.runs.find((r) => r.id === runId()))

  const generate = async () => {
    if (!describeText().trim()) return
    setGenerating(true)
    try {
      const reply = await runApp(
        Agent.use((a) =>
          a.ask({ title: "[devhub] generate benchmark", system: GEN_SYSTEM, text: describeText().trim() }),
        ),
      )
      const m = /```(?:ts|typescript)?\n([\s\S]*?)```/.exec(textOf(reply))
      if (!m) throw new Error("The model did not return a code block")
      setCode(m[1].trim() + "\n")
      setKind(/from ["']bun:test["']/.test(m[1]) ? "test" : "script")
      toastOk("Benchmark generated", "Review it, then run")
    } catch (e) {
      toastError("Could not generate", e)
    } finally {
      setGenerating(false)
    }
  }

  const start = async () => {
    try {
      const name = `lab-${Date.now().toString(36)}.${kind() === "test" ? "test.ts" : "ts"}`
      const rel = await native.writeScratch(name, code())
      setRunId(
        await runner.start({
          kind: kind() === "test" ? "test" : "bench",
          label: `playground · ${name}`,
          cwd: "packages/nikcli",
          args: kind() === "test" ? ["test", `../../${rel}`] : ["run", `../../${rel}`],
          junit: kind() === "test",
        }),
      )
    } catch (e) {
      toastError("Could not run", e)
    }
  }

  return (
    <div class="dh-grid" data-cols="2">
      <div class="dh-stack">
        <Panel title="Describe it, get a benchmark">
          <textarea
            class="dh-input"
            style={{ "min-height": "72px" }}
            placeholder="e.g. Measure how fast we can parse 10,000 session JSON blobs with JSON.parse vs Bun.JSONL…"
            value={describeText()}
            onInput={(e) => setDescribe(e.currentTarget.value)}
          />
          <div class="dh-toolbar" style={{ "margin-top": "8px" }}>
            <span class="dh-sub">Written by the model you picked in the assistant (default if none).</span>
            <Button
              size="small"
              variant="primary"
              style={{ "margin-left": "auto" }}
              disabled={generating() || !describeText().trim()}
              onClick={() => void generate()}
            >
              {generating() ? "Writing…" : "Generate"}
            </Button>
          </div>
        </Panel>
        <Panel
          title="Script"
          class="flush"
          actions={
            <>
              <Select
                size="small"
                options={Object.keys(TEMPLATES)}
                current={tpl()}
                onSelect={(t) => t && (setTpl(t), setCode(TEMPLATES[t].code), setKind(TEMPLATES[t].kind))}
              />
              <Select
                size="small"
                options={["script", "test"]}
                current={kind()}
                label={(k) => (k === "test" ? "bun test" : "bun run")}
                onSelect={(k) => k && setKind(k as "script" | "test")}
              />
              <Button
                size="small"
                variant="primary"
                disabled={run()?.status === "running"}
                onClick={() => void start()}
              >
                Run
              </Button>
              <Show when={run()?.status === "running"}>
                <Button size="small" onClick={() => void runner.cancel(run()!.id)}>
                  Stop
                </Button>
              </Show>
            </>
          }
        >
          <textarea
            class="dh-editor"
            spellcheck={false}
            value={code()}
            onInput={(e) => setCode(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault()
                const el = e.currentTarget
                const { selectionStart: a, selectionEnd: b } = el
                el.setRangeText("  ", a, b, "end")
                setCode(el.value)
              } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void start()
            }}
          />
        </Panel>
      </div>
      <div class="dh-stack">
        <Show
          when={run()}
          fallback={
            <Panel title="Output">
              <Empty>{shortcut("⏎")} or Run — scripts execute with Bun inside packages/nikcli and stream here.</Empty>
            </Panel>
          }
        >
          {(r) => (
            <SolidSwitch>
              <Match when={r().kind === "test"}>
                <RunSummary run={r()} />
              </Match>
              <Match when={true}>
                <Panel
                  title={`${r().label} — ${r().status}${r().durationMs ? ` in ${duration(r().durationMs! / 1000)}` : ""}`}
                  class="flush"
                >
                  <RunLog run={r()} />
                </Panel>
              </Match>
            </SolidSwitch>
          )}
        </Show>
      </div>
    </div>
  )
}

export function Playground() {
  const [tab, setTab] = createSignal(localStorage.getItem("devhub.play.tab") ?? "models")
  return (
    <Page
      title="Playground"
      subtitle="Benchmark models, load-test endpoints and run scripts — all against your real nikcli"
    >
      <Tabs value={tab()} onChange={(t) => (setTab(t), localStorage.setItem("devhub.play.tab", t))} variant="alt">
        <Tabs.List>
          <Tabs.Trigger value="models">Model bench</Tabs.Trigger>
          <Tabs.Trigger value="load">Endpoint load</Tabs.Trigger>
          <Tabs.Trigger value="script">Script lab</Tabs.Trigger>
        </Tabs.List>
      </Tabs>
      <SolidSwitch>
        <Match when={tab() === "models"}>
          <ModelBench />
        </Match>
        <Match when={tab() === "load"}>
          <LoadTest />
        </Match>
        <Match when={tab() === "script"}>
          <ScriptLab />
        </Match>
      </SolidSwitch>
    </Page>
  )
}

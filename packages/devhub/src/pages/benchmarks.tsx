import { For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { Select } from "@nikcli-ai/ui/select"
import { createPoll, toastError } from "../lib/store"
import { native, type BenchRecord, type BenchRun, type PerfBaseline } from "../lib/native"
import { runner } from "../lib/tasks"
import { duration, ms, num, when } from "../lib/format"
import { Empty, Loading, Page, Panel, Problem, Spark, Stat } from "../components/kit"
import { RunLog } from "./tests"

const unit = (v: number, u: string) =>
  u === "ms"
    ? ms(v)
    : u === "bytes"
      ? `${num(v)} B`
      : `${v.toFixed(v < 10 ? 3 : 1)} ${u === "value" || u === "count" ? "" : u}`
const rkey = (r: BenchRecord) => `${r.suite}/${r.module}/${r.scenario}`
const PROBE_FILE = ".devhub/perf-live.json"
/** The suite only persists its records (what this page compares) when asked to. */
const BENCH_SAVE_ENV = { NIKCLI_BENCHMARK_SAVE: "1", NIKCLI_BENCHMARK_PER_FILE: "1" }

export function Benchmarks() {
  const data = createPoll(() => native.benchmarks(), 0)
  const live = createPoll(async () => {
    try {
      return JSON.parse(await native.readRepoFile(PROBE_FILE)) as PerfBaseline
    } catch {
      return undefined
    }
  }, 0)
  const [baseId, setBase] = createSignal<string>()
  const [curId, setCur] = createSignal<string>()
  const [samples, setSamples] = createSignal("30")

  const runs = () => data.data()?.runs ?? []
  const base = createMemo<BenchRun | undefined>(() => runs().find((r) => r.runId === baseId()) ?? runs()[1])
  const cur = createMemo<BenchRun | undefined>(() => runs().find((r) => r.runId === curId()) ?? runs()[0])

  const rows = createMemo(() => {
    const b = new Map((base()?.records ?? []).map((r) => [rkey(r), r]))
    return (cur()?.records ?? [])
      .map((r) => {
        const o = b.get(rkey(r))
        const delta = o && o.value ? ((r.value - o.value) / o.value) * 100 : undefined
        return { r, o, delta }
      })
      .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
  })
  const regressions = () => rows().filter((x) => x.delta !== undefined && x.delta > 10 && x.r.unit === "ms").length

  const active = () => runner.runs.find((r) => r.kind === "bench")
  const launch = async (label: string, args: string[], env?: Record<string, string>, cwd = "packages/nikcli") => {
    try {
      await runner.start({ kind: "bench", label, cwd, args, env })
      const done = setInterval(() => {
        if (!runner.active().some((r) => r.kind === "bench")) {
          clearInterval(done)
          void data.reload()
          void live.reload()
        }
      }, 1000)
    } catch (e) {
      toastError("Could not start benchmark", e)
    }
  }
  const scenarioHistory = (r: BenchRecord) =>
    runs()
      .slice()
      .reverse()
      .flatMap((run) => run.records.filter((x) => rkey(x) === rkey(r)).map((x) => x.value))

  const baseline = () => data.data()?.baseline
  const liveRoutes = createMemo(() => {
    const b = new Map((baseline()?.routes ?? []).map((r) => [r.name, r]))
    return (live.data()?.routes ?? []).map((r) => ({ r, o: b.get(r.name) }))
  })

  return (
    <Page
      title="Benchmarks"
      subtitle="Stored benchmark runs, the recorded perf baseline and live probes against a real in-process server"
      actions={
        <>
          <Button size="small" onClick={() => void data.reload()}>
            Reload
          </Button>
          <Button
            size="small"
            onClick={() => void launch("Benchmark suite (test:bench)", ["run", "test:bench"], BENCH_SAVE_ENV)}
          >
            Run benchmark suite
          </Button>
          <input
            class="dh-input"
            style={{ "min-width": "64px", width: "64px" }}
            title="Samples per route"
            value={samples()}
            onInput={(e) => setSamples(e.currentTarget.value)}
          />
          <Button
            size="small"
            variant="primary"
            onClick={() =>
              void launch("Perf probe (live routes)", [
                "run",
                "script/perf-baseline.ts",
                "--samples",
                String(Number(samples()) || 30),
                "--json",
                `../../${PROBE_FILE}`,
              ])
            }
          >
            Probe routes
          </Button>
        </>
      }
    >
      <Problem error={data.error()} title="Could not read benchmark data" />
      <Show when={!data.loading()} fallback={<Loading />}>
        <div class="dh-grid" data-cols="4">
          <Stat label="Stored runs" value={runs().length} hint="on disk, newest first" />
          <Stat
            label="Scenarios"
            value={cur()?.records.length ?? 0}
            hint={cur() ? `latest run · ${when(cur()!.createdAt)}` : "no run yet"}
          />
          <Stat
            label="Regressions >10%"
            value={regressions()}
            tone={regressions() ? "bad" : "ok"}
            hint="vs selected baseline run"
          />
          <Stat
            label="Perf baseline"
            value={baseline() ? `${baseline()!.routes.length} routes` : "none"}
            hint={baseline() ? `recorded ${when(baseline()!.recordedAt)}` : undefined}
          />
        </div>

        <Show when={active()}>
          {(a) => (
            <Panel
              title={`${a().label} — ${a().status}${a().durationMs ? ` in ${duration(a().durationMs! / 1000)}` : ""}`}
              class="flush"
              actions={
                <Show when={a().status === "running"}>
                  <Button size="small" onClick={() => void runner.cancel(a().id)}>
                    Stop
                  </Button>
                </Show>
              }
            >
              <RunLog run={a()} />
            </Panel>
          )}
        </Show>

        <Panel
          title="Compare runs"
          class="flush"
          actions={
            <>
              <Select
                size="small"
                options={runs().map((r) => r.runId)}
                current={base()?.runId}
                label={(id) => `base: ${id}`}
                onSelect={(v) => setBase(v)}
              />
              <Select
                size="small"
                options={runs().map((r) => r.runId)}
                current={cur()?.runId}
                label={(id) => `current: ${id}`}
                onSelect={(v) => setCur(v)}
              />
            </>
          }
        >
          <div class="dh-scroll" style={{ "max-height": "46vh" }}>
            <Show
              when={rows().length}
              fallback={<Empty>No stored benchmark runs. Use “Run benchmark suite” to create one.</Empty>}
            >
              <table class="dh-table">
                <thead>
                  <tr>
                    <th>Scenario</th>
                    <th class="dh-num">Baseline</th>
                    <th class="dh-num">Current</th>
                    <th class="dh-num">Δ</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {({ r, o, delta }) => (
                      <tr>
                        <td class="dh-fill">
                          <div class="dh-ellipsis" title={rkey(r)}>
                            {r.scenario}
                          </div>
                          <div class="dh-mono" style={{ color: "var(--text-weak)" }}>
                            {r.suite} · {r.module}
                          </div>
                        </td>
                        <td class="dh-num">{o ? unit(o.value, o.unit) : "—"}</td>
                        <td class="dh-num">{unit(r.value, r.unit)}</td>
                        <td
                          class="dh-num"
                          classList={{ "dh-delta-bad": (delta ?? 0) > 10, "dh-delta-good": (delta ?? 0) < -10 }}
                        >
                          {delta === undefined ? "new" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`}
                        </td>
                        <td style={{ width: "120px" }}>
                          <Spark values={scenarioHistory(r)} height={22} />
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </Panel>

        <div class="dh-grid" data-cols="2">
          <Panel title="Recorded baseline (specs/perf-baseline.json)" class="flush">
            <Show when={baseline()} fallback={<Empty>No baseline recorded.</Empty>}>
              <table class="dh-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th class="dh-num">median</th>
                    <th class="dh-num">p95</th>
                    <th class="dh-num">max</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={baseline()!.routes}>
                    {(r) => (
                      <tr>
                        <td class="dh-mono">
                          {r.method} {r.path}
                        </td>
                        <td class="dh-num">{ms(r.median)}</td>
                        <td class="dh-num">{ms(r.p95)}</td>
                        <td class="dh-num">{ms(r.max)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </Panel>
          <Panel title="Live probe vs baseline" class="flush">
            <Show
              when={liveRoutes().length}
              fallback={<Empty>Press “Probe routes” to measure the real router now.</Empty>}
            >
              <table class="dh-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th class="dh-num">median</th>
                    <th class="dh-num">p95</th>
                    <th class="dh-num">Δ median</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={liveRoutes()}>
                    {({ r, o }) => {
                      const d = o ? ((r.median - o.median) / o.median) * 100 : undefined
                      return (
                        <tr>
                          <td class="dh-mono">
                            {r.method} {r.path}
                          </td>
                          <td class="dh-num">{ms(r.median)}</td>
                          <td class="dh-num">{ms(r.p95)}</td>
                          <td
                            class="dh-num"
                            classList={{ "dh-delta-bad": (d ?? 0) > 25, "dh-delta-good": (d ?? 0) < -25 }}
                          >
                            {d === undefined ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(0)}%`}
                          </td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </Panel>
        </div>
      </Show>
    </Page>
  )
}

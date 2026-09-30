import { shortcut } from "../lib/platform"
import { Show, createMemo, createSignal, onCleanup } from "solid-js"
import { app, createPoll } from "../lib/store"
import { runner } from "../lib/tasks"
import { assistant } from "../lib/assistant"
import { bytes, pct } from "../lib/format"
import { Dot, Spark } from "./kit"

/** Always-visible telemetry strip: the task-manager heartbeat of the app. */
export function StatusBar(props: { go: (id: string) => void }) {
  const health = createPoll(
    async () => {
      const c = app.client()
      if (!c) return undefined
      const t = performance.now()
      const r = await c.global.health()
      if (r.error !== undefined) throw new Error("unhealthy")
      return { version: r.data!.version, latency: performance.now() - t }
    },
    5000,
    () => app.service()?.url,
  )
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))

  const snap = () => app.snapshot()
  const age = () => (snap() ? Math.max(0, Math.round((now() - snap()!.at) / 1000)) : undefined)
  const own = createMemo(
    () => snap()?.procs.filter((p) => ["service", "server", "cli", "test", "dev", "child"].includes(p.category)) ?? [],
  )
  const rss = () => own().reduce((a, p) => a + p.rss, 0)
  const h = app.history
  const memPct = () => (snap() ? (snap()!.memUsed / snap()!.memTotal) * 100 : 0)
  const running = () => runner.active().length

  return (
    <footer class="dh-status" role="status">
      <button class="dh-status__item" onClick={() => props.go("overview")} title={app.service()?.url}>
        <Dot tone={health.data() ? "ok" : app.service() ? "bad" : "idle"} live={!!health.data()} />
        <Show when={health.data()} fallback={<span>{app.service() ? "service unreachable" : "no service"}</span>}>
          <span>nikcli {health.data()!.version}</span>
          <em>{health.data()!.latency.toFixed(0)} ms</em>
        </Show>
      </button>
      <button class="dh-status__item" onClick={() => props.go("processes")}>
        <span>CPU</span>
        <strong>{pct(snap()?.cpuUsage ?? 0, 0)}</strong>
        <div class="dh-status__spark">
          <Spark values={h().map((s) => s.cpu)} max={100} height={14} fill={false} />
        </div>
      </button>
      <button class="dh-status__item" onClick={() => props.go("processes")}>
        <span>MEM</span>
        <strong>{pct(memPct(), 0)}</strong>
        <div class="dh-status__spark">
          <Spark values={h().map((s) => s.mem)} max={100} height={14} fill={false} />
        </div>
      </button>
      <button class="dh-status__item" onClick={() => props.go("processes")}>
        <span>nikcli</span>
        <strong>{bytes(rss())}</strong>
        <em>{own().length} proc</em>
      </button>
      <Show when={running()}>
        <button class="dh-status__item" data-hot onClick={() => props.go("tests")}>
          <Dot tone="warn" live />
          <span>{running()} running</span>
        </button>
      </Show>
      <span class="dh-status__spacer" />
      <span class="dh-status__item dh-status__quiet">
        {app.paused() ? "paused" : age() === undefined ? "sampling…" : `sampled ${age()}s ago`}
      </span>
      <button
        class="dh-status__item"
        data-active={assistant.open()}
        onClick={() => assistant.toggle()}
        title={`Toggle assistant (${shortcut("J")})`}
      >
        <span>Assistant</span>
        <kbd>{shortcut("J")}</kbd>
      </button>
    </footer>
  )
}

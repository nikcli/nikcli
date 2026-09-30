import { shortcut } from "../lib/platform"
import { Show, createMemo, createSignal, onCleanup } from "solid-js"
import { app } from "../lib/store"
import { runner } from "../lib/tasks"
import { assistant } from "../lib/assistant"
import { bytes, pct } from "../lib/format"
import { Dot, Spark } from "./kit"

/** Always-visible telemetry strip: the task-manager heartbeat of the app. */
export function StatusBar(props: { go: (id: string) => void }) {
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
      <button
        class="dh-status__item"
        onClick={() => props.go("overview")}
        title={app.health().error ?? app.service()?.url}
      >
        <Dot
          tone={
            app.health().state === "ok"
              ? "ok"
              : app.health().state === "slow" || app.health().state === "connecting"
                ? "warn"
                : app.service()
                  ? "bad"
                  : "idle"
          }
          live={app.health().state === "ok"}
        />
        <Show
          when={app.health().version}
          fallback={
            <span>
              {!app.service()
                ? "no service"
                : app.health().state === "connecting"
                  ? "connecting…"
                  : "service unreachable"}
            </span>
          }
        >
          <span>nikcli {app.health().version}</span>
          <em>
            {app.health().state === "slow"
              ? `busy · ${app.health().latency!.toFixed(0)} ms`
              : `${app.health().latency!.toFixed(0)} ms`}
          </em>
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

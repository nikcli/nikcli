import { For, Match, Show, Switch as SolidSwitch, createMemo, createSignal } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { Switch } from "@nikcli-ai/ui/switch"
import { Tabs } from "@nikcli-ai/ui/tabs"
import { aggregate, events, isError, quantile, traceTree, type Span } from "../lib/events"
import { app } from "../lib/store"
import { ms, num } from "../lib/format"
import { Dot, Empty, KV, Page, Panel, Spark, Stat } from "../components/kit"

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false })
const STATE_TONE = { live: "ok", connecting: "warn", reconnecting: "warn", error: "bad", idle: "idle" } as const

function Waterfall(props: { traceId: string; selected?: string; onSelect: (s: Span) => void }) {
  const tree = createMemo(() => traceTree(events.spans(), props.traceId))
  const span = () => Math.max(tree().end - tree().start, 0.001)
  return (
    <div class="dh-waterfall">
      <For each={tree().nodes}>
        {(n) => (
          <button
            class="dh-wf-row"
            data-selected={n.span.id === props.selected}
            data-error={isError(n.span)}
            onClick={() => props.onSelect(n.span)}
          >
            <span class="dh-wf-name" style={{ "padding-left": `${n.depth * 12}px` }} title={n.span.name}>
              {n.span.name}
            </span>
            <span class="dh-wf-track">
              <i
                style={{
                  left: `${(n.offset / span()) * 100}%`,
                  width: `max(2px, ${(n.span.durationMs / span()) * 100}%)`,
                }}
              />
            </span>
            <span class="dh-num">{ms(n.span.durationMs)}</span>
          </button>
        )}
      </For>
    </div>
  )
}

export function Telemetry() {
  const [tab, setTab] = createSignal(localStorage.getItem("devhub.tel.tab") ?? "spans")
  const [q, setQ] = createSignal("")
  const [onlyErrors, setOnlyErrors] = createSignal(false)
  const [minMs, setMinMs] = createSignal("0")
  const [sel, setSel] = createSignal<Span>()
  const [evFilter, setEvFilter] = createSignal("")

  const spans = events.spans
  const durations = createMemo(() =>
    spans()
      .map((s) => s.durationMs)
      .sort((a, b) => a - b),
  )
  const errors = createMemo(() => spans().filter(isError).length)
  const ops = createMemo(() => aggregate(spans()))
  const shown = createMemo(() => {
    const needle = q().toLowerCase()
    const min = Number(minMs()) || 0
    const out: Span[] = []
    const all = spans()
    for (let i = all.length - 1; i >= 0 && out.length < 400; i--) {
      const s = all[i]
      if (onlyErrors() && !isError(s)) continue
      if (s.durationMs < min) continue
      if (needle && !`${s.name} ${s.kind} ${s.traceId}`.toLowerCase().includes(needle)) continue
      out.push(s)
    }
    return out
  })
  const slowest = createMemo(() =>
    spans().reduce<Span | undefined>((m, s) => (!m || s.durationMs > m.durationMs ? s : m), undefined),
  )
  const typeCounts = createMemo(() =>
    Object.entries(events.counts())
      .filter(([t]) => t !== "telemetry.record")
      .sort((a, b) => b[1] - a[1]),
  )
  const feed = createMemo(() => {
    const needle = evFilter().toLowerCase()
    const all = events.feed()
    const out = []
    for (let i = all.length - 1; i >= 0 && out.length < 300; i--)
      if (!needle || `${all[i].type} ${all[i].summary} ${all[i].sessionID ?? ""}`.toLowerCase().includes(needle))
        out.push(all[i])
    return out
  })
  const total = () => events.rate().reduce((a, b) => a + b, 0)

  return (
    <Page
      title="Telemetry"
      subtitle="Live spans and events straight from the nikcli service bus — what it is doing right now, with timings"
      actions={
        <>
          <Switch checked={!events.paused()} onChange={(v) => events.setPaused(!v)}>
            Live
          </Switch>
          <Button size="small" onClick={() => events.clear()}>
            Clear
          </Button>
        </>
      }
    >
      <div class="dh-grid" data-cols="4">
        <Stat
          label="Stream"
          value={events.state()}
          tone={
            events.state() === "live"
              ? "ok"
              : events.state() === "error"
                ? "bad"
                : events.state() === "idle"
                  ? undefined
                  : "warn"
          }
          hint={
            events.detail() ?? (app.service() ? `/global/event · ${num(events.total())} events` : "no running service")
          }
        />
        <Stat label="Events / s" value={(total() / 60).toFixed(1)} hint="60 s average" spark={events.rate()} />
        <Stat
          label="Spans"
          value={num(spans().length)}
          tone={errors() ? "bad" : undefined}
          hint={
            spans().length
              ? `${errors()} errors · ${((errors() / spans().length) * 100).toFixed(1)}%`
              : "waiting for activity"
          }
        />
        <Stat
          label="Span p95"
          value={spans().length ? ms(quantile(durations(), 0.95)) : "—"}
          hint={slowest() ? `slowest ${slowest()!.name} ${ms(slowest()!.durationMs)}` : undefined}
        />
      </div>

      <Tabs value={tab()} onChange={(t) => (setTab(t), localStorage.setItem("devhub.tel.tab", t))} variant="alt">
        <Tabs.List>
          <Tabs.Trigger value="spans">Spans</Tabs.Trigger>
          <Tabs.Trigger value="ops">Operations</Tabs.Trigger>
          <Tabs.Trigger value="events">Events</Tabs.Trigger>
        </Tabs.List>
      </Tabs>

      <SolidSwitch>
        <Match when={tab() === "spans"}>
          <div class="dh-grid" data-cols={sel() ? "wide-left" : undefined}>
            <Panel
              title={`Spans · ${shown().length}${spans().length > shown().length ? ` of ${num(spans().length)}` : ""}`}
              class="flush"
            >
              <div class="dh-toolbar dh-compact-inputs" style={{ padding: "10px 12px" }}>
                <input
                  class="dh-input"
                  style={{ flex: 1 }}
                  placeholder="Filter by name, kind or trace id…"
                  value={q()}
                  onInput={(e) => setQ(e.currentTarget.value)}
                />
                <input
                  class="dh-input"
                  style={{ width: "88px" }}
                  title="Minimum duration (ms)"
                  placeholder="min ms"
                  value={minMs() === "0" ? "" : minMs()}
                  onInput={(e) => setMinMs(e.currentTarget.value || "0")}
                />
                <Switch checked={onlyErrors()} onChange={setOnlyErrors}>
                  Errors
                </Switch>
              </div>
              <div class="dh-scroll" style={{ "max-height": "56vh" }}>
                <Show
                  when={shown().length}
                  fallback={
                    <Empty>
                      {events.state() === "live"
                        ? "Connected — spans appear as nikcli works (send a prompt, run something)."
                        : "Waiting for the event stream…"}
                    </Empty>
                  }
                >
                  <table class="dh-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Span</th>
                        <th class="dh-num">Duration</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={shown()}>
                        {(s) => (
                          <tr
                            data-clickable="true"
                            data-selected={sel()?.id === s.id}
                            onClick={() => setSel(sel()?.id === s.id ? undefined : s)}
                          >
                            <td class="dh-mono dh-sub" style={{ width: "74px" }}>
                              {clock(s.startTime)}
                            </td>
                            <td class="dh-fill">
                              <div class="dh-ellipsis" title={s.name}>
                                {s.name}
                              </div>
                            </td>
                            <td class="dh-num">{ms(s.durationMs)}</td>
                            <td style={{ width: "64px" }}>
                              <span class="dh-chip" data-tone={isError(s) ? "bad" : "ok"}>
                                {isError(s) ? "error" : "ok"}
                              </span>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </div>
            </Panel>
            <Show when={sel()}>
              {(s) => (
                <div class="dh-stack">
                  <Panel
                    title="Span"
                    actions={
                      <Button size="small" variant="ghost" onClick={() => setSel(undefined)}>
                        Close
                      </Button>
                    }
                  >
                    <KV
                      rows={[
                        ["Name", s().name],
                        ["Kind", s().kind],
                        ["Duration", ms(s().durationMs)],
                        ["Started", new Date(s().startTime).toLocaleString()],
                        ["Status", isError(s()) ? `error${s().statusMessage ? ` · ${s().statusMessage}` : ""}` : "ok"],
                        ["Trace", <span class="dh-mono">{s().traceId}</span>],
                        ["Directory", <span class="dh-mono">{s().directory ?? "—"}</span>],
                        ...Object.entries(s().attributes ?? {}).map(
                          ([k, v]) => [k, <span class="dh-mono">{v}</span>] as [string, import("solid-js").JSX.Element],
                        ),
                      ]}
                    />
                  </Panel>
                  <Panel title={`Trace · ${traceTree(spans(), s().traceId).nodes.length} spans`} class="flush">
                    <Waterfall traceId={s().traceId} selected={s().id} onSelect={setSel} />
                  </Panel>
                </div>
              )}
            </Show>
          </div>
        </Match>

        <Match when={tab() === "ops"}>
          <Panel title={`Operations · ${ops().length}`} class="flush">
            <div class="dh-scroll" style={{ "max-height": "62vh" }}>
              <Show when={ops().length} fallback={<Empty>No spans captured yet.</Empty>}>
                <table class="dh-table">
                  <thead>
                    <tr>
                      <th>Operation</th>
                      <th class="dh-num">Count</th>
                      <th class="dh-num">Total</th>
                      <th class="dh-num">Mean</th>
                      <th class="dh-num">p50</th>
                      <th class="dh-num">p95</th>
                      <th class="dh-num">Max</th>
                      <th class="dh-num">Errors</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={ops()}>
                      {(o) => (
                        <tr data-clickable="true" onClick={() => (setQ(o.name), setTab("spans"))}>
                          <td class="dh-fill">
                            <div class="dh-ellipsis" title={o.name}>
                              {o.name}
                            </div>
                            <div class="dh-sub">{o.kind}</div>
                          </td>
                          <td class="dh-num">{num(o.count)}</td>
                          <td class="dh-num">{ms(o.total)}</td>
                          <td class="dh-num">{ms(o.mean)}</td>
                          <td class="dh-num">{ms(o.p50)}</td>
                          <td class="dh-num">{ms(o.p95)}</td>
                          <td class="dh-num">{ms(o.max)}</td>
                          <td class="dh-num" classList={{ "dh-delta-bad": o.errors > 0 }}>
                            {o.errors}
                          </td>
                          <td style={{ width: "96px" }}>
                            <div class="dh-bar">
                              <div style={{ width: `${(o.total / (ops()[0]?.total || 1)) * 100}%` }} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </div>
          </Panel>
        </Match>

        <Match when={tab() === "events"}>
          <div class="dh-grid" data-cols="wide-left">
            <Panel title={`Bus events · ${feed().length}`} class="flush">
              <div class="dh-toolbar dh-compact-inputs" style={{ padding: "10px 12px" }}>
                <input
                  class="dh-input"
                  style={{ flex: 1 }}
                  placeholder="Filter by type, session or text…"
                  value={evFilter()}
                  onInput={(e) => setEvFilter(e.currentTarget.value)}
                />
              </div>
              <div class="dh-scroll" style={{ "max-height": "56vh" }}>
                <Show when={feed().length} fallback={<Empty>No events yet.</Empty>}>
                  <table class="dh-table">
                    <tbody>
                      <For each={feed()}>
                        {(e) => (
                          <tr>
                            <td class="dh-mono dh-sub" style={{ width: "74px" }}>
                              {clock(e.at)}
                            </td>
                            <td class="dh-mono" style={{ width: "190px" }}>
                              {e.type}
                            </td>
                            <td class="dh-fill">
                              <div class="dh-ellipsis dh-sub" title={`${e.sessionID ?? ""} ${e.summary}`}>
                                {e.summary || e.sessionID}
                              </div>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </div>
            </Panel>
            <Panel title="By type">
              <div class="dh-toolbar">
                <For each={typeCounts()} fallback={<span class="dh-sub">Nothing yet.</span>}>
                  {([t, n]) => (
                    <button class="dh-chip dh-chip--button" onClick={() => setEvFilter(t)}>
                      {t} · {num(n)}
                    </button>
                  )}
                </For>
              </div>
            </Panel>
          </div>
        </Match>
      </SolidSwitch>
      <Show when={events.state() === "idle"}>
        <Empty>
          <Dot tone={STATE_TONE.idle} /> Start a nikcli service to see live telemetry.
        </Empty>
      </Show>
    </Page>
  )
}

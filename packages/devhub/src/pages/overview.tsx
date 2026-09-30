import { For, Show, createMemo } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { Tag } from "@nikcli-ai/ui/tag"
import { app, createPoll } from "../lib/store"
import { unwrap } from "../lib/api"
import { bytes, compact, duration, pct, usd, when } from "../lib/format"
import { runner } from "../lib/tasks"
import { Bar, Dot, KV, Loading, Page, Panel, Problem, Spark, Stat } from "../components/kit"

const OWN = ["service", "server", "cli", "test", "dev", "child"]

export function Overview(props: { go: (id: string) => void }) {
  const svc = () => app.service()
  const health = createPoll(
    async () => {
      const c = app.client()
      if (!c) return undefined
      const t = performance.now()
      const h = await unwrap(c.global.health())
      return { ...h, latency: performance.now() - t }
    },
    5000,
    svc,
  )
  const analytics = createPoll(
    async () => (app.client() ? unwrap(app.client()!.analytics.global()) : undefined),
    30000,
    svc,
  )
  const doctor = createPoll(async () => (app.client() ? unwrap(app.client()!.doctor.run()) : undefined), 60000, svc)

  const snap = app.snapshot
  const own = createMemo(() => snap()?.procs.filter((p) => OWN.includes(p.category)) ?? [])
  const ownRss = createMemo(() => own().reduce((a, p) => a + p.rss, 0))
  const ownCpu = createMemo(() => own().reduce((a, p) => a + p.cpu, 0))
  const servicePid = createMemo(() => snap()?.procs.find((p) => p.pid === svc()?.pid))
  const h = app.history
  const memPct = () => (snap() ? (snap()!.memUsed / snap()!.memTotal) * 100 : 0)
  const recent = () => runner.runs.slice(0, 5)

  return (
    <Page
      title="Overview"
      subtitle={
        snap()
          ? `${snap()!.host ?? "this machine"} · ${snap()!.os ?? ""} · up ${duration(snap()!.uptime)}`
          : "Connecting…"
      }
      actions={
        <Button size="small" icon="arrow-right" onClick={() => void app.refreshNow()}>
          Refresh
        </Button>
      }
    >
      <Problem error={app.error()} title="System probe failed" />
      <Problem error={health.error()} title="nikcli service unreachable" />
      <Show when={!svc()}>
        <Problem
          error="Start one with `nikcli serve --service` (or launch the nikcli TUI) and it will appear here."
          title="No local nikcli service registered"
        />
      </Show>

      <div class="dh-grid" data-cols="4">
        <Stat
          label="Service"
          tone={health.data() ? "ok" : "bad"}
          value={health.data() ? "Healthy" : health.error() ? "Down" : "…"}
          hint={
            health.data()
              ? `v${health.data()!.version} · ${health.data()!.latency.toFixed(0)} ms round trip`
              : undefined
          }
        />
        <Stat
          label="nikcli processes"
          value={own().length}
          hint={`${bytes(ownRss())} resident · ${pct(ownCpu())} CPU`}
          spark={h().map((s) => s.nikcliRss)}
        />
        <Stat
          label="Host CPU"
          value={pct(snap()?.cpuUsage ?? 0)}
          tone={(snap()?.cpuUsage ?? 0) > 90 ? "bad" : undefined}
          hint={
            snap()
              ? `${snap()!.cpuCount} cores · load ${snap()!
                  .load.map((l) => l.toFixed(2))
                  .join(" ")}`
              : undefined
          }
          spark={h().map((s) => s.cpu)}
          sparkMax={100}
        />
        <Stat
          label="Host memory"
          value={pct(memPct(), 0)}
          tone={memPct() > 90 ? "bad" : memPct() > 80 ? "warn" : undefined}
          hint={
            snap()
              ? `${bytes(snap()!.memUsed)} of ${bytes(snap()!.memTotal)} · swap ${bytes(snap()!.swapUsed)}`
              : undefined
          }
          spark={h().map((s) => s.mem)}
          sparkMax={100}
        />
      </div>

      <div class="dh-grid" data-cols="2">
        <Panel
          title="Service"
          actions={
            <Button size="small" variant="ghost" onClick={() => props.go("processes")}>
              Processes
            </Button>
          }
        >
          <Show when={svc()} fallback={<span>—</span>}>
            <KV
              rows={[
                ["URL", <span class="dh-mono">{svc()!.url}</span>],
                ["Channel", svc()!.channel],
                [
                  "Version",
                  `${svc()!.version}${health.data()?.revision ? ` · ${health.data()!.revision!.slice(0, 10)}` : ""}`,
                ],
                [
                  "Started",
                  svc()!.startedAt
                    ? `${when(svc()!.startedAt)} (${duration((Date.now() - svc()!.startedAt) / 1000)} ago)`
                    : "—",
                ],
                ["PID", svc()!.pid],
                [
                  "Memory",
                  servicePid()
                    ? `${bytes(servicePid()!.rss)} resident · ${bytes(servicePid()!.virt)} virtual`
                    : "process not visible",
                ],
                ["CPU", servicePid() ? pct(servicePid()!.cpu) : "—"],
                ["Auth", svc()!.hasPassword ? <Tag>channel password</Tag> : <Tag>none</Tag>],
              ]}
            />
          </Show>
        </Panel>
        <Panel
          title="Doctor"
          actions={
            <Button size="small" variant="ghost" onClick={() => void doctor.reload()}>
              Run again
            </Button>
          }
        >
          <Problem error={doctor.error()} />
          <Show when={doctor.loading() && !doctor.data()}>
            <Loading label="Running checks…" />
          </Show>
          <Show when={doctor.data()}>
            {(d) => (
              <div class="dh-kv" style={{ "grid-template-columns": "1fr" }}>
                <For each={d().results}>
                  {(r) => (
                    <div style={{ display: "flex", gap: "8px", "align-items": "baseline" }}>
                      <Dot tone={r.ok ? "ok" : "bad"} />
                      <strong>{r.label}</strong>
                      <span style={{ color: "var(--text-weak)" }}>{r.detail}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </Show>
        </Panel>
      </div>

      <div class="dh-grid" data-cols="2">
        <Panel
          title="Lifetime usage"
          actions={
            <Button size="small" variant="ghost" onClick={() => props.go("activity")}>
              Details
            </Button>
          }
        >
          <Problem error={analytics.error()} />
          <Show when={analytics.loading() && !analytics.data()}>
            <Loading label="Reading analytics…" />
          </Show>
          <Show when={analytics.data()}>
            {(a) => (
              <KV
                rows={[
                  ["Sessions", compact(a().totals.sessions)],
                  ["Messages", compact(a().totals.messages)],
                  ["Tool calls", compact(a().totals.toolCalls)],
                  ["Tokens in / out", `${compact(a().totals.tokens.input)} / ${compact(a().totals.tokens.output)}`],
                  ["Cache read", compact(a().totals.tokens.cacheRead)],
                  ["Cost", usd(a().totals.cost)],
                  ["Providers", Object.keys(a().byProvider).length],
                  ["Updated", when(a().updatedAt)],
                ]}
              />
            )}
          </Show>
        </Panel>
        <Panel
          title="Recent runs"
          actions={
            <Button size="small" variant="ghost" onClick={() => props.go("tests")}>
              Open tests
            </Button>
          }
        >
          <Show
            when={recent().length}
            fallback={<span style={{ color: "var(--text-weak)" }}>No tests or benchmarks run yet.</span>}
          >
            <table class="dh-table">
              <tbody>
                <For each={recent()}>
                  {(r) => (
                    <tr>
                      <td>
                        <span
                          class="dh-chip"
                          data-tone={r.status === "passed" ? "ok" : r.status === "failed" ? "bad" : undefined}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td>{r.label}</td>
                      <td class="dh-num">{r.summary ? `${r.summary.pass} pass · ${r.summary.fail} fail` : ""}</td>
                      <td class="dh-num">{r.durationMs ? duration(r.durationMs / 1000) : ""}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Panel>
      </div>

      <Panel title="nikcli memory over time (resident, all nikcli processes)">
        <Spark values={h().map((s) => s.nikcliRss)} height={90} />
        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            "font-size": "11px",
            color: "var(--text-weak)",
          }}
        >
          <span>{h().length ? when(h()[0].at) : ""}</span>
          <span>peak {bytes(Math.max(0, ...h().map((s) => s.nikcliRss)))}</span>
          <Bar value={memPct()} />
        </div>
      </Panel>
    </Page>
  )
}

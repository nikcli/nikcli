import { For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { Select } from "@nikcli-ai/ui/select"
import { app, createPoll } from "../lib/store"
import { unwrap } from "../lib/api"
import { compact, duration, num, usd, when } from "../lib/format"
import { Empty, Loading, Page, Panel, Problem, Spark, Stat } from "../components/kit"

export function Activity() {
  const svc = () => app.service()
  const [days, setDays] = createSignal("30")
  const c = () => app.client()
  const global = createPoll(async () => (c() ? unwrap(c()!.analytics.global()) : undefined), 120_000, svc)
  const daily = createPoll(
    async () => (c() ? unwrap(c()!.analytics.daily({ days: days() })) : undefined),
    120_000,
    () => [svc(), days()],
  )
  const board = createPoll(async () => (c() ? unwrap(c()!.analytics.leaderboard()) : undefined), 180_000, svc)
  const sessions = createPoll(async () => (c() ? unwrap(c()!.analytics.sessions()) : undefined), 180_000, svc)

  const series = createMemo(() => [...(daily.data() ?? [])].sort((a, b) => a.date.localeCompare(b.date)))
  const tools = createMemo(() => {
    const m = new Map<string, { calls: number; success: number; error: number }>()
    for (const d of series())
      for (const [k, v] of Object.entries(d.tools)) {
        const e = m.get(k) ?? { calls: 0, success: 0, error: 0 }
        e.calls += v.calls
        e.success += v.success
        e.error += v.error
        m.set(k, e)
      }
    return [...m.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 14)
  })
  const recent = createMemo(() =>
    [...(sessions.data() ?? [])].sort((a, b) => b.time.created - a.time.created).slice(0, 60),
  )
  const total = (k: "messages" | "cost" | "toolCalls" | "sessions") => series().reduce((a, d) => a + d[k], 0)
  const tokens = (d: { tokens: { input: number; output: number; reasoning: number } }) =>
    d.tokens.input + d.tokens.output + d.tokens.reasoning

  return (
    <Page
      title="Activity"
      subtitle="Usage analytics straight from the nikcli service: tokens, cost, tools, models and sessions"
      actions={
        <>
          <Select
            size="small"
            options={["7", "14", "30", "90"]}
            current={days()}
            label={(d) => `last ${d} days`}
            onSelect={(d) => d && setDays(d)}
          />
          <Button
            size="small"
            onClick={() => (void global.reload(), void daily.reload(), void board.reload(), void sessions.reload())}
          >
            Reload
          </Button>
        </>
      }
    >
      <Problem error={global.error() ?? daily.error()} title="Analytics unavailable" />
      <Show when={global.data()} fallback={<Loading />}>
        {(g) => (
          <>
            <div class="dh-grid" data-cols="4">
              <Stat
                label={`Sessions · ${days()}d`}
                value={num(total("sessions"))}
                hint={`${compact(g().totals.sessions)} lifetime`}
                spark={series().map((d) => d.sessions)}
              />
              <Stat
                label={`Tokens · ${days()}d`}
                value={compact(series().reduce((a, d) => a + tokens(d), 0))}
                hint={`${compact(g().totals.tokens.input + g().totals.tokens.output)} lifetime`}
                spark={series().map(tokens)}
              />
              <Stat
                label={`Tool calls · ${days()}d`}
                value={compact(total("toolCalls"))}
                hint={`${compact(g().totals.toolCalls)} lifetime`}
                spark={series().map((d) => d.toolCalls)}
              />
              <Stat
                label={`Cost · ${days()}d`}
                value={usd(total("cost"))}
                hint={`${usd(g().totals.cost)} lifetime`}
                spark={series().map((d) => d.cost)}
              />
            </div>
            <div class="dh-grid" data-cols="2">
              <Panel title="Models" class="flush">
                <div class="dh-scroll" style={{ "max-height": "340px" }}>
                  <table class="dh-table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th class="dh-num">Sessions</th>
                        <th class="dh-num">Messages</th>
                        <th class="dh-num">Tokens</th>
                        <th class="dh-num">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={(board.data()?.models ?? []).slice(0, 40)}>
                        {(m) => (
                          <tr>
                            <td>
                              <div class="dh-ellipsis" style={{ "max-width": "260px" }} title={m.key}>
                                {m.modelID}
                              </div>
                              <div style={{ color: "var(--text-weak)", "font-size": "11px" }}>{m.providerID}</div>
                            </td>
                            <td class="dh-num">{num(m.sessions)}</td>
                            <td class="dh-num">{num(m.messages)}</td>
                            <td class="dh-num">{compact(m.totalTokens)}</td>
                            <td class="dh-num">{usd(m.cost)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Panel>
              <Panel title={`Tool usage · ${days()}d`} class="flush">
                <Show when={tools().length} fallback={<Empty>No tool calls in this window.</Empty>}>
                  <table class="dh-table">
                    <thead>
                      <tr>
                        <th>Tool</th>
                        <th class="dh-num">Calls</th>
                        <th class="dh-num">Errors</th>
                        <th class="dh-num">Success</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={tools()}>
                        {([name, t]) => (
                          <tr>
                            <td class="dh-mono">{name}</td>
                            <td class="dh-num">{num(t.calls)}</td>
                            <td class="dh-num" classList={{ "dh-delta-bad": t.error > 0 }}>
                              {num(t.error)}
                            </td>
                            <td class="dh-num">{t.calls ? `${((t.success / t.calls) * 100).toFixed(1)}%` : "—"}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </Panel>
            </div>
            <div class="dh-grid" data-cols="2">
              <Panel title="Providers" class="flush">
                <table class="dh-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th class="dh-num">Sessions</th>
                      <th class="dh-num">Messages</th>
                      <th class="dh-num">Tokens</th>
                      <th class="dh-num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={board.data()?.providers ?? []}>
                      {(p) => (
                        <tr>
                          <td>{p.id}</td>
                          <td class="dh-num">{num(p.sessions)}</td>
                          <td class="dh-num">{num(p.messages)}</td>
                          <td class="dh-num">{compact(p.tokens)}</td>
                          <td class="dh-num">{usd(p.cost)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Panel>
              <Panel title="Projects" class="flush">
                <div class="dh-scroll" style={{ "max-height": "300px" }}>
                  <table class="dh-table">
                    <tbody>
                      <For each={(board.data()?.projects ?? []).slice(0, 25)}>
                        {(p) => (
                          <tr>
                            <td class="dh-mono dh-ellipsis" style={{ "max-width": "260px" }} title={p.id}>
                              {p.id}
                            </td>
                            <td class="dh-num">{num(p.sessions)} sessions</td>
                            <td class="dh-num">{compact(p.tokens)}</td>
                            <td class="dh-num">{when(p.lastActive)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
            <Panel title="Recent sessions" class="flush">
              <div class="dh-scroll" style={{ "max-height": "420px" }}>
                <table class="dh-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Model</th>
                      <th class="dh-num">Messages</th>
                      <th class="dh-num">Tools</th>
                      <th class="dh-num">Tokens</th>
                      <th class="dh-num">Cost</th>
                      <th class="dh-num">Length</th>
                      <th>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={recent()}>
                      {(s) => (
                        <tr>
                          <td>
                            <div class="dh-ellipsis" style={{ "max-width": "260px" }} title={s.directory}>
                              {s.title}
                            </div>
                          </td>
                          <td class="dh-mono dh-ellipsis" style={{ "max-width": "200px" }}>
                            {s.modelID}
                          </td>
                          <td class="dh-num">{s.messages}</td>
                          <td class="dh-num">{s.toolCalls}</td>
                          <td class="dh-num">{compact(tokens(s))}</td>
                          <td class="dh-num">{usd(s.cost)}</td>
                          <td class="dh-num">{duration(s.duration / 1000)}</td>
                          <td>{when(s.time.created)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}
      </Show>
    </Page>
  )
}

import { For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { Switch } from "@nikcli-ai/ui/switch"
import { app, toastError, toastOk } from "../lib/store"
import { bytes, duration, pct } from "../lib/format"
import type { ProcCategory, ProcInfo } from "../lib/native"
import { Bar, Empty, KV, Page, Panel, Problem, Spark, Stat } from "../components/kit"

type SortKey = "rss" | "cpu" | "pid" | "runtime" | "category"
const LABEL: Record<ProcCategory, string> = {
  service: "service",
  server: "server",
  cli: "cli / tui",
  test: "test",
  dev: "dev (bun)",
  child: "child (mcp, lsp, shell)",
  devhub: "devhub",
  editor: "editor",
  other: "other",
}

export function Processes() {
  const [sort, setSort] = createSignal<SortKey>("rss")
  const [desc, setDesc] = createSignal(true)
  const [showAll, setShowAll] = createSignal(false)
  const [filter, setFilter] = createSignal("")
  const [sel, setSel] = createSignal<number>()
  const [busy, setBusy] = createSignal(false)

  const rows = createMemo(() => {
    const all = app.snapshot()?.procs ?? []
    const q = filter().toLowerCase()
    const list = all.filter(
      (p) =>
        (showAll() || !["editor", "other", "devhub"].includes(p.category)) &&
        (!q || `${p.name} ${p.cmd} ${p.pid} ${p.category}`.toLowerCase().includes(q)),
    )
    const k = sort()
    const dir = desc() ? -1 : 1
    return [...list].sort((a, b) => {
      const av = a[k] as number | string
      const bv = b[k] as number | string
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir
    })
  })
  const selected = createMemo(() => rows().find((p) => p.pid === sel()))
  const totals = createMemo(() => ({
    rss: rows().reduce((a, p) => a + p.rss, 0),
    cpu: rows().reduce((a, p) => a + p.cpu, 0),
  }))
  const byCat = createMemo(() => {
    const m = new Map<ProcCategory, { n: number; rss: number }>()
    for (const p of rows()) {
      const e = m.get(p.category) ?? { n: 0, rss: 0 }
      e.n++
      e.rss += p.rss
      m.set(p.category, e)
    }
    return [...m.entries()].sort((a, b) => b[1].rss - a[1].rss)
  })
  const memTotal = () => app.snapshot()?.memTotal ?? 1

  const header = (key: SortKey, label: string, cls = "") => (
    <th class={cls} data-sort={key} onClick={() => (sort() === key ? setDesc(!desc()) : (setSort(key), setDesc(true)))}>
      {label} {sort() === key ? (desc() ? "▾" : "▴") : ""}
    </th>
  )

  const kill = async (p: ProcInfo, force: boolean) => {
    if (!confirm(`${force ? "Force kill" : "Terminate"} pid ${p.pid} (${p.name})?`)) return
    setBusy(true)
    try {
      await import("../lib/native").then((m) => m.native.kill(p.pid, force))
      toastOk(`Signalled pid ${p.pid}`)
      setTimeout(() => void app.refreshNow(), 400)
    } catch (e) {
      toastError("Could not signal process", e)
    } finally {
      setBusy(false)
    }
  }
  const h = app.history

  return (
    <Page
      title="Processes"
      subtitle="Live view of every nikcli process and what it spawned — real values from the OS, sampled every 2 s"
      actions={
        <>
          <Switch checked={!app.paused()} onChange={(v) => app.setPaused(!v)}>
            Live
          </Switch>
          <Button size="small" onClick={() => void app.refreshNow()}>
            Sample now
          </Button>
        </>
      }
    >
      <Problem error={app.error()} />
      <div class="dh-grid" data-cols="4">
        <Stat
          label="Processes"
          value={rows().length}
          hint={`${byCat().length} categories`}
          spark={h().map((s) => s.procs)}
        />
        <Stat
          label="Resident memory"
          value={bytes(totals().rss)}
          hint={`${pct((totals().rss / memTotal()) * 100)} of host RAM`}
          spark={h().map((s) => s.nikcliRss)}
        />
        <Stat label="CPU (sum)" value={pct(totals().cpu)} hint="100% = one core" spark={h().map((s) => s.nikcliCpu)} />
        <Stat
          label="Host swap"
          value={bytes(app.snapshot()?.swapUsed ?? 0)}
          hint={`of ${bytes(app.snapshot()?.swapTotal ?? 0)}`}
          spark={h().map((s) => s.swap)}
          sparkMax={100}
        />
      </div>

      <div class="dh-toolbar">
        <input
          class="dh-input"
          placeholder="Filter by name, command, pid…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <Switch checked={showAll()} onChange={setShowAll}>
          Include DevHub, editors and others
        </Switch>
        <For each={byCat()}>
          {([c, v]) => (
            <span class="dh-chip">
              {LABEL[c]} · {v.n} · {bytes(v.rss)}
            </span>
          )}
        </For>
      </div>

      <div class="dh-grid" data-cols={selected() ? "split" : undefined}>
        <Panel title={`Processes (${rows().length})`} class="flush">
          <div class="dh-scroll" style={{ "max-height": "60vh" }}>
            <Show when={rows().length} fallback={<Empty>No nikcli processes match.</Empty>}>
              <table class="dh-table">
                <thead>
                  <tr>
                    {header("pid", "PID")}
                    <th>Name</th>
                    {header("category", "Kind")}
                    {header("cpu", "CPU", "dh-num")}
                    {header("rss", "Memory", "dh-num")}
                    <th>% RAM</th>
                    {header("runtime", "Uptime", "dh-num")}
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {(p) => (
                      <tr
                        data-clickable="true"
                        data-selected={p.pid === sel()}
                        onClick={() => setSel(p.pid === sel() ? undefined : p.pid)}
                      >
                        <td class="dh-mono">{p.pid}</td>
                        <td>
                          <div class="dh-ellipsis" style={{ "max-width": "320px" }} title={p.cmd}>
                            {p.name}
                          </div>
                        </td>
                        <td>
                          <span class="dh-chip">{LABEL[p.category]}</span>
                        </td>
                        <td class="dh-num">{pct(p.cpu)}</td>
                        <td class="dh-num">{bytes(p.rss)}</td>
                        <td style={{ width: "96px" }}>
                          <Bar value={(p.rss / memTotal()) * 100 * 8} tone="ok" />
                        </td>
                        <td class="dh-num">{duration(p.runtime)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </Panel>

        <Show when={selected()}>
          {(p) => (
            <Panel
              title={`${p().name} · ${p().pid}`}
              actions={
                <>
                  <Button size="small" disabled={busy()} onClick={() => void kill(p(), false)}>
                    Terminate
                  </Button>
                  <Button size="small" variant="primary" disabled={busy()} onClick={() => void kill(p(), true)}>
                    Kill
                  </Button>
                </>
              }
            >
              <KV
                rows={[
                  ["Kind", LABEL[p().category]],
                  ["Status", p().status],
                  ["Parent", p().parent ?? "—"],
                  ["Memory", `${bytes(p().rss)} resident · ${bytes(p().virt)} virtual`],
                  ["CPU", pct(p().cpu)],
                  ["Threads", p().threads ?? "—"],
                  ["Disk I/O", `${bytes(p().readBytes)} read · ${bytes(p().writtenBytes)} written`],
                  ["Uptime", duration(p().runtime)],
                  ["Executable", <span class="dh-mono">{p().exe ?? "—"}</span>],
                  ["Directory", <span class="dh-mono">{p().cwd ?? "—"}</span>],
                  ["Command", <span class="dh-mono">{p().cmd || "—"}</span>],
                ]}
              />
            </Panel>
          )}
        </Show>
      </div>
    </Page>
  )
}

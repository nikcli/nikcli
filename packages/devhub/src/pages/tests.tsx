import { For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { Checkbox } from "@nikcli-ai/ui/checkbox"
import { Select } from "@nikcli-ai/ui/select"
import { createPoll, toastError } from "../lib/store"
import { native, type TestFile } from "../lib/native"
import { runner, type Run } from "../lib/tasks"
import { bytes, duration, ms, when } from "../lib/format"
import { Empty, Loading, Page, Panel, Problem, Stat } from "../components/kit"

/** stderr is not "red": nikcli and bun log INFO/WARN there. Only lines that look like failures are. */
export const isErrorLine = (line: string) =>
  /(^|\s)(ERROR|FATAL|error:|Error:|TypeError|ReferenceError|SyntaxError|panic|✗|\(fail\)|FAIL\b|Uncaught)/.test(line)

export function RunLog(props: { run: Run }) {
  let box: HTMLPreElement | undefined
  const [follow, setFollow] = createSignal(true)
  const lines = createMemo(() => props.run.lines.slice(-2500))
  return (
    <pre
      class="dh-log"
      ref={(el) => {
        box = el
      }}
      onScroll={() => box && setFollow(box.scrollTop + box.clientHeight >= box.scrollHeight - 24)}
    >
      <For each={lines()}>
        {(l) => {
          queueMicrotask(() => follow() && box && (box.scrollTop = box.scrollHeight))
          return <div class={l.stream === "stderr" && isErrorLine(l.line) ? "err" : ""}>{l.line}</div>
        }}
      </For>
    </pre>
  )
}

export function RunSummary(props: { run: Run }) {
  const r = () => props.run
  const failed = createMemo(() => r().results.filter((x) => x.status === "fail"))
  const slow = createMemo(() =>
    [...r().results]
      .filter((x) => x.ms !== undefined)
      .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
      .slice(0, 8),
  )
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      <div class="dh-grid" data-cols="4">
        <Stat
          label="Status"
          value={r().status}
          tone={r().status === "failed" ? "bad" : r().status === "passed" ? "ok" : undefined}
          hint={r().code !== undefined && r().code !== null ? `exit ${r().code}` : undefined}
        />
        <Stat label="Passed" value={r().summary?.pass ?? r().results.filter((x) => x.status === "pass").length} />
        <Stat label="Failed" value={r().summary?.fail ?? failed().length} tone={failed().length ? "bad" : undefined} />
        <Stat
          label="Duration"
          value={r().durationMs ? duration(r().durationMs! / 1000) : duration((Date.now() - r().startedAt) / 1000)}
          hint={r().summary?.files ? `${r().summary!.files} files` : undefined}
        />
      </div>
      <Show when={failed().length}>
        <Panel title={`Failures (${failed().length})`} class="flush">
          <div class="dh-scroll" style={{ "max-height": "220px" }}>
            <table class="dh-table">
              <tbody>
                <For each={failed()}>
                  {(f) => (
                    <tr>
                      <td>
                        <span class="dh-chip" data-tone="bad">
                          fail
                        </span>
                      </td>
                      <td>{f.name}</td>
                      <td class="dh-mono dh-ellipsis" title={f.file}>
                        {f.file}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Panel>
      </Show>
      <Show when={slow().length}>
        <Panel title="Slowest tests" class="flush">
          <table class="dh-table">
            <tbody>
              <For each={slow()}>
                {(s) => (
                  <tr>
                    <td class="dh-num" style={{ width: "90px" }}>
                      {ms(s.ms!)}
                    </td>
                    <td>{s.name}</td>
                    <td class="dh-mono">{s.file}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Panel>
      </Show>
      <Panel title="Output" class="flush">
        <RunLog run={r()} />
      </Panel>
    </div>
  )
}

export function Tests() {
  const files = createPoll(() => native.tests(), 0)
  const [pkg, setPkg] = createSignal("nikcli")
  const [filter, setFilter] = createSignal("")
  const [picked, setPicked] = createSignal<Set<string>>(new Set())
  const [timeout, setTimeoutMs] = createSignal("30000")
  const [pattern, setPattern] = createSignal("")
  const [bail, setBail] = createSignal(false)
  const [viewId, setViewId] = createSignal<string>()

  const packages = createMemo(() => {
    const m = new Map<string, number>()
    for (const f of files.data() ?? []) m.set(f.package, (m.get(f.package) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  })
  const visible = createMemo(() => {
    const q = filter().toLowerCase()
    return (files.data() ?? []).filter((f) => f.package === pkg() && (!q || f.path.toLowerCase().includes(q)))
  })
  const view = createMemo(
    () => runner.runs.find((r) => r.id === viewId()) ?? runner.runs.find((r) => r.kind === "test"),
  )
  const key = (f: TestFile) => `${f.package}:${f.path}`
  const pickedHere = () => visible().filter((f) => picked().has(key(f)))

  const flags = () => [
    "--timeout",
    String(Number(timeout()) || 30000),
    ...(bail() ? ["--bail"] : []),
    ...(pattern().trim() ? ["-t", pattern().trim()] : []),
  ]

  const launch = async (label: string, args: string[], cwd = `packages/${pkg()}`) => {
    try {
      setViewId(await runner.start({ kind: "test", label, cwd, args, junit: true }))
    } catch (e) {
      toastError("Could not start tests", e)
    }
  }
  const runFiles = (list: TestFile[]) =>
    launch(list.length === 1 ? list[0].path : `${list.length} files · ${pkg()}`, [
      "test",
      ...flags(),
      ...list.map((f) => `./${f.path}`),
    ])
  const runPackage = () =>
    pkg() === "nikcli"
      ? launch("nikcli · full suite (sharded)", ["run", "test:ci"])
      : launch(`${pkg()} · all tests`, ["test", ...flags()])

  return (
    <Page
      title="Tests"
      subtitle="Every test file in every workspace package. Runs execute real `bun test` processes and stream their output."
      actions={
        <>
          <Button size="small" onClick={() => void files.reload()}>
            Rescan
          </Button>
          <Button size="small" variant="primary" icon="checklist" onClick={() => void runPackage()}>
            Run {pkg()}
          </Button>
        </>
      }
    >
      <Problem error={files.error()} title="Could not scan tests" />
      <div class="dh-grid" data-cols="wide-left">
        <Panel
          title={`${pkg()} · ${visible().length} files`}
          class="flush"
          actions={
            <Button size="small" disabled={!pickedHere().length} onClick={() => void runFiles(pickedHere())}>
              Run selected ({pickedHere().length})
            </Button>
          }
        >
          <div class="dh-toolbar dh-compact-inputs" style={{ padding: "10px 12px" }}>
            <Select
              size="small"
              options={packages().map(([p]) => p)}
              current={pkg()}
              label={(p) => `${p} (${packages().find(([x]) => x === p)?.[1] ?? 0})`}
              onSelect={(p) => p && (setPkg(p), setPicked(new Set<string>()))}
            />
            <input
              class="dh-input"
              style={{ flex: 1 }}
              placeholder="Filter files…"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
          <div class="dh-toolbar dh-compact-inputs" style={{ padding: "0 12px 10px" }}>
            <input
              class="dh-input"
              style={{ width: "78px" }}
              title="Timeout per test (ms)"
              value={timeout()}
              onInput={(e) => setTimeoutMs(e.currentTarget.value)}
            />
            <input
              class="dh-input"
              style={{ flex: 1 }}
              placeholder="-t name pattern"
              value={pattern()}
              onInput={(e) => setPattern(e.currentTarget.value)}
            />
            <Checkbox checked={bail()} onChange={setBail}>
              Bail
            </Checkbox>
          </div>
          <div class="dh-scroll" style={{ "max-height": "58vh" }}>
            <Show when={!files.loading()} fallback={<Loading label="Scanning packages…" />}>
              <Show when={visible().length} fallback={<Empty>No test files.</Empty>}>
                <table class="dh-table">
                  <tbody>
                    <For each={visible()}>
                      {(f) => (
                        <tr>
                          <td style={{ width: "32px" }}>
                            <Checkbox
                              checked={picked().has(key(f))}
                              onChange={(v) =>
                                setPicked((s) => {
                                  const n = new Set(s)
                                  v ? n.add(key(f)) : n.delete(key(f))
                                  return n
                                })
                              }
                            />
                          </td>
                          <td class="dh-mono dh-fill" title={`${bytes(f.size)} · ${when(f.modified)}`}>
                            <div class="dh-ellipsis">{f.path}</div>
                          </td>
                          <td style={{ width: "64px" }}>
                            <Button size="small" variant="ghost" onClick={() => void runFiles([f])}>
                              Run
                            </Button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </Show>
          </div>
        </Panel>

        <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "min-width": 0 }}>
          <Panel
            title="Runs"
            class="flush"
            actions={
              <Button size="small" variant="ghost" onClick={() => runner.clear()}>
                Clear
              </Button>
            }
          >
            <div class="dh-scroll" style={{ "max-height": "180px" }}>
              <Show
                when={runner.runs.filter((r) => r.kind === "test").length}
                fallback={<Empty>Nothing run yet.</Empty>}
              >
                <table class="dh-table">
                  <tbody>
                    <For each={runner.runs.filter((r) => r.kind === "test")}>
                      {(r) => (
                        <tr data-clickable="true" data-selected={view()?.id === r.id} onClick={() => setViewId(r.id)}>
                          <td>
                            <span
                              class="dh-chip"
                              data-tone={
                                r.status === "passed"
                                  ? "ok"
                                  : r.status === "failed"
                                    ? "bad"
                                    : r.status === "running"
                                      ? "warn"
                                      : undefined
                              }
                            >
                              {r.status}
                            </span>
                          </td>
                          <td class="dh-fill">
                            <div class="dh-ellipsis" title={r.label}>
                              {r.label}
                            </div>
                          </td>
                          <td class="dh-num">
                            {r.summary ? `${r.summary.pass}/${r.summary.pass + r.summary.fail}` : ""}
                          </td>
                          <td class="dh-num">{r.durationMs ? duration(r.durationMs / 1000) : ""}</td>
                          <td style={{ width: "70px" }}>
                            <Show when={r.status === "running"}>
                              <Button
                                size="small"
                                variant="ghost"
                                onClick={(e: MouseEvent) => (
                                  e.stopPropagation(),
                                  void runner.cancel(r.id).catch((x) => toastError("Cancel failed", x))
                                )}
                              >
                                Stop
                              </Button>
                            </Show>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </div>
          </Panel>
          <Show when={view()}>{(r) => <RunSummary run={r()} />}</Show>
        </div>
      </div>
    </Page>
  )
}

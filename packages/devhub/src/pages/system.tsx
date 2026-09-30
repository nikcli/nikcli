import { For, Show, createSignal } from "solid-js"
import { open } from "@tauri-apps/plugin-dialog"
import { Button } from "@nikcli-ai/ui/button"
import { Select } from "@nikcli-ai/ui/select"
import { app, createPoll, toastError, toastOk } from "../lib/store"
import { unwrap } from "../lib/api"
import { native } from "../lib/native"
import { runner } from "../lib/tasks"
import { bytes, duration, when } from "../lib/format"
import { Dot, Empty, KV, Loading, Page, Panel, Problem } from "../components/kit"
import { RunLog } from "./tests"

const CHECKS: { label: string; args: string[] }[] = [
  { label: "Typecheck", args: ["run", "typecheck"] },
  { label: "Route coverage", args: ["run", "check:routes"] },
  { label: "Open payloads", args: ["run", "check:open-payloads"] },
  { label: "Account required", args: ["run", "check:account-required"] },
  { label: "Observability schema", args: ["run", "check:observability-schema"] },
  { label: "Plugin v2", args: ["run", "check:plugin-v2"] },
  { label: "Workspace isolation", args: ["run", "check:workspace-isolation"] },
  { label: "Network egress", args: ["run", "check:network-egress"] },
  { label: "Perf baseline", args: ["run", "check:perf-baseline"] },
  { label: "Lint", args: ["run", "lint"] },
]

export function System() {
  const svc = () => app.service()
  const c = () => app.client()
  const mcp = createPoll(async () => (c() ? unwrap(c()!.mcp.status()) : undefined), 15000, svc)
  const lsp = createPoll(async () => (c() ? unwrap(c()!.lsp.status()) : undefined), 15000, svc)
  const storage = createPoll(() => native.storage(), 60000)
  const logs = createPoll(() => native.logs(), 15000)
  const [logName, setLogName] = createSignal<string>()
  const [tailKb, setTailKb] = createSignal("256")
  const tail = createPoll(
    async () => {
      const name = logName() ?? logs.data()?.[0]?.name
      return name ? native.tailLog(name, Number(tailKb()) * 1024) : ""
    },
    4000,
    () => [logName(), tailKb(), logs.data()?.[0]?.name],
  )
  const [checkView, setCheckView] = createSignal<string>()
  const check = () => runner.runs.find((r) => r.id === checkView()) ?? runner.runs.find((r) => r.kind === "check")

  const runCheck = async (c: (typeof CHECKS)[number]) => {
    try {
      setCheckView(await runner.start({ kind: "check", label: c.label, cwd: "packages/nikcli", args: c.args }))
    } catch (e) {
      toastError(`Could not run ${c.label}`, e)
    }
  }
  const pick = async () => {
    const dir = await open({ directory: true, title: "Select the nikcli repository" })
    if (typeof dir !== "string") return
    try {
      await app.setRepo(dir)
      toastOk("Repository set", dir)
    } catch (e) {
      toastError("Not a nikcli repository", e)
    }
  }
  const dataTotal = () => (storage.data() ?? []).reduce((a, e) => a + e.size, 0)

  return (
    <Page title="System" subtitle="Service diagnostics, repository checks, on-disk storage and live logs">
      <Panel title="MCP servers & language servers" class="flush">
        <Problem error={mcp.error() ?? lsp.error()} />
        <Show when={mcp.data() || lsp.data()} fallback={<Loading />}>
          <table class="dh-table">
            <tbody>
              <For each={Object.entries((mcp.data() ?? {}) as Record<string, { status: string; error?: string }>)}>
                {([name, s]) => (
                  <tr>
                    <td>MCP</td>
                    <td>{name}</td>
                    <td>
                      <span
                        class="dh-chip"
                        data-tone={s.status === "connected" ? "ok" : s.status === "disabled" ? undefined : "bad"}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td class="dh-ellipsis">{s.error}</td>
                  </tr>
                )}
              </For>
              <For each={(lsp.data() ?? []) as { id: string; name: string; root: string; status: string }[]}>
                {(s) => (
                  <tr>
                    <td>LSP</td>
                    <td>{s.name ?? s.id}</td>
                    <td>
                      <span class="dh-chip" data-tone={s.status === "connected" ? "ok" : "bad"}>
                        {s.status}
                      </span>
                    </td>
                    <td class="dh-mono dh-ellipsis">{s.root}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={!Object.keys(mcp.data() ?? {}).length && !(lsp.data() ?? []).length}>
            <Empty>No MCP or language servers are running in this instance.</Empty>
          </Show>
        </Show>
      </Panel>

      <Panel
        title="Repository checks"
        actions={
          <Show when={check()}>
            <span class="dh-chip">
              {check()!.label} · {check()!.status}
            </span>
          </Show>
        }
      >
        <div class="dh-toolbar">
          <For each={CHECKS}>
            {(ck) => (
              <Button
                size="small"
                disabled={runner.active().some((r) => r.kind === "check")}
                onClick={() => void runCheck(ck)}
              >
                {ck.label}
              </Button>
            )}
          </For>
          <Show when={check()?.status === "running"}>
            <Button size="small" variant="primary" onClick={() => void runner.cancel(check()!.id)}>
              Stop
            </Button>
          </Show>
        </div>
        <Show when={check()}>
          {(r) => (
            <div style={{ "margin-top": "10px" }}>
              <div style={{ color: "var(--text-weak)", "margin-bottom": "6px" }}>
                {r().status}
                {r().durationMs ? ` in ${duration(r().durationMs! / 1000)}` : ""}
                {r().code !== undefined && r().code !== null ? ` · exit ${r().code}` : ""}
              </div>
              <RunLog run={r()} />
            </div>
          )}
        </Show>
      </Panel>

      <div class="dh-grid" data-cols="2">
        <Panel title={`Storage · ${bytes(dataTotal())}`} class="flush">
          <div class="dh-scroll" style={{ "max-height": "360px" }}>
            <Show when={!storage.loading()} fallback={<Loading />}>
              <table class="dh-table">
                <tbody>
                  <For each={storage.data()}>
                    {(e) => (
                      <tr>
                        <td>
                          <span class="dh-chip">{e.location}</span>
                        </td>
                        <td class="dh-mono dh-ellipsis" style={{ "max-width": "260px" }} title={e.path}>
                          {e.name}
                          {e.isDir ? "/" : ""}
                        </td>
                        <td class="dh-num">{bytes(e.size)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </Panel>
        <Panel
          title="Logs"
          class="flush"
          actions={
            <>
              <Select
                size="small"
                options={(logs.data() ?? []).map((l) => l.name)}
                current={logName() ?? logs.data()?.[0]?.name}
                label={(n) => n}
                onSelect={(n) => n && setLogName(n)}
              />
              <Select
                size="small"
                options={["64", "256", "1024"]}
                current={tailKb()}
                label={(k) => `${k} KB`}
                onSelect={(k) => k && setTailKb(k)}
              />
            </>
          }
        >
          <Problem error={tail.error()} />
          <pre
            class="dh-log"
            style={{ "max-height": "360px" }}
            ref={(el) => queueMicrotask(() => (el.scrollTop = el.scrollHeight))}
          >
            {tail.data() || "No log output."}
          </pre>
        </Panel>
      </div>
    </Page>
  )
}

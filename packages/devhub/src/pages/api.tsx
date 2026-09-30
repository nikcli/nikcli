import { For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { Select } from "@nikcli-ai/ui/select"
import { app, toastError } from "../lib/store"
import { native, errorText, type ApiResponse } from "../lib/native"
import { ms } from "../lib/format"
import { Empty, Page, Panel } from "../components/kit"

const PRESETS: { group: string; method: string; path: string }[] = [
  { group: "Core", method: "GET", path: "/global/health" },
  { group: "Core", method: "GET", path: "/doctor" },
  { group: "Core", method: "GET", path: "/config" },
  { group: "Core", method: "GET", path: "/path" },
  { group: "Core", method: "GET", path: "/agent" },
  { group: "Core", method: "GET", path: "/skill" },
  { group: "Core", method: "GET", path: "/command" },
  { group: "Core", method: "GET", path: "/formatter" },
  { group: "Core", method: "GET", path: "/lsp" },
  { group: "Core", method: "GET", path: "/mcp" },
  { group: "Providers", method: "GET", path: "/provider" },
  { group: "Providers", method: "GET", path: "/config/providers" },
  { group: "Sessions", method: "GET", path: "/session?limit=20" },
  { group: "Sessions", method: "GET", path: "/project" },
  { group: "Sessions", method: "GET", path: "/permission" },
  { group: "Sessions", method: "GET", path: "/question" },
  { group: "Analytics", method: "GET", path: "/analytics/global" },
  { group: "Analytics", method: "GET", path: "/analytics/daily?days=14" },
  { group: "Analytics", method: "GET", path: "/analytics/leaderboard" },
  { group: "Analytics", method: "GET", path: "/analytics/data?days=30" },
  { group: "Experimental", method: "GET", path: "/experimental/tool/ids" },
  { group: "Experimental", method: "GET", path: "/loop" },
  { group: "Experimental", method: "GET", path: "/mission" },
  { group: "Experimental", method: "GET", path: "/brain/status" },
  { group: "Experimental", method: "GET", path: "/connectors/status" },
  { group: "Experimental", method: "GET", path: "/sync" },
]

type Entry = { method: string; path: string; status: number; ms: number; at: number; service: string }
const HKEY = "devhub.api.history"
const loadHistory = (): Entry[] => {
  try {
    return JSON.parse(localStorage.getItem(HKEY) ?? "[]")
  } catch {
    return []
  }
}

function pretty(body: string, headers: Record<string, string>) {
  if ((headers["content-type"] ?? "").includes("json") || /^[\[{]/.test(body.trim())) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {}
  }
  return body
}

export function ApiConsole() {
  const [method, setMethod] = createSignal("GET")
  const [path, setPath] = createSignal("/global/health")
  const [directory, setDirectory] = createSignal("")
  const [body, setBody] = createSignal("")
  const [res, setRes] = createSignal<ApiResponse>()
  const [err, setErr] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [hist, setHist] = createSignal<Entry[]>(loadHistory())
  const [filter, setFilter] = createSignal("")

  const send = async (m = method(), p = path()) => {
    const s = app.service()
    if (!s) return toastError("No service", "No nikcli service is registered")
    setBusy(true)
    setErr(undefined)
    try {
      const headers: Record<string, string> = {}
      if (body().trim()) headers["content-type"] = "application/json"
      if (directory().trim()) headers["x-nikcli-directory"] = encodeURIComponent(directory().trim())
      const r = await native.api({ serviceUrl: s.url, method: m, path: p, headers, body: body().trim() || undefined })
      setRes(r)
      const next = [
        { method: m, path: p, status: r.status, ms: r.elapsedMs, at: Date.now(), service: s.channel },
        ...hist(),
      ].slice(0, 40)
      setHist(next)
      localStorage.setItem(HKEY, JSON.stringify(next))
    } catch (e) {
      setRes(undefined)
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const use = (m: string, p: string, go = true) => (setMethod(m), setPath(p), go && void send(m, p))
  const presets = createMemo(() => PRESETS.filter((x) => x.path.includes(filter())))
  const groups = createMemo(() => [...new Set(presets().map((p) => p.group))])
  const out = () => (res() ? pretty(res()!.body, res()!.headers) : "")

  return (
    <Page
      title="API console"
      subtitle="Authenticated requests to the local nikcli HttpApi — the channel password is attached by the native side"
    >
      <div class="dh-grid" data-cols="split">
        <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "min-width": 0 }}>
          <Panel title="Endpoints" class="flush">
            <div class="dh-toolbar" style={{ padding: "10px 12px" }}>
              <input
                class="dh-input"
                style={{ width: "100%" }}
                placeholder="Filter…"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
            </div>
            <div class="dh-scroll" style={{ "max-height": "34vh" }}>
              <For each={groups()}>
                {(g) => (
                  <>
                    <div
                      style={{
                        padding: "6px 12px",
                        color: "var(--text-weak)",
                        "font-size": "11px",
                        "text-transform": "uppercase",
                      }}
                    >
                      {g}
                    </div>
                    <For each={presets().filter((p) => p.group === g)}>
                      {(p) => (
                        <button class="dh-nav" style={{ "border-radius": 0 }} onClick={() => use(p.method, p.path)}>
                          <span class="dh-chip">{p.method}</span>
                          <span class="dh-mono">{p.path}</span>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          </Panel>
          <Panel title="History" class="flush">
            <div class="dh-scroll" style={{ "max-height": "26vh" }}>
              <Show when={hist().length} fallback={<Empty>No requests yet.</Empty>}>
                <table class="dh-table">
                  <tbody>
                    <For each={hist()}>
                      {(h) => (
                        <tr data-clickable="true" onClick={() => use(h.method, h.path, false)}>
                          <td>
                            <span class="dh-chip" data-tone={h.status < 300 ? "ok" : h.status < 500 ? "warn" : "bad"}>
                              {h.status}
                            </span>
                          </td>
                          <td class="dh-mono dh-fill">
                            <div class="dh-ellipsis" title={`${h.method} ${h.path}`}>
                              {h.method} {h.path}
                            </div>
                          </td>
                          <td class="dh-num">{ms(h.ms)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </div>
          </Panel>
        </div>

        <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "min-width": 0 }}>
          <Panel title="Request">
            <div class="dh-toolbar">
              <Select
                size="small"
                options={["GET", "POST", "PUT", "PATCH", "DELETE"]}
                current={method()}
                onSelect={(m) => m && setMethod(m)}
              />
              <input
                class="dh-input"
                style={{ flex: 1 }}
                value={path()}
                onInput={(e) => setPath(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && void send()}
              />
              <Button variant="primary" size="small" disabled={busy()} onClick={() => void send()}>
                Send
              </Button>
            </div>
            <div class="dh-toolbar" style={{ "margin-top": "8px" }}>
              <input
                class="dh-input"
                style={{ flex: 1 }}
                placeholder="Instance directory (x-nikcli-directory), optional"
                value={directory()}
                onInput={(e) => setDirectory(e.currentTarget.value)}
              />
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
          </Panel>
          <Panel
            title="Response"
            class="flush"
            actions={
              <Show when={res()}>
                <span class="dh-chip" data-tone={res()!.status < 300 ? "ok" : res()!.status < 500 ? "warn" : "bad"}>
                  {res()!.status}
                </span>
                <span class="dh-chip">{ms(res()!.elapsedMs)}</span>
                <span class="dh-chip">{res()!.body.length.toLocaleString()} chars</span>
                <Button size="small" variant="ghost" onClick={() => void navigator.clipboard.writeText(out())}>
                  Copy
                </Button>
              </Show>
            }
          >
            <Show when={err()}>
              <pre class="dh-log err">{err()}</pre>
            </Show>
            <Show
              when={res()}
              fallback={
                <Show when={!err()}>
                  <Empty>Pick an endpoint or press Send.</Empty>
                </Show>
              }
            >
              <pre class="dh-log" style={{ "max-height": "58vh" }}>
                {out().slice(0, 400_000)}
              </pre>
            </Show>
          </Panel>
        </div>
      </div>
    </Page>
  )
}

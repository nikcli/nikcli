import { For, Match, Show, Switch as SolidSwitch, createMemo, createSignal } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { Select } from "@nikcli-ai/ui/select"
import { Tabs } from "@nikcli-ai/ui/tabs"
import { Gateway, type GatewayRequest } from "../lib/agent"
import { runApp } from "../lib/runtime"
import { app, createPoll, toastError, toastOk } from "../lib/store"
import { ago, compact, when } from "../lib/format"
import { Empty, KV, Loading, Page, Panel, Problem } from "../components/kit"

const call = <A,>(req: GatewayRequest) => runApp(Gateway.use((g) => g.json<A>(req)))
const svc = () => app.service()?.url
const enc = encodeURIComponent
const short = (dir: string) => dir.replace(/^\/Users\/[^/]+/, "~").replace(/^\/Volumes\/[^/]+/, "")

// ── sessions ──────────────────────────────────────────────────────────────────

type Session = {
  id: string
  title: string
  directory: string
  parentID?: string
  summary?: { additions: number; deletions: number; files: number }
  time: { created: number; updated: number }
}

function Sessions() {
  const list = createPoll(() => call<Session[]>({ method: "GET", path: "/session?limit=300" }), 30_000, svc)
  const status = createPoll(
    () => call<Record<string, { type: string }>>({ method: "GET", path: "/session/status" }),
    5000,
    svc,
  )
  const [q, setQ] = createSignal("")
  const [sel, setSel] = createSignal<string>()
  const rows = createMemo(() => {
    const needle = q().toLowerCase()
    return (list.data() ?? [])
      .filter((s) => !needle || `${s.title} ${s.directory} ${s.id}`.toLowerCase().includes(needle))
      .sort((a, b) => b.time.updated - a.time.updated)
  })
  const cur = createMemo(() => (list.data() ?? []).find((s) => s.id === sel()))
  const busy = (id: string) => (status.data()?.[id]?.type ?? "idle") !== "idle"
  const dir = () => cur()?.directory

  const run = async (label: string, req: GatewayRequest, after?: () => void) => {
    try {
      await call({ ...req, directory: dir() })
      toastOk(label)
      after?.()
      void list.reload()
    } catch (e) {
      toastError(`${label} failed`, e)
    }
  }
  const rename = () => {
    const c = cur()
    const title = c && prompt("Rename session", c.title)?.trim()
    if (c && title) void run("Renamed", { method: "PATCH", path: `/session/${enc(c.id)}`, body: { title } })
  }
  const remove = () => {
    const c = cur()
    if (c && confirm(`Delete “${c.title}”? This cannot be undone.`))
      void run("Deleted", { method: "DELETE", path: `/session/${enc(c.id)}` }, () => setSel(undefined))
  }

  return (
    <div class="dh-grid" data-cols={cur() ? "wide-left" : undefined}>
      <Panel
        title={`Sessions · ${rows().length}`}
        class="flush"
        actions={
          <Button size="small" onClick={() => void list.reload()}>
            Reload
          </Button>
        }
      >
        <div class="dh-toolbar dh-compact-inputs" style={{ padding: "10px 12px" }}>
          <input
            class="dh-input"
            style={{ flex: 1 }}
            placeholder="Filter by title, folder or id…"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
        </div>
        <Problem error={list.error()} />
        <div class="dh-scroll" style={{ "max-height": "58vh" }}>
          <Show when={!list.loading() || list.data()} fallback={<Loading />}>
            <Show when={rows().length} fallback={<Empty>No sessions.</Empty>}>
              <table class="dh-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Title</th>
                    <th>Folder</th>
                    <th class="dh-num">Changes</th>
                    <th class="dh-num">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows().slice(0, 300)}>
                    {(s) => (
                      <tr
                        data-clickable="true"
                        data-selected={sel() === s.id}
                        onClick={() => setSel(sel() === s.id ? undefined : s.id)}
                      >
                        <td style={{ width: "22px" }}>
                          {busy(s.id) ? (
                            <span class="dh-chip" data-tone="warn">
                              busy
                            </span>
                          ) : null}
                        </td>
                        <td class="dh-fill">
                          <div class="dh-ellipsis" title={s.title}>
                            {s.title}
                          </div>
                        </td>
                        <td class="dh-mono dh-sub" style={{ "max-width": "170px" }}>
                          <div class="dh-ellipsis" title={s.directory}>
                            {short(s.directory)}
                          </div>
                        </td>
                        <td class="dh-num dh-sub">
                          {s.summary && s.summary.files
                            ? `${s.summary.files}f +${s.summary.additions} −${s.summary.deletions}`
                            : "—"}
                        </td>
                        <td class="dh-num dh-sub">{ago(s.time.updated)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </Show>
        </div>
      </Panel>
      <Show when={cur()}>
        {(c) => (
          <Panel
            title="Session"
            actions={
              <>
                <Button size="small" onClick={rename}>
                  Rename
                </Button>
                <Button
                  size="small"
                  onClick={() => void run("Forked", { method: "POST", path: `/session/${enc(c().id)}/fork`, body: {} })}
                >
                  Fork
                </Button>
                <Show when={busy(c().id)}>
                  <Button
                    size="small"
                    onClick={() => void run("Stopped", { method: "POST", path: `/session/${enc(c().id)}/abort` })}
                  >
                    Stop
                  </Button>
                </Show>
                <Button size="small" variant="primary" onClick={remove}>
                  Delete
                </Button>
              </>
            }
          >
            <KV
              rows={[
                ["Title", c().title],
                ["Id", <span class="dh-mono">{c().id}</span>],
                ["Folder", <span class="dh-mono">{c().directory}</span>],
                ["Created", when(c().time.created)],
                ["Updated", when(c().time.updated)],
                ["State", busy(c().id) ? "running a turn" : "idle"],
                [
                  "Changes",
                  c().summary
                    ? `${c().summary!.files} files · +${c().summary!.additions} −${c().summary!.deletions}`
                    : "none",
                ],
                ["Parent", c().parentID ?? "—"],
              ]}
            />
          </Panel>
        )}
      </Show>
    </div>
  )
}

// ── providers ─────────────────────────────────────────────────────────────────

type Provider = { id: string; name: string; models: Record<string, unknown>; source?: string }
type ProviderList = { all: Provider[]; connected: string[]; default: Record<string, string> }

function Providers() {
  const data = createPoll(() => call<ProviderList>({ method: "GET", path: "/provider" }), 0, svc)
  const [q, setQ] = createSignal("")
  const [target, setTarget] = createSignal<Provider>()
  const [key, setKey] = createSignal("")
  const connected = createMemo(() => data.data()?.all.filter((p) => data.data()!.connected.includes(p.id)) ?? [])
  const available = createMemo(() => {
    const needle = q().toLowerCase()
    return (data.data()?.all ?? [])
      .filter(
        (p) =>
          !data.data()!.connected.includes(p.id) && (!needle || `${p.name} ${p.id}`.toLowerCase().includes(needle)),
      )
      .slice(0, 60)
  })

  const connect = async () => {
    const p = target()
    if (!p || !key().trim()) return
    try {
      await call({ method: "PUT", path: `/auth/${enc(p.id)}`, body: { type: "api", key: key().trim() } })
      toastOk(`Connected ${p.name}`)
      setKey("")
      setTarget(undefined)
      await data.reload()
    } catch (e) {
      toastError("Could not save the key", e)
    }
  }
  const disconnect = async (p: Provider) => {
    if (!confirm(`Remove the stored credentials for ${p.name}? Environment-based keys are not affected.`)) return
    try {
      await call({ method: "DELETE", path: `/auth/${enc(p.id)}` })
      toastOk(`Disconnected ${p.name}`)
      await data.reload()
    } catch (e) {
      toastError("Could not remove credentials", e)
    }
  }

  return (
    <div class="dh-grid" data-cols="2">
      <Panel title={`Connected · ${connected().length}`} class="flush">
        <Problem error={data.error()} />
        <Show when={!data.loading() || data.data()} fallback={<Loading />}>
          <div class="dh-scroll" style={{ "max-height": "60vh" }}>
            <table class="dh-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th class="dh-num">Models</th>
                  <th>Default</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <For each={connected()}>
                  {(p) => (
                    <tr>
                      <td class="dh-fill">
                        <div class="dh-ellipsis">{p.name}</div>
                        <div class="dh-sub">
                          {p.id}
                          {p.source ? ` · ${p.source}` : ""}
                        </div>
                      </td>
                      <td class="dh-num">{Object.keys(p.models).length}</td>
                      <td class="dh-mono dh-sub" style={{ "max-width": "160px" }}>
                        <div class="dh-ellipsis">{data.data()!.default[p.id] ?? "—"}</div>
                      </td>
                      <td style={{ width: "90px" }}>
                        <Button size="small" variant="ghost" onClick={() => void disconnect(p)}>
                          Disconnect
                        </Button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Panel>
      <Panel title="Connect a provider with an API key" class="flush">
        <div class="dh-toolbar dh-compact-inputs" style={{ padding: "10px 12px" }}>
          <input
            class="dh-input"
            style={{ flex: 1 }}
            placeholder={`Search ${data.data()?.all.length ?? 0} providers…`}
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
        </div>
        <div class="dh-scroll" style={{ "max-height": "34vh" }}>
          <table class="dh-table">
            <tbody>
              <For each={available()}>
                {(p) => (
                  <tr data-clickable="true" data-selected={target()?.id === p.id} onClick={() => setTarget(p)}>
                    <td class="dh-fill">
                      <div class="dh-ellipsis">{p.name}</div>
                    </td>
                    <td class="dh-sub dh-mono">{p.id}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={target()}>
          <div
            class="dh-toolbar dh-compact-inputs"
            style={{ padding: "12px", "border-top": "1px solid var(--dh-line)" }}
          >
            <strong style={{ "font-size": "12.5px" }}>{target()!.name}</strong>
            <input
              class="dh-input"
              type="password"
              autocomplete="off"
              style={{ flex: 1 }}
              placeholder="API key"
              value={key()}
              onInput={(e) => setKey(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && void connect()}
            />
            <Button size="small" variant="primary" disabled={!key().trim()} onClick={() => void connect()}>
              Save
            </Button>
          </div>
        </Show>
      </Panel>
    </div>
  )
}

// ── MCP ───────────────────────────────────────────────────────────────────────

function Mcp() {
  const data = createPoll(
    () => call<Record<string, { status: string; error?: string }>>({ method: "GET", path: "/mcp" }),
    15_000,
    svc,
  )
  const entries = createMemo(() => Object.entries(data.data() ?? {}))
  const act = async (name: string, verb: "connect" | "disconnect" | "toggle") => {
    try {
      await call({ method: "POST", path: `/mcp/${enc(name)}/${verb}` })
      await data.reload()
    } catch (e) {
      toastError(`Could not ${verb} ${name}`, e)
    }
  }
  return (
    <Panel
      title={`MCP servers · ${entries().length}`}
      class="flush"
      actions={
        <Button size="small" onClick={() => void data.reload()}>
          Reload
        </Button>
      }
    >
      <Problem error={data.error()} />
      <Show
        when={entries().length}
        fallback={
          <Empty>
            {data.loading() ? "Loading…" : "No MCP servers configured. Add them in nikcli.json under “mcp”."}
          </Empty>
        }
      >
        <table class="dh-table">
          <thead>
            <tr>
              <th>Server</th>
              <th>Status</th>
              <th>Detail</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <For each={entries()}>
              {([name, s]) => (
                <tr>
                  <td class="dh-mono">{name}</td>
                  <td>
                    <span
                      class="dh-chip"
                      data-tone={s.status === "connected" ? "ok" : s.status === "disabled" ? undefined : "bad"}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td class="dh-fill">
                    <div class="dh-ellipsis dh-sub" title={s.error}>
                      {s.error ?? ""}
                    </div>
                  </td>
                  <td style={{ width: "210px" }}>
                    <div class="dh-toolbar">
                      <Button
                        size="small"
                        onClick={() => void act(name, s.status === "connected" ? "disconnect" : "connect")}
                      >
                        {s.status === "connected" ? "Disconnect" : "Connect"}
                      </Button>
                      <Button size="small" variant="ghost" onClick={() => void act(name, "toggle")}>
                        {s.status === "disabled" ? "Enable" : "Disable"}
                      </Button>
                    </div>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </Panel>
  )
}

// ── agents / skills / commands ────────────────────────────────────────────────

type Named = { name: string; description?: string; mode?: string; hidden?: boolean; location?: string }

function Catalog() {
  const agents = createPoll(() => call<Named[]>({ method: "GET", path: "/agent" }), 0, svc)
  const skills = createPoll(() => call<Named[]>({ method: "GET", path: "/skill" }), 0, svc)
  const commands = createPoll(() => call<Named[]>({ method: "GET", path: "/command" }), 0, svc)
  const [kind, setKind] = createSignal<"agents" | "skills" | "commands">("agents")
  const [q, setQ] = createSignal("")
  const src = () => (kind() === "agents" ? agents : kind() === "skills" ? skills : commands)
  const rows = createMemo(() => {
    const needle = q().toLowerCase()
    return (src().data() ?? []).filter(
      (r) => !needle || `${r.name} ${r.description ?? ""}`.toLowerCase().includes(needle),
    )
  })
  return (
    <Panel
      title={`${kind()} · ${rows().length}`}
      class="flush"
      actions={
        <Select
          size="small"
          options={["agents", "skills", "commands"]}
          current={kind()}
          label={(k) => `${k} (${(k === "agents" ? agents : k === "skills" ? skills : commands).data()?.length ?? 0})`}
          onSelect={(k) => k && setKind(k as never)}
        />
      }
    >
      <div class="dh-toolbar dh-compact-inputs" style={{ padding: "10px 12px" }}>
        <input
          class="dh-input"
          style={{ flex: 1 }}
          placeholder="Filter…"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
      </div>
      <Problem error={src().error()} />
      <div class="dh-scroll" style={{ "max-height": "60vh" }}>
        <table class="dh-table">
          <tbody>
            <For each={rows()}>
              {(r) => (
                <tr>
                  <td class="dh-mono" style={{ width: "210px", "white-space": "nowrap" }}>
                    {r.name}
                  </td>
                  <td class="dh-fill">
                    <div class="dh-ellipsis dh-sub" title={r.description}>
                      {r.description}
                    </div>
                  </td>
                  <td style={{ width: "90px" }}>
                    {r.mode ? <span class="dh-chip">{r.hidden ? `${r.mode} · hidden` : r.mode}</span> : null}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// ── config ────────────────────────────────────────────────────────────────────

const SECRET = /(key|token|secret|password|authorization)/i
const mask = (v: unknown, k = ""): unknown => {
  if (Array.isArray(v)) return v.map((x) => mask(x, k))
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([kk, vv]) => [kk, mask(vv, kk)]))
  return typeof v === "string" && SECRET.test(k) && v.length > 0 ? "••••••" : v
}

function Config() {
  const cfg = createPoll(() => call<unknown>({ method: "GET", path: "/config" }), 0, svc)
  const text = () => JSON.stringify(mask(cfg.data()), null, 2) ?? ""
  return (
    <Panel
      title="Effective configuration"
      class="flush"
      actions={
        <>
          <Button size="small" onClick={() => void navigator.clipboard.writeText(text())}>
            Copy
          </Button>
          <Button
            size="small"
            onClick={() =>
              void call({ method: "POST", path: "/config/reload" }).then(
                () => (toastOk("Configuration reloaded"), cfg.reload()),
                (e) => toastError("Reload failed", e),
              )
            }
          >
            Reload from disk
          </Button>
        </>
      }
    >
      <Problem error={cfg.error()} />
      <Show when={cfg.data() !== undefined} fallback={<Loading />}>
        <pre class="dh-log" style={{ "max-height": "64vh" }}>
          {text()}
        </pre>
      </Show>
      <div class="dh-sub" style={{ padding: "8px 14px" }}>
        Values whose key looks like a secret are hidden here. Edit{" "}
        <span class="dh-mono">~/.config/nikcli/nikcli.json</span> to change settings.
      </div>
    </Panel>
  )
}

export function Manage() {
  const [tab, setTab] = createSignal(localStorage.getItem("devhub.manage.tab") ?? "sessions")
  return (
    <Page
      title="Manage"
      subtitle={`Everything nikcli exposes, from one place — sessions, providers, MCP servers, agents and configuration${app.service() ? "" : " (no service running)"}`}
    >
      <Tabs value={tab()} onChange={(t) => (setTab(t), localStorage.setItem("devhub.manage.tab", t))} variant="alt">
        <Tabs.List>
          <Tabs.Trigger value="sessions">Sessions</Tabs.Trigger>
          <Tabs.Trigger value="providers">Providers</Tabs.Trigger>
          <Tabs.Trigger value="mcp">MCP</Tabs.Trigger>
          <Tabs.Trigger value="catalog">Agents & skills</Tabs.Trigger>
          <Tabs.Trigger value="config">Config</Tabs.Trigger>
        </Tabs.List>
      </Tabs>
      <SolidSwitch>
        <Match when={tab() === "sessions"}>
          <Sessions />
        </Match>
        <Match when={tab() === "providers"}>
          <Providers />
        </Match>
        <Match when={tab() === "mcp"}>
          <Mcp />
        </Match>
        <Match when={tab() === "catalog"}>
          <Catalog />
        </Match>
        <Match when={tab() === "config"}>
          <Config />
        </Match>
      </SolidSwitch>
    </Page>
  )
}

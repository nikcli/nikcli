import { For, Match, Show, Switch as SolidSwitch, createMemo, createSignal, onCleanup } from "solid-js"
import { open as pickFolder } from "@tauri-apps/plugin-dialog"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Effect } from "effect"
import { Button } from "@nikcli-ai/ui/button"
import { Icon } from "@nikcli-ai/ui/icon"
import { Switch } from "@nikcli-ai/ui/switch"
import { useTheme, type ColorScheme } from "@nikcli-ai/ui/theme"
import { Gateway } from "../lib/agent"
import { errorText, native } from "../lib/native"
import { runApp } from "../lib/runtime"
import { app, createPoll, toastError, toastOk } from "../lib/store"
import { when } from "../lib/format"
import { Dot, KV, Loading, Page, Panel, Problem } from "../components/kit"

type AccountInfo = {
  id: string
  email: string
  url: string
  active_org_id?: string | null
  created_at: number
  updated_at: number
}
type LoginStart = {
  deviceCode: string
  userCode: string
  verificationUrl: string
  verificationUrlComplete: string
  interval: number
  expiresIn: number
  expiresAt: number
}

const initials = (email: string) =>
  email
    .split("@")[0]
    .split(/[._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?"

function Account() {
  const account = createPoll(
    () => runApp(Gateway.use((g) => g.json<AccountInfo | null>({ method: "GET", path: "/account" }))),
    0,
    () => app.service()?.url,
  )
  const [start, setStart] = createSignal<LoginStart>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  let attempt = 0
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))
  const left = () => {
    const s = start()
    if (!s) return ""
    const sec = Math.max(0, Math.round((s.expiresAt - now()) / 1000))
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`
  }

  const signIn = async () => {
    const svc = app.service()
    if (!svc) return toastError("No service", "Start a nikcli service first")
    const mine = ++attempt
    setBusy(true)
    setError(undefined)
    try {
      const s = await runApp(
        Gateway.use((g) => g.json<LoginStart>({ method: "POST", path: "/account/login", timeoutSecs: 30 })),
      )
      if (mine !== attempt) return
      setStart(s)
      await openUrl(s.verificationUrlComplete).catch(() => undefined)
      const done = await native.accountComplete(svc.url, s.deviceCode, s.expiresIn)
      if (mine !== attempt) return
      setStart(undefined)
      if (!done.provisioned) throw new Error("Signed in, but this install could not be provisioned — try again")
      toastOk(done.email ? `Signed in as ${done.email}` : "Signed in to your nikcli account")
      await account.reload()
    } catch (e) {
      if (mine !== attempt) return
      setStart(undefined)
      setError(errorText(e))
    } finally {
      if (mine === attempt) setBusy(false)
    }
  }
  const cancel = () => (attempt++, setStart(undefined), setBusy(false))
  const signOut = async () => {
    const svc = app.service()
    if (!svc || !confirm("Sign out of your nikcli account on this machine?")) return
    try {
      await native.accountSignOut(svc.url)
      toastOk("Signed out")
      await account.reload()
    } catch (e) {
      toastError("Could not sign out", e)
    }
  }

  return (
    <Panel
      title="Account"
      actions={
        <Show
          when={account.data() && !start()}
          fallback={
            <Show when={!start() && !account.loading()}>
              <Button size="small" variant="primary" disabled={busy() || !app.service()} onClick={() => void signIn()}>
                Sign in
              </Button>
            </Show>
          }
        >
          <Button size="small" onClick={() => void signOut()}>
            Sign out
          </Button>
        </Show>
      }
    >
      <Problem error={account.error() ?? error()} title="Account" />
      <SolidSwitch>
        <Match when={start()}>
          <div class="dh-login">
            <p>Approve the sign-in in your browser. The code below must match the one shown there.</p>
            <div class="dh-login__code">{start()!.userCode}</div>
            <div class="dh-toolbar">
              <span class="dh-chip">expires in {left()}</span>
              <Button size="small" onClick={() => void openUrl(start()!.verificationUrlComplete)}>
                Open browser again
              </Button>
              <Button size="small" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </div>
            <span class="dh-sub dh-mono">{start()!.verificationUrl}</span>
          </div>
        </Match>
        <Match when={account.loading() && account.data() === undefined}>
          <Loading label="Reading account…" />
        </Match>
        <Match when={account.data()}>
          <div class="dh-account">
            <span class="dh-avatar" aria-hidden="true">
              {initials(account.data()!.email)}
            </span>
            <div>
              <strong>{account.data()!.email}</strong>
              <div class="dh-sub">Signed in · member since {when(account.data()!.created_at)}</div>
            </div>
          </div>
          <KV
            rows={[
              ["Account", <span class="dh-mono">{account.data()!.id}</span>],
              ["Issuer", <span class="dh-mono">{account.data()!.url}</span>],
              ["Organisation", account.data()!.active_org_id ?? "personal"],
            ]}
          />
        </Match>
        <Match when={true}>
          <p class="dh-sub" style={{ margin: 0 }}>
            Not signed in. Sign in to sync with your nikcli account — the same sign-in the terminal and desktop app use.
          </p>
        </Match>
      </SolidSwitch>
    </Panel>
  )
}

function Appearance() {
  const theme = useTheme()
  const [q, setQ] = createSignal("")
  const [limit, setLimit] = createSignal(36)
  const list = createMemo(() => {
    const needle = q().trim().toLowerCase()
    return Object.values(theme.themes())
      .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.id.includes(needle))
      .sort((a, b) => (a.id === theme.themeId() ? -1 : b.id === theme.themeId() ? 1 : a.name.localeCompare(b.name)))
  })
  const SCHEMES: { id: ColorScheme; label: string }[] = [
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ]
  return (
    <Panel title={`Appearance · ${Object.keys(theme.themes()).length} themes`} class="dh-appearance">
      <div class="dh-toolbar" style={{ "margin-bottom": "12px" }}>
        <div class="dh-seg" role="radiogroup" aria-label="Colour scheme">
          <For each={SCHEMES}>
            {(s) => (
              <button
                role="radio"
                aria-checked={theme.colorScheme() === s.id}
                data-active={theme.colorScheme() === s.id}
                onClick={() => theme.setColorScheme(s.id)}
              >
                {s.label}
              </button>
            )}
          </For>
        </div>
        <input
          class="dh-input"
          style={{ flex: 1 }}
          placeholder="Search themes…"
          value={q()}
          onInput={(e) => (setQ(e.currentTarget.value), setLimit(36))}
        />
      </div>
      <div class="dh-themes" onMouseLeave={() => theme.cancelPreview()}>
        <For each={list().slice(0, limit())}>
          {(t) => {
            const seeds = () => (theme.mode() === "dark" ? t.dark : t.light).seeds
            return (
              <button
                class="dh-theme"
                data-active={t.id === theme.themeId()}
                onMouseEnter={() => theme.previewTheme(t.id)}
                onFocus={() => theme.previewTheme(t.id)}
                onClick={() => (theme.setTheme(t.id), theme.cancelPreview())}
              >
                <span
                  class="dh-theme__swatch"
                  style={{
                    background:
                      (theme.mode() === "dark" ? t.dark : t.light).overrides?.["background-base"] ?? seeds().neutral,
                  }}
                >
                  <i style={{ background: seeds().primary }} />
                  <i style={{ background: seeds().success }} />
                  <i style={{ background: seeds().warning }} />
                  <i style={{ background: seeds().error }} />
                </span>
                <span class="dh-theme__name">{t.name}</span>
                <Show when={t.id === theme.themeId()}>
                  <Icon name="check-small" size="small" />
                </Show>
              </button>
            )
          }}
        </For>
      </div>
      <Show when={list().length > limit()}>
        <div class="dh-toolbar" style={{ "margin-top": "12px", "justify-content": "center" }}>
          <Button size="small" onClick={() => setLimit((l) => l + 48)}>
            Show more ({list().length - limit()})
          </Button>
        </div>
      </Show>
    </Panel>
  )
}

function Workspace() {
  const pick = async () => {
    const dir = await pickFolder({ directory: true, title: "Select the nikcli repository" })
    if (typeof dir !== "string") return
    try {
      await app.setRepo(dir)
      toastOk("Repository set", dir)
    } catch (e) {
      toastError("Not a nikcli repository", e)
    }
  }
  return (
    <Panel
      title="Workspace"
      actions={
        <Button size="small" onClick={() => void pick()}>
          Choose repository…
        </Button>
      }
    >
      <Problem error={app.repoError()} title="Repository" />
      <KV
        rows={[
          ["Repository", <span class="dh-mono">{app.repo() ?? "not found"}</span>],
          [
            "Services",
            <For each={app.services()} fallback={<span>none registered</span>}>
              {(s) => (
                <div
                  class="dh-mono"
                  style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}
                >
                  <Dot tone={s.alive ? "ok" : "bad"} live={s.alive} />
                  {s.channel} · :{new URL(s.url).port} · pid {s.pid} · v{s.version}
                  <span class="dh-chip" data-tone={s.alive ? "ok" : "bad"}>
                    {s.alive ? "running" : "stopped"}
                  </span>
                </div>
              )}
            </For>,
          ],
          ["Selected", app.service() ? `${app.service()!.channel} (${app.service()!.file})` : "—"],
          ["Started", app.service() ? when(app.service()!.startedAt) : "—"],
        ]}
      />
    </Panel>
  )
}

function Behaviour() {
  const [auto, setAuto] = createSignal(localStorage.getItem("devhub.chat.auto") === "true")
  return (
    <Panel title="Assistant">
      <Switch
        checked={auto()}
        onChange={(v) => {
          setAuto(v)
          localStorage.setItem("devhub.chat.auto", String(v))
          toastOk(v ? "Auto-run on" : "Auto-run off", "Applies the next time the assistant panel loads")
        }}
        description="Run the assistant's actions without asking. Terminating a process always asks."
      >
        Auto-run actions
      </Switch>
    </Panel>
  )
}

export function Settings() {
  return (
    <Page title="Settings" subtitle="Your account, the look of DevHub, and what it is connected to">
      <div class="dh-grid" data-cols="2">
        <Account />
        <Workspace />
      </div>
      <Appearance />
      <Behaviour />
    </Page>
  )
}

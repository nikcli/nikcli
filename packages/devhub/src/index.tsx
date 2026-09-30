/* @refresh reload */
import { initPlatform, shortcut } from "./lib/platform"
import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@nikcli-ai/ui/font"
import { Icon, type IconProps } from "@nikcli-ai/ui/icon"
import { Logo } from "@nikcli-ai/ui/logo"
import { Select } from "@nikcli-ai/ui/select"
import { Toast } from "@nikcli-ai/ui/toast"
import { ThemeProvider } from "@nikcli-ai/ui/theme"
import { MarkedProvider } from "@nikcli-ai/ui/context/marked"
import "./styles.css"
import { app } from "./lib/store"
import { assistant } from "./lib/assistant"
import { native } from "./lib/native"
import { runner } from "./lib/tasks"
import { PAGES, type PageId } from "./lib/actions"
import { Assistant } from "./components/assistant"
import { Palette } from "./components/palette"
import { StatusBar } from "./components/statusbar"
import { Dot } from "./components/kit"
import { Overview } from "./pages/overview"
import { Processes } from "./pages/processes"
import { Tests } from "./pages/tests"
import { Benchmarks } from "./pages/benchmarks"
import { Playground } from "./pages/playground"
import { ApiConsole } from "./pages/api"
import { Activity } from "./pages/activity"
import { System } from "./pages/system"
import { Telemetry } from "./pages/telemetry"
import { Manage } from "./pages/manage"
import { Settings } from "./pages/settings"

const NAV: { id: PageId; label: string; icon: IconProps["name"] }[] = [
  { id: "overview", label: "Overview", icon: "layout-left" },
  { id: "processes", label: "Processes", icon: "server" },
  { id: "tests", label: "Tests", icon: "checklist" },
  { id: "benchmarks", label: "Benchmarks", icon: "task" },
  { id: "playground", label: "Playground", icon: "models" },
  { id: "telemetry", label: "Telemetry", icon: "dot-grid" },
  { id: "manage", label: "Manage", icon: "sliders" },
  { id: "api", label: "API console", icon: "code" },
  { id: "activity", label: "Activity", icon: "bubble-5" },
  { id: "system", label: "System", icon: "server" },
  { id: "settings", label: "Settings", icon: "settings-gear" },
]

const isPage = (v: string | null): v is PageId => !!v && (PAGES as readonly string[]).includes(v)

function Shell() {
  const [page, setPageRaw] = createSignal<PageId>(
    isPage(localStorage.getItem("devhub.page")) ? (localStorage.getItem("devhub.page") as PageId) : "overview",
  )
  const [palette, setPalette] = createSignal(false)
  const go = (id: string) => {
    if (!isPage(id)) return
    setPageRaw(id)
    assistant.setPage(id)
    localStorage.setItem("devhub.page", id)
    document.getElementById("dh-main")?.scrollTo({ top: 0 })
  }
  assistant.bindNavigate(go)
  assistant.setPage(page())

  const running = (id: string) =>
    runner
      .active()
      .filter((r) => (id === "tests" ? r.kind === "test" : id === "benchmarks" ? r.kind === "bench" : false)).length

  onMount(() => {
    const unlisten: (() => void)[] = []
    const inTauri = "__TAURI_INTERNALS__" in window
    if (inTauri) {
      void native.onNav((p) => go(p)).then((u) => unlisten.push(u))
      void native
        .onUi((c) => {
          if (c === "assistant") assistant.toggle()
          else if (c === "palette") setPalette((v) => !v)
          else if (c === "sample") void app.refreshNow()
        })
        .then((u) => unlisten.push(u))
      // Native vibrancy behind the sidebar; the page only goes transparent once it is really applied.
      void native.windowEffects().then((ok) => ok && document.documentElement.setAttribute("data-vibrancy", ""))
    } else {
      // Plain browser (vite dev): the native menu does not exist, so handle the same accelerators here.
      const onKey = (e: KeyboardEvent) => {
        if (!(e.metaKey || e.ctrlKey)) return
        const n = Number(e.key)
        if (n >= 1 && n <= 9) (e.preventDefault(), go(PAGES[n - 1]))
        else if (e.key === ",") (e.preventDefault(), go("settings"))
        else if (e.key === "j") (e.preventDefault(), assistant.toggle())
        else if (e.key === "k") (e.preventDefault(), setPalette((v) => !v))
      }
      window.addEventListener("keydown", onKey)
      unlisten.push(() => window.removeEventListener("keydown", onKey))
    }
    document.documentElement.setAttribute("data-tauri", inTauri ? "" : "false")
    onCleanup(() => unlisten.forEach((u) => u()))
  })

  return (
    <div class="dh-shell" data-assistant={assistant.open()}>
      <aside class="dh-side">
        <div class="dh-side__brand" data-tauri-drag-region>
          <Logo />
        </div>
        <nav class="dh-side__nav" aria-label="Sections">
          <For each={NAV}>
            {(item, i) => (
              <button
                class="dh-nav"
                data-active={page() === item.id}
                aria-current={page() === item.id ? "page" : undefined}
                onClick={() => go(item.id)}
              >
                <Icon name={item.icon} size="small" />
                <span>{item.label}</span>
                <Show
                  when={running(item.id)}
                  fallback={
                    <Show when={i() < 9 || item.id === "settings"}>
                      <kbd>{item.id === "settings" ? shortcut(",") : shortcut(String(i() + 1))}</kbd>
                    </Show>
                  }
                >
                  <span class="dh-nav__badge">
                    <Dot tone="warn" live /> {running(item.id)}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </nav>
        <button class="dh-account-chip" onClick={() => go("settings")} title="Account & settings">
          <span class="dh-avatar dh-avatar--sm" aria-hidden="true">
            {app.account() ? (app.account()!.email[0] ?? "?").toUpperCase() : "?"}
          </span>
          <span class="dh-account-chip__text">
            <strong>
              {app.account()
                ? app.account()!.email.split("@")[0]
                : app.account() === null
                  ? "Not signed in"
                  : "Account"}
            </strong>
            <em>
              {app.account()
                ? app.account()!.email.split("@")[1]
                : app.account() === null
                  ? "Sign in from Settings"
                  : "…"}
            </em>
          </span>
        </button>
        <div class="dh-service" data-alive={app.service()?.alive ?? false}>
          <div class="dh-service__row">
            <Dot tone={app.service()?.alive ? "ok" : "bad"} live={app.service()?.alive} />
            <strong>{app.service() ? `nikcli ${app.service()!.version}` : "no nikcli service"}</strong>
          </div>
          <Show
            when={app.service()}
            fallback={
              <span class="dh-sub">
                start it with <code>nikcli serve --service</code>
              </span>
            }
          >
            <span class="dh-sub dh-mono">
              {app.service()!.channel} · :{new URL(app.service()!.url).port} · pid {app.service()!.pid}
            </span>
          </Show>
          <Show when={app.services().length > 1}>
            <Select
              size="small"
              variant="ghost"
              options={app.services()}
              current={app.service()}
              value={(x) => x.url}
              label={(x) => `${x.channel} · :${new URL(x.url).port}${x.alive ? "" : " (stopped)"}`}
              onSelect={(x) => x && app.select(x.url)}
            />
          </Show>
        </div>
        <button class="dh-side__palette" onClick={() => setPalette(true)}>
          <Icon name="magnifying-glass" size="small" />
          <span>Command</span>
          <kbd>{shortcut("K")}</kbd>
        </button>
      </aside>

      <main class="dh-main" id="dh-main">
        <div class="dh-drag" data-tauri-drag-region />
        <div class="dh-view" data-page={page()}>
          <Switch>
            <Match when={page() === "overview"}>
              <Overview go={go} />
            </Match>
            <Match when={page() === "processes"}>
              <Processes />
            </Match>
            <Match when={page() === "tests"}>
              <Tests />
            </Match>
            <Match when={page() === "benchmarks"}>
              <Benchmarks />
            </Match>
            <Match when={page() === "playground"}>
              <Playground />
            </Match>
            <Match when={page() === "telemetry"}>
              <Telemetry />
            </Match>
            <Match when={page() === "manage"}>
              <Manage />
            </Match>
            <Match when={page() === "api"}>
              <ApiConsole />
            </Match>
            <Match when={page() === "activity"}>
              <Activity />
            </Match>
            <Match when={page() === "system"}>
              <System />
            </Match>
            <Match when={page() === "settings"}>
              <Settings />
            </Match>
          </Switch>
        </div>
      </main>

      <Assistant />
      <StatusBar go={go} />
      <Palette open={palette()} onClose={() => setPalette(false)} go={go} />
      <Toast.Region />
    </div>
  )
}

initPlatform()
render(
  () => (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <MarkedProvider>
          <Shell />
        </MarkedProvider>
      </ThemeProvider>
    </MetaProvider>
  ),
  document.getElementById("root")!,
)

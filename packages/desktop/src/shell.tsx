import { useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@nikcli-ai/util/encode"
import { getFilename } from "@nikcli-ai/util/path"
import { Icon } from "@nikcli-ai/ui/icon"
import { Avatar } from "@nikcli-ai/ui/avatar"
import { Button } from "@nikcli-ai/ui/button"
import { DropdownMenu } from "@nikcli-ai/ui/dropdown-menu"
import { Popover } from "@nikcli-ai/ui/popover"
import { TextField } from "@nikcli-ai/ui/text-field"
import { Mark, Splash } from "@nikcli-ai/ui/logo"
import {
  useAccount,
  useCommand,
  useGlobalSDK,
  useGlobalSync,
  useLayout,
  usePlatform,
  useServer,
  BrowserVisualEditor,
  type AccountUser,
  type LocalProject,
} from "@nikcli-ai/app"
import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
  type ParentProps,
} from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import { t } from "./i18n"
import { collectSessionPreviews, sessionPreviewFrameUrl, type SessionPreviewItem } from "./session-preview"

const SIDEBAR_MIN = 260
const SIDEBAR_MAX = 460
const SIDEBAR_DEFAULT = 326
const SIDEBAR_STORAGE_KEY = "sidebar-width"
const SHELL_LAYOUT_STORAGE_KEY = "layout-v5-initialized"

const REVIEW_MIN = 320
const REVIEW_MAX = 1200
const REVIEW_DEFAULT = 540
const REVIEW_STORAGE_KEY = "review-width"
const FILES_MIN = 640
const FILES_MAX = 1200
const FILES_DEFAULT = 760
const FILES_STORAGE_KEY = "files-width"
const WORKBENCH_COLLAPSED_STORAGE_KEY = "workbench-collapsed"

type SidebarView = "projects" | "automations" | "integrations" | "operations"

type SidebarCommand = {
  id: string
  title: string
  keybind?: string
}

const SIDEBAR_ACTION_ICONS: Record<string, Parameters<typeof Icon>[0]["name"]> = {
  "routine.list": "task",
  "desktop.workbench.browser": "window-cursor",
  "desktop.workbench.computer": "console",
  "brain.run": "brain",
  "provider.connect": "plus",
  "connectors.list": "link",
  "skill.list": "code",
  "mcp.toggle": "mcp",
  "nikcli.status": "circle-check",
  "analytics.view": "bullet-list",
  "support.doctor": "checklist",
  "otel.settings": "settings-gear",
  "server.switch": "server",
}

const clampSidebar = (value: number) => Math.min(Math.max(Math.round(value), SIDEBAR_MIN), SIDEBAR_MAX)
const clampReview = (value: number, max = REVIEW_MAX) => Math.min(Math.max(Math.round(value), REVIEW_MIN), max)

function isPrimarySession(session: { parentID?: string; time?: { archived?: number } }) {
  return !session.parentID && !session.time?.archived
}

function relativeTime(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  return `${weeks}w`
}

export function DesktopFrame(props: ParentProps) {
  const platform = usePlatform()
  const [width, setWidth] = createSignal(SIDEBAR_DEFAULT)
  const [reviewWidth, setReviewWidth] = createSignal(REVIEW_DEFAULT)
  const [filesWidth, setFilesWidth] = createSignal(FILES_DEFAULT)
  const [windowWidth, setWindowWidth] = createSignal(typeof window === "undefined" ? 1440 : window.innerWidth)
  const [appReady, setAppReady] = createSignal(false)
  let host: HTMLElement | undefined
  let dragging = false
  let startX = 0
  let startWidth = SIDEBAR_DEFAULT
  let draggingReview = false
  let startReviewX = 0
  let startReviewWidth = REVIEW_DEFAULT

  const storage = platform.storage?.("desktop-shell.dat")
  const workspaceWidth = createMemo(() => Math.max(REVIEW_MIN, windowWidth() - width()))
  const reviewMax = createMemo(() => Math.max(REVIEW_MIN, Math.min(REVIEW_MAX, Math.floor(workspaceWidth() * 0.45))))
  const filesMax = createMemo(() => Math.max(REVIEW_MIN, Math.min(FILES_MAX, Math.floor(workspaceWidth() * 0.72))))
  const effectiveReviewWidth = createMemo(() => clampReview(reviewWidth(), reviewMax()))
  const effectiveFilesWidth = createMemo(() => {
    const max = filesMax()
    const min = Math.min(FILES_MIN, max)
    return Math.min(Math.max(Math.round(filesWidth()), min), max)
  })
  const filesPanelActive = () => host?.querySelector(".desktop-tools--files") !== null
  const activeSidePanelWidth = () => (filesPanelActive() ? effectiveFilesWidth() : effectiveReviewWidth())
  const activeSidePanelMax = () => (filesPanelActive() ? filesMax() : reviewMax())
  const activeSidePanelMin = () => (filesPanelActive() ? Math.min(FILES_MIN, filesMax()) : REVIEW_MIN)

  const syncWindowWidth = () => setWindowWidth(window.innerWidth)

  const persist = () => {
    void storage?.setItem(SIDEBAR_STORAGE_KEY, String(width()))
  }

  const persistReview = () => {
    const key = filesPanelActive() ? FILES_STORAGE_KEY : REVIEW_STORAGE_KEY
    const value = filesPanelActive() ? filesWidth() : reviewWidth()
    void storage?.setItem(key, String(value))
  }

  const stopResize = () => {
    if (!dragging) return
    dragging = false
    document.documentElement.classList.remove("desktop-shell-resizing")
    persist()
  }

  const stopReviewResize = () => {
    if (!draggingReview) return
    draggingReview = false
    document.documentElement.classList.remove("desktop-shell-resizing")
    persistReview()
  }

  const moveResize = (event: PointerEvent) => {
    if (draggingReview) {
      const next = startReviewWidth - (event.clientX - startReviewX)
      if (filesPanelActive())
        setFilesWidth(Math.min(Math.max(Math.round(next), activeSidePanelMin()), activeSidePanelMax()))
      else setReviewWidth(clampReview(next, activeSidePanelMax()))
      return
    }
    if (!dragging) return
    setWidth(clampSidebar(startWidth + event.clientX - startX))
  }

  const startResize: JSX.EventHandlerUnion<HTMLDivElement, PointerEvent> = (event) => {
    if (event.button !== 0) return
    dragging = true
    startX = event.clientX
    startWidth = width()
    document.documentElement.classList.add("desktop-shell-resizing")
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const startReviewResize: JSX.EventHandlerUnion<HTMLDivElement, PointerEvent> = (event) => {
    if (event.button !== 0) return
    draggingReview = true
    startReviewX = event.clientX
    startReviewWidth = activeSidePanelWidth()
    document.documentElement.classList.add("desktop-shell-resizing")
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const resizeWithKeyboard: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    setWidth((current) => clampSidebar(current + (event.key === "ArrowLeft" ? -12 : 12)))
    persist()
  }

  const resizeReviewWithKeyboard: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const next = activeSidePanelWidth() + (event.key === "ArrowLeft" ? 16 : -16)
    if (filesPanelActive())
      setFilesWidth(Math.min(Math.max(Math.round(next), activeSidePanelMin()), activeSidePanelMax()))
    else setReviewWidth(clampReview(next, activeSidePanelMax()))
    persistReview()
  }

  onMount(() => {
    document.documentElement.dataset.nikcliDesktop = "true"
    void Promise.resolve(storage?.getItem(SIDEBAR_STORAGE_KEY))
      .then((value) => {
        if (value == null) return
        const parsed = Number(value)
        if (Number.isFinite(parsed)) setWidth(clampSidebar(parsed))
      })
      .catch(() => undefined)

    void Promise.resolve(storage?.getItem(REVIEW_STORAGE_KEY))
      .then((value) => {
        if (value == null) return
        const parsed = Number(value)
        if (Number.isFinite(parsed)) setReviewWidth(clampReview(parsed))
      })
      .catch(() => undefined)

    void Promise.resolve(storage?.getItem(FILES_STORAGE_KEY))
      .then((value) => {
        if (value == null) return
        const parsed = Number(value)
        if (Number.isFinite(parsed)) setFilesWidth(parsed)
      })
      .catch(() => undefined)

    window.addEventListener("resize", syncWindowWidth)
    window.addEventListener("pointermove", moveResize)
    window.addEventListener("pointerup", stopResize)
    window.addEventListener("pointerup", stopReviewResize)

    // The shared app interface connects to the server and mounts its router
    // asynchronously; until it produces DOM the workspace is blank. Keep a
    // splash over the app host until the first real content node appears so
    // the center never flashes empty on load.
    const markReady = () => {
      if (!host) return false
      for (const child of host.children) {
        if (child.id === "desktop-tools-mount") continue
        if (child.classList.contains("desktop-app-splash")) continue
        setAppReady(true)
        return true
      }
      return false
    }
    if (!markReady()) {
      const observer = new MutationObserver(() => {
        if (markReady()) observer.disconnect()
      })
      if (host) observer.observe(host, { childList: true })
      onCleanup(() => observer.disconnect())
    }
  })

  onCleanup(() => {
    window.removeEventListener("resize", syncWindowWidth)
    window.removeEventListener("pointermove", moveResize)
    window.removeEventListener("pointerup", stopResize)
    window.removeEventListener("pointerup", stopReviewResize)
    document.documentElement.classList.remove("desktop-shell-resizing")
    delete document.documentElement.dataset.nikcliDesktop
  })

  return (
    <div
      data-component="desktop-shell"
      style={{
        "--desktop-sidebar-width": `${width()}px`,
        "--desktop-review-width": `${effectiveReviewWidth()}px`,
        "--desktop-files-width": `${effectiveFilesWidth()}px`,
      }}
    >
      <aside id="desktop-sidebar-mount" aria-label="Projects and sessions" />
      <section class="desktop-app-host" ref={host}>
        <Show when={!appReady()}>
          <div class="desktop-app-splash" aria-hidden="true">
            <Splash class="desktop-app-splash__logo" />
          </div>
        </Show>
        {props.children}
        <div id="desktop-tools-mount" />
      </section>
      <div
        class="desktop-sidebar-resize"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={width()}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeWithKeyboard}
      />
      <div
        class="desktop-review-resize"
        role="separator"
        aria-label={t("desktop.workbench.resize")}
        aria-orientation="vertical"
        aria-valuemin={activeSidePanelMin()}
        aria-valuemax={activeSidePanelMax()}
        aria-valuenow={activeSidePanelWidth()}
        tabIndex={0}
        onPointerDown={startReviewResize}
        onKeyDown={resizeReviewWithKeyboard}
      />
    </div>
  )
}

function NavButton(props: {
  icon: Parameters<typeof Icon>[0]["name"]
  label: string
  active?: boolean
  primary?: boolean
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class="desktop-nav-button"
      classList={{
        "desktop-nav-button--active": props.active,
        "desktop-nav-button--primary": props.primary,
      }}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size="normal" />
      <span>{props.label}</span>
      <Show when={props.badge}>{(badge) => <span class="desktop-nav-button__badge">{badge()}</span>}</Show>
    </button>
  )
}

function SidebarCommandList(props: { items: SidebarCommand[]; empty: string; onSelect: (id: string) => void }) {
  return (
    <div class="desktop-sidebar__list">
      <For each={props.items}>
        {(item) => (
          <button type="button" class="desktop-sidebar__list-item" onClick={() => props.onSelect(item.id)}>
            <Icon name={SIDEBAR_ACTION_ICONS[item.id] ?? "task"} size="small" />
            <span>{item.title}</span>
            <Show when={item.keybind}>{(keybind) => <kbd>{keybind()}</kbd>}</Show>
          </button>
        )}
      </For>
      <Show when={props.items.length === 0}>
        <div class="desktop-sidebar__notice">{props.empty}</div>
      </Show>
    </div>
  )
}

function ProjectGroup(props: {
  project: LocalProject
  activeDirectory: string | undefined
  activeSessionID: string | undefined
  now: number
  onOpenProject: (project: LocalProject) => void
  onOpenSession: (project: LocalProject, sessionID: string) => void
}) {
  const sync = useGlobalSync()
  const layout = useLayout()
  const [data] = sync.child(props.project.worktree, { bootstrap: false })
  const expanded = () => props.project.expanded !== false
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const selected = createMemo(() => slug() === props.activeDirectory)
  const sessions = createMemo(() =>
    data.session
      .filter(isPrimarySession)
      .toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 6),
  )

  const toggle = (event: Event) => {
    event.stopPropagation()
    if (expanded()) layout.projects.collapse(props.project.worktree)
    else layout.projects.expand(props.project.worktree)
  }

  return (
    <section class="desktop-project" classList={{ "desktop-project--active": selected() }}>
      <div class="desktop-project__header">
        <button type="button" class="desktop-project__select" onClick={() => props.onOpenProject(props.project)}>
          <span class="desktop-project__folder">
            <Icon name="folder" size="normal" />
          </span>
          <span class="desktop-project__name">{props.project.name || getFilename(props.project.worktree)}</span>
        </button>
        <button
          type="button"
          class="desktop-project__chevron"
          classList={{ "desktop-project__chevron--collapsed": !expanded() }}
          aria-label={expanded() ? "Collapse project" : "Expand project"}
          onClick={toggle}
        >
          <Icon name="chevron-down" size="small" />
        </button>
      </div>
      <Show when={expanded()}>
        <div class="desktop-project__sessions">
          <For each={sessions()}>
            {(session) => (
              <button
                type="button"
                class="desktop-session-row"
                classList={{
                  "desktop-session-row--active": selected() && session.id === props.activeSessionID,
                }}
                onClick={() => props.onOpenSession(props.project, session.id)}
                title={session.title}
              >
                <span class="desktop-session-row__title">{session.title}</span>
                <span class="desktop-session-row__time">
                  {relativeTime(session.time.updated ?? session.time.created, props.now)}
                </span>
              </button>
            )}
          </For>
          <Show when={sessions().length === 0}>
            <button
              type="button"
              class="desktop-session-row desktop-session-row--empty"
              onClick={() => props.onOpenProject(props.project)}
            >
              Start a new session
            </button>
          </Show>
        </div>
      </Show>
    </section>
  )
}

function accountInitials(user: AccountUser) {
  const base = user.display_name?.trim() || user.username || user.email
  return base.slice(0, 2).toUpperCase()
}

function DesktopAccount() {
  const account = useAccount()
  const command = useCommand()
  const platform = usePlatform()
  const [open, setOpen] = createSignal(false)
  const [mode, setMode] = createSignal<"login" | "register">("login")
  const [form, setForm] = createStore({
    email: "",
    password: "",
    username: "",
    displayName: "",
  })
  const [busy, setBusy] = createSignal(false)
  const [oauthBusy, setOauthBusy] = createSignal(false)

  const oauthLogin = async () => {
    if (oauthBusy()) return
    account.clearError()
    setOauthBusy(true)
    try {
      await account.loginWithOAuth()
    } catch {
      // Failure is surfaced through account.error below.
    } finally {
      setOauthBusy(false)
    }
  }

  const displayName = createMemo(() => {
    const user = account.user
    return user?.display_name?.trim() || user?.username || t("desktop.account.signIn")
  })
  const planLabel = createMemo(() =>
    account.user?.role === "admin" ? t("desktop.account.admin") : t("desktop.account.member"),
  )

  const resetForm = () => setForm({ email: "", password: "", username: "", displayName: "" })

  const submit: JSX.EventHandlerUnion<HTMLFormElement, SubmitEvent> = async (event) => {
    event.preventDefault()
    if (busy()) return
    setBusy(true)
    try {
      if (mode() === "register") {
        await account.register({
          username: form.username.trim(),
          email: form.email.trim(),
          password: form.password,
          displayName: form.displayName.trim() || undefined,
        })
      } else {
        await account.login(form.email.trim(), form.password)
      }
      resetForm()
      setOpen(false)
    } catch {
      // Failure is surfaced through account.error below.
    } finally {
      setBusy(false)
    }
  }

  const toggleMode = () => {
    account.clearError()
    setMode((current) => (current === "register" ? "login" : "register"))
  }

  return (
    <Show
      when={account.user}
      fallback={
        <Popover
          open={open()}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) account.clearError()
          }}
          placement="top-start"
          gutter={8}
          triggerAs="button"
          triggerProps={{
            type: "button",
            class: "desktop-account desktop-account--signed-out",
          }}
          class="desktop-account__popover"
          trigger={
            <>
              <span class="desktop-account__avatar desktop-account__avatar--empty">
                <Icon name="enter" size="small" />
              </span>
              <span class="desktop-account__copy">
                <span>{t("desktop.account.signIn")}</span>
                <span>{account.serverName}</span>
              </span>
              <Icon name="chevron-right" size="small" />
            </>
          }
        >
          <form class="desktop-account__form" onSubmit={submit}>
            <strong>
              {mode() === "register" ? t("desktop.account.signUpTitle") : t("desktop.account.signInTitle")}
            </strong>
            <Button type="button" disabled={oauthBusy()} onClick={oauthLogin}>
              {oauthBusy() ? t("desktop.account.oauthWaiting") : t("desktop.account.oauth")}
            </Button>
            <span class="desktop-account__hint">{t("desktop.account.oauthHint")}</span>
            <span class="desktop-account__divider">{t("desktop.account.legacyDivider")}</span>
            <Show when={mode() === "register"}>
              <TextField
                label={t("desktop.account.username")}
                value={form.username}
                onChange={(value) => setForm("username", value)}
                autocomplete="username"
                required
                disabled={busy()}
              />
              <TextField
                label={t("desktop.account.displayName")}
                value={form.displayName}
                onChange={(value) => setForm("displayName", value)}
                disabled={busy()}
              />
            </Show>
            <TextField
              label={t("desktop.account.email")}
              type="email"
              value={form.email}
              onChange={(value) => setForm("email", value)}
              autocomplete="email"
              required
              disabled={busy()}
              autofocus
            />
            <TextField
              label={t("desktop.account.password")}
              type="password"
              value={form.password}
              onChange={(value) => setForm("password", value)}
              autocomplete={mode() === "register" ? "new-password" : "current-password"}
              required
              disabled={busy()}
            />
            <Show when={account.error}>
              <span class="desktop-account__error">{account.error}</span>
            </Show>
            <Button type="submit" disabled={busy()}>
              {busy()
                ? t("desktop.account.signingIn")
                : mode() === "register"
                  ? t("desktop.account.register")
                  : t("desktop.account.submit")}
            </Button>
            <Show when={account.canRegister || mode() === "register"}>
              <button type="button" class="desktop-account__switch" onClick={toggleMode}>
                {mode() === "register" ? t("desktop.account.loginToggle") : t("desktop.account.registerToggle")}
              </button>
            </Show>
          </form>
        </Popover>
      }
    >
      {(user) => (
        <DropdownMenu placement="top-start" gutter={8}>
          <DropdownMenu.Trigger as="button" type="button" class="desktop-account">
            <Avatar class="desktop-account__avatar" fallback={accountInitials(user())} size="small" />
            <span class="desktop-account__copy">
              <span>{displayName()}</span>
              <span>{planLabel()}</span>
            </span>
            <Icon name="selector" size="small" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="desktop-account__menu">
              <div class="desktop-account__menu-header">
                <span>{user().email}</span>
                <span>{t("desktop.account.personal")}</span>
              </div>
              <DropdownMenu.Separator />
              <DropdownMenu.Item class="desktop-account__menu-item" onSelect={() => command.trigger("settings.open")}>
                <Icon name="glasses" size="small" />
                <DropdownMenu.ItemLabel>{t("desktop.account.profile")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item class="desktop-account__menu-item" onSelect={() => command.trigger("settings.open")}>
                <Icon name="settings-gear" size="small" />
                <DropdownMenu.ItemLabel>{t("desktop.account.settings")}</DropdownMenu.ItemLabel>
                <kbd class="desktop-account__menu-kbd">⌘,</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="desktop-account__menu-item"
                onSelect={() => platform.openLink("https://nikcli-ai.dev")}
              >
                <Icon name="share" size="small" />
                <DropdownMenu.ItemLabel>{t("desktop.account.invite")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item class="desktop-account__menu-item" onSelect={() => command.trigger("analytics.view")}>
                <Icon name="bullet-list" size="small" />
                <DropdownMenu.ItemLabel>{t("desktop.account.usage")}</DropdownMenu.ItemLabel>
                <Icon name="chevron-right" size="small" class="desktop-account__menu-trailing" />
              </DropdownMenu.Item>
              <DropdownMenu.Item class="desktop-account__menu-item" onSelect={() => void account.logout()}>
                <Icon name="arrow-right" size="small" />
                <DropdownMenu.ItemLabel>{t("desktop.account.logout")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      )}
    </Show>
  )
}

function DesktopSidebar() {
  const command = useCommand()
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()
  const params = useParams()
  const navigate = useNavigate()
  const [view, setView] = createSignal<SidebarView>("projects")
  const [now, setNow] = createSignal(Date.now())

  const projects = createMemo(() => layout.projects.list())
  const plugins = createMemo(() => sync.data.config.plugin ?? [])
  const commandMap = createMemo(
    () =>
      new Map(
        command.options
          .filter((option) => !option.id.startsWith("suggested.") && !option.disabled && !!option.onSelect)
          .map((option) => [
            option.id,
            {
              id: option.id,
              title: option.title,
              keybind: command.keybind(option.id) || undefined,
            },
          ]),
      ),
  )
  const commandItems = (ids: string[]) =>
    ids.flatMap((id) => {
      const option = commandMap().get(id)
      return option ? [option] : []
    })
  const automations = createMemo(() =>
    commandItems(["routine.list", "desktop.workbench.browser", "desktop.workbench.computer", "brain.run"]),
  )
  const integrations = createMemo(() =>
    commandItems(["provider.connect", "connectors.list", "skill.list", "mcp.toggle"]),
  )
  const operations = createMemo(() =>
    commandItems(["nikcli.status", "analytics.view", "support.doctor", "otel.settings", "server.switch"]),
  )

  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const openProject = (project: LocalProject) => {
    const slug = base64Encode(project.worktree)
    layout.projects.open(project.worktree)
    navigate(`/${slug}/session`)
  }

  const openSession = (project: LocalProject, sessionID: string) => {
    const slug = base64Encode(project.worktree)
    layout.projects.open(project.worktree)
    navigate(`/${slug}/session/${sessionID}`)
  }

  const newSession = () => {
    const current = projects().find((project) => base64Encode(project.worktree) === params.dir) ?? projects()[0]
    if (!current) {
      command.trigger("project.open")
      return
    }
    openProject(current)
  }

  const toggleView = (next: SidebarView) => setView((current) => (current === next ? "projects" : next))

  return (
    <div class="desktop-sidebar">
      <div class="desktop-sidebar__titlebar" data-tauri-drag-region>
        <div class="desktop-sidebar__history" aria-hidden="true">
          <Icon name="arrow-left" size="small" />
          <Icon name="arrow-right" size="small" />
        </div>
      </div>

      <div class="desktop-sidebar__primary">
        <div class="desktop-sidebar__brand">
          <span>
            <Mark class="desktop-sidebar__brand-mark" />
          </span>
          <strong>Nikcli</strong>
          <small>Desktop</small>
        </div>
        <NavButton icon="edit-small-2" label={t("desktop.sidebar.newChat")} primary onClick={newSession} />
        <NavButton icon="magnifying-glass" label={t("desktop.sidebar.search")} onClick={command.show} />
        <NavButton
          icon="eye"
          label={t("desktop.sidebar.sites")}
          onClick={() => command.trigger("desktop.workbench.preview")}
        />
        <NavButton
          icon="task"
          label={t("desktop.sidebar.automations")}
          active={view() === "automations"}
          onClick={() => toggleView("automations")}
        />
        <NavButton
          icon="mcp"
          label={t("desktop.sidebar.integrations")}
          active={view() === "integrations"}
          badge={plugins().length ? String(plugins().length) : undefined}
          onClick={() => toggleView("integrations")}
        />
        <NavButton
          icon="circle-check"
          label={t("desktop.sidebar.operations")}
          active={view() === "operations"}
          onClick={() => toggleView("operations")}
        />
      </div>

      <div class="desktop-sidebar__content">
        <Show when={view() === "projects"}>
          <div class="desktop-sidebar__section-heading">
            <span>{t("desktop.sidebar.projects")}</span>
            <button
              type="button"
              onClick={() => command.trigger("project.open")}
              aria-label={t("desktop.sidebar.openProject")}
            >
              <Icon name="plus-small" size="small" />
            </button>
          </div>
          <div class="desktop-sidebar__scroll">
            <For each={projects()}>
              {(project) => (
                <ProjectGroup
                  project={project}
                  activeDirectory={params.dir}
                  activeSessionID={params.id}
                  now={now()}
                  onOpenProject={openProject}
                  onOpenSession={openSession}
                />
              )}
            </For>
            <Show when={projects().length === 0}>
              <button type="button" class="desktop-sidebar__empty" onClick={() => command.trigger("project.open")}>
                <Icon name="folder-add-left" size="normal" />
                <span>{t("desktop.sidebar.emptyProjects")}</span>
              </button>
            </Show>
          </div>
        </Show>

        <Show when={view() === "automations"}>
          <div class="desktop-sidebar__section-heading">
            <span>{t("desktop.sidebar.automations")}</span>
            <button type="button" onClick={() => setView("projects")} aria-label={t("desktop.sidebar.closePanel")}>
              <Icon name="close-small" size="small" />
            </button>
          </div>
          <div class="desktop-sidebar__scroll desktop-sidebar__list">
            <SidebarCommandList
              items={automations()}
              empty={t("desktop.sidebar.noActions")}
              onSelect={(id) => command.trigger(id)}
            />
          </div>
        </Show>

        <Show when={view() === "integrations"}>
          <div class="desktop-sidebar__section-heading">
            <span>{t("desktop.sidebar.integrations")}</span>
            <button type="button" onClick={() => setView("projects")} aria-label={t("desktop.sidebar.closePanel")}>
              <Icon name="close-small" size="small" />
            </button>
          </div>
          <div class="desktop-sidebar__scroll desktop-sidebar__list">
            <SidebarCommandList
              items={integrations()}
              empty={t("desktop.sidebar.noActions")}
              onSelect={(id) => command.trigger(id)}
            />
            <div class="desktop-sidebar__section-heading desktop-sidebar__section-heading--nested">
              <span>{t("desktop.sidebar.configuredPlugins")}</span>
            </div>
            <For each={plugins()}>
              {(plugin) => (
                <div class="desktop-sidebar__list-item">
                  <Icon name="mcp" size="small" />
                  <span>{String(plugin)}</span>
                </div>
              )}
            </For>
            <Show when={plugins().length === 0}>
              <div class="desktop-sidebar__notice">{t("desktop.sidebar.noPlugins")}</div>
            </Show>
          </div>
        </Show>

        <Show when={view() === "operations"}>
          <div class="desktop-sidebar__section-heading">
            <span>{t("desktop.sidebar.operations")}</span>
            <button type="button" onClick={() => setView("projects")} aria-label={t("desktop.sidebar.closePanel")}>
              <Icon name="close-small" size="small" />
            </button>
          </div>
          <div class="desktop-sidebar__scroll desktop-sidebar__list">
            <SidebarCommandList
              items={operations()}
              empty={t("desktop.sidebar.noActions")}
              onSelect={(id) => command.trigger(id)}
            />
          </div>
        </Show>
      </div>

      <div class="desktop-sidebar__footer">
        <button
          type="button"
          class="desktop-sidebar__server"
          onClick={() => command.trigger("server.switch")}
          title={server.url}
        >
          <span
            classList={{
              "desktop-sidebar__server-status": true,
              "desktop-sidebar__server-status--healthy": server.healthy() === true,
              "desktop-sidebar__server-status--unhealthy": server.healthy() === false,
            }}
          />
          <span class="desktop-sidebar__server-copy">
            <span>{server.name}</span>
            <span>
              {server.healthy() === true
                ? t("desktop.sidebar.serverConnected")
                : server.healthy() === false
                  ? t("desktop.sidebar.serverUnreachable")
                  : t("desktop.sidebar.serverChecking")}
            </span>
          </span>
          <Icon name="chevron-right" size="small" />
        </button>
        <button type="button" class="desktop-sidebar__settings" onClick={() => command.trigger("settings.open")}>
          <Icon name="settings-gear" size="normal" />
          <span>{t("desktop.sidebar.settings")}</span>
          <span class="desktop-sidebar__version">v{platform.version}</span>
        </button>
        <DesktopAccount />
      </div>
    </div>
  )
}

type AutomationPart = {
  id: string
  tool: AutomationTool
  state: {
    status: "pending" | "running" | "completed" | "error"
    input: Record<string, unknown>
    title?: string
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    attachments?: Array<{
      mime: string
      url?: string
      source?: { type: "file"; path: string }
    }>
  }
}

type AutomationSurface = "browser" | "computer"
type AutomationTool = "browser_control" | "computer"
type SessionPanelSurface = "review" | "terminal" | "files"
type WorkbenchSurface = SessionPanelSurface | AutomationSurface | "preview" | "visualEditor"

// The workbench tab keeps the short "browser" id (it names a panel, and is
// baked into i18n/icon keys); the tool it renders is `browser_control`.
const AUTOMATION_TOOL: Record<AutomationSurface, AutomationTool> = {
  browser: "browser_control",
  computer: "computer",
}
const AUTOMATION_SURFACE: Record<AutomationTool, AutomationSurface> = {
  browser_control: "browser",
  computer: "computer",
}

const isAutomationSurface = (surface: WorkbenchSurface): surface is AutomationSurface =>
  surface === "browser" || surface === "computer"

const isSessionPanelSurface = (surface: WorkbenchSurface): surface is SessionPanelSurface =>
  surface === "review" || surface === "terminal" || surface === "files"

const isWorkbenchOverlaySurface = (surface: WorkbenchSurface) =>
  surface === "preview" || surface === "visualEditor" || isAutomationSurface(surface)

function automationMetadata(part: AutomationPart | undefined) {
  if (!part) return {}
  return part.state.metadata ?? {}
}

function automationScreenshot(part: AutomationPart | undefined) {
  if (!part || part.state.status !== "completed") return
  return part.state.attachments?.find((attachment) => attachment.mime.startsWith("image/"))?.url
}

function AutomationPanel(props: { surface: AutomationSurface; part?: AutomationPart }) {
  const metadata = createMemo(() => automationMetadata(props.part))
  const screenshot = createMemo(() => automationScreenshot(props.part))
  const liveUrl = createMemo(() => {
    // Only "computer" (sandbox mode) has a cloud live-preview iframe; the
    // local `browser_control` tool has no such thing — its state is a screenshot.
    if (props.surface !== "computer") return undefined
    const value = metadata().liveUrl
    return typeof value === "string" ? value : undefined
  })
  const summary = createMemo(() => {
    const value = metadata().summary
    if (typeof value === "string" && value.trim()) return value
    const action = metadata().action
    if (typeof action === "string" && action.trim()) return action
    return undefined
  })
  const output = createMemo(() => {
    if (props.part?.state.status === "error") return props.part.state.error
    if (props.part?.state.status !== "completed") return undefined
    return props.part.state.output?.trim()
  })

  return (
    <section id={`desktop-workbench-panel-${props.surface}`} class="desktop-automation" data-surface={props.surface}>
      <div class="desktop-automation__status">
        <span class="desktop-automation__status-icon">
          <Icon name={props.surface === "browser" ? "window-cursor" : "console"} size="normal" />
        </span>
        <div>
          <strong>{props.surface === "browser" ? "Browser" : "Computer Use"}</strong>
          <span>
            {summary() ?? (props.surface === "browser" ? "Local headless browser" : "Background desktop (sandbox)")}
          </span>
        </div>
        <span class="desktop-automation__badge" data-status={props.part?.state.status ?? "idle"}>
          {props.part?.state.status ?? "idle"}
        </span>
      </div>

      <Show when={liveUrl()}>
        {(url) => (
          <iframe
            class="desktop-automation__live"
            src={url()}
            title="Computer Use live preview"
            allow="clipboard-read; clipboard-write"
          />
        )}
      </Show>

      <Show when={!liveUrl() && screenshot()}>
        {(url) => <img class="desktop-automation__image" src={url()} alt={`${props.surface} screenshot`} />}
      </Show>

      <Show when={!props.part && !liveUrl() && !screenshot()}>
        <div class="desktop-automation__empty">
          <Icon name={props.surface === "browser" ? "window-cursor" : "console"} size="large" />
          <strong>{props.surface === "browser" ? "No browser session yet" : "No computer activity yet"}</strong>
          <span>
            {props.surface === "browser"
              ? "Ask Nikcli to use the browser. It runs headlessly in the background — a snapshot will appear here."
              : "Ask Nikcli to control a computer. It runs on a background desktop — the live preview will appear here."}
          </span>
        </div>
      </Show>

      <Show when={props.part && !liveUrl() && !screenshot()}>
        <div class="desktop-automation__activity">
          <span class="desktop-automation__pulse" />
          <span>{summary() ?? props.part?.state.title ?? `Running ${props.surface} action`}</span>
        </div>
      </Show>

      <Show when={output()}>{(value) => <pre class="desktop-automation__output">{value().slice(0, 6000)}</pre>}</Show>
    </section>
  )
}

function PreviewPanel(props: { items: SessionPreviewItem[] }) {
  const platform = usePlatform()
  const [selectedID, setSelectedID] = createSignal<string>()
  const selected = createMemo(() => {
    const items = props.items
    return items.find((item) => item.id === selectedID()) ?? items.at(-1)
  })

  createEffect(() => {
    const item = selected()
    if (item && item.id !== selectedID()) setSelectedID(item.id)
  })

  const canOpenExternally = createMemo(() => /^https?:\/\//.test(selected()?.url ?? ""))

  return (
    <section id="desktop-workbench-panel-preview" class="desktop-preview">
      <Show
        when={selected()}
        fallback={
          <div class="desktop-preview__empty">
            <Icon name="eye" size="large" />
            <strong>{t("desktop.workbench.previewEmptyTitle")}</strong>
            <span>{t("desktop.workbench.previewEmptyDescription")}</span>
          </div>
        }
      >
        {(item) => (
          <>
            <header class="desktop-preview__header">
              <div>
                <strong>{item().title}</strong>
                <span>
                  {item().kind}
                  <Show when={item().version}> · v{item().version}</Show>
                </span>
              </div>
              <Show when={canOpenExternally()}>
                <button
                  type="button"
                  title={t("desktop.workbench.previewOpen")}
                  aria-label={t("desktop.workbench.previewOpen")}
                  onClick={() => platform.openLink(item().url)}
                >
                  <Icon name="square-arrow-top-right" size="small" />
                </button>
              </Show>
            </header>

            <div class="desktop-preview__stage">
              <Switch>
                <Match when={item().kind === "image"}>
                  <img src={item().previewUrl} alt={item().title} />
                </Match>
                <Match when={item().kind === "video"}>
                  <video src={item().previewUrl} title={item().title} controls playsinline preload="metadata" />
                </Match>
                <Match when={item().kind === "html" || item().kind === "markdown" || item().kind === "text"}>
                  <iframe
                    src={sessionPreviewFrameUrl(item())}
                    title={item().title}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  />
                </Match>
              </Switch>
            </div>

            <Show when={item().description}>
              {(description) => <p class="desktop-preview__description">{description()}</p>}
            </Show>

            <Show when={props.items.length > 1}>
              <div class="desktop-preview__strip" aria-label={t("desktop.workbench.previewItems")}>
                <For each={[...props.items].reverse()}>
                  {(preview) => (
                    <button
                      type="button"
                      classList={{
                        "desktop-preview__item": true,
                        "desktop-preview__item--active": preview.id === item().id,
                      }}
                      aria-label={preview.title}
                      aria-pressed={preview.id === item().id}
                      onClick={() => setSelectedID(preview.id)}
                    >
                      <span class="desktop-preview__item-icon">
                        <Show when={preview.kind === "image"} fallback={<Icon name="eye" size="small" />}>
                          <img src={preview.previewUrl} alt="" />
                        </Show>
                      </span>
                      <span>
                        <strong>{preview.title}</strong>
                        <small>{preview.kind}</small>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}

function DesktopTools() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const params = useParams()
  const sessionKey = createMemo(() => `${params.dir ?? ""}${params.id ? `/${params.id}` : ""}`)
  const view = layout.view(sessionKey)
  const storage = platform.storage?.("desktop-shell.dat")
  const [workbench, setWorkbench] = createStore<{
    active: WorkbenchSurface
    automation: AutomationSurface
    collapsed: boolean
    fullscreen: boolean
  }>({
    active: "browser",
    automation: "browser",
    collapsed: true,
    fullscreen: false,
  })
  const available = createMemo(() => !!params.dir)
  const activeAutomation = createMemo<AutomationSurface>(() =>
    isAutomationSurface(workbench.active) ? workbench.active : workbench.automation,
  )
  const terminalOpen = createMemo(() => available() && view.terminal.opened())
  const fileTreeOpen = createMemo(() => available() && layout.fileTree.opened())
  const reviewOpen = createMemo(() => available() && view.reviewPanel.opened())
  const reviewTabOpen = createMemo(() => workbench.active === "review" && reviewOpen())
  const fileTabOpen = createMemo(() => workbench.active === "files" && fileTreeOpen())
  const terminalTabOpen = createMemo(() => workbench.active === "terminal" && terminalOpen())
  const activeProject = createMemo(() =>
    layout.projects.list().find((project) => base64Encode(project.worktree) === params.dir),
  )
  const activeData = createMemo(() => {
    const project = activeProject()
    if (!project) return
    return sync.child(project.worktree, { bootstrap: false })[0]
  })
  const automationParts = createMemo(() => {
    const data = activeData()
    const sessionID = params.id
    if (!data || !sessionID) return [] as AutomationPart[]
    return (data.message[sessionID] ?? []).flatMap((message) =>
      (data.part[message.id] ?? [])
        .filter(
          (part) =>
            part.type === "tool" && (part.tool === AUTOMATION_TOOL.browser || part.tool === AUTOMATION_TOOL.computer),
        )
        .map((part) => part as unknown as AutomationPart),
    )
  })
  const previewItems = createMemo(() => {
    const data = activeData()
    const sessionID = params.id
    if (!data || !sessionID) return []
    const parts = (data.message[sessionID] ?? []).flatMap((message) => data.part[message.id] ?? [])
    return collectSessionPreviews(parts)
  })
  const latestPart = createMemo(() => {
    const parts = automationParts()
    return [...parts].reverse().find((part) => part.tool === AUTOMATION_TOOL[activeAutomation()])
  })
  const latestAutomation = createMemo(() => automationParts().at(-1))
  const hasRunningAutomation = (surface: AutomationSurface) =>
    automationParts().some((part) => part.tool === AUTOMATION_TOOL[surface] && part.state.status === "running")

  const closeSessionPanels = (except?: SessionPanelSurface) => {
    if (except !== "review" && except !== "files") view.reviewPanel.close()
    if (except !== "terminal") view.terminal.close()
    if (except !== "files") layout.fileTree.close()
  }

  const openSurface = (surface: WorkbenchSurface) => {
    if ((isSessionPanelSurface(surface) || surface === "preview" || surface === "visualEditor") && !available()) return

    batch(() => {
      setWorkbench("collapsed", false)
      if (isWorkbenchOverlaySurface(surface)) {
        closeSessionPanels()
        setWorkbench("active", surface)
        if (isAutomationSurface(surface)) setWorkbench("automation", surface)
        return
      }

      if (surface === "review") {
        closeSessionPanels("review")
        view.reviewPanel.open()
      } else if (surface === "terminal") {
        closeSessionPanels("terminal")
        view.terminal.open()
      } else {
        closeSessionPanels("files")
        layout.fileTree.setTab("changes")
        view.reviewPanel.open()
        layout.fileTree.open()
      }

      setWorkbench("active", surface)
    })
  }

  const persistCollapsed = (collapsed: boolean) => {
    void Promise.resolve(storage?.setItem(WORKBENCH_COLLAPSED_STORAGE_KEY, String(collapsed))).catch(() => undefined)
  }

  const toggleCollapsed = () => {
    const next = !workbench.collapsed
    batch(() => {
      setWorkbench("collapsed", next)
      if (next) setWorkbench("fullscreen", false)
    })
    persistCollapsed(next)
  }

  const toggleFullscreen = () => {
    batch(() => {
      setWorkbench("collapsed", false)
      setWorkbench("fullscreen", (value) => !value)
    })
    persistCollapsed(false)
  }

  command.register("desktop-workbench", () => [
    {
      id: "desktop.workbench.browser",
      title: t("desktop.workbench.browser"),
      category: t("desktop.workbench.title"),
      onSelect: () => openSurface("browser"),
    },
    {
      id: "desktop.workbench.computer",
      title: t("desktop.workbench.computer"),
      category: t("desktop.workbench.title"),
      onSelect: () => openSurface("computer"),
    },
    {
      id: "desktop.workbench.preview",
      title: t("desktop.workbench.preview"),
      category: t("desktop.workbench.title"),
      disabled: !available(),
      onSelect: () => openSurface("preview"),
    },
    {
      id: "desktop.workbench.visualEditor",
      title: t("desktop.workbench.visualEditor"),
      category: t("desktop.workbench.title"),
      disabled: !available(),
      onSelect: () => openSurface("visualEditor"),
    },
  ])

  const panelControl = (surface: WorkbenchSurface) => {
    if (surface === "review" || surface === "files") return "review-panel"
    if (surface === "terminal") return "terminal-panel"
    return `desktop-workbench-panel-${surface}`
  }

  const handleTabKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return

    const current = event.target instanceof HTMLElement ? event.target.closest(".desktop-workbench__tab") : null
    if (!(current instanceof HTMLButtonElement)) return

    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".desktop-workbench__tab")).filter(
      (tab) => !tab.disabled,
    )
    if (tabs.length === 0) return

    const index = Math.max(0, tabs.indexOf(current))
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowLeft"
            ? (index - 1 + tabs.length) % tabs.length
            : (index + 1) % tabs.length

    event.preventDefault()
    tabs[nextIndex]?.focus()
  }

  onMount(() => {
    void (async () => {
      const initialized = await Promise.resolve(storage?.getItem(SHELL_LAYOUT_STORAGE_KEY)).catch(() => undefined)
      if (initialized === "true") {
        const collapsed = await Promise.resolve(storage?.getItem(WORKBENCH_COLLAPSED_STORAGE_KEY)).catch(
          () => undefined,
        )
        if (collapsed === "true" || collapsed === "false") setWorkbench("collapsed", collapsed === "true")
        return
      }

      layout.fileTree.close()
      view.reviewPanel.close()
      view.terminal.close()
      setWorkbench("collapsed", true)
      await Promise.all([
        Promise.resolve(storage?.setItem(SHELL_LAYOUT_STORAGE_KEY, "true")),
        Promise.resolve(storage?.setItem(WORKBENCH_COLLAPSED_STORAGE_KEY, "true")),
      ]).catch(() => undefined)
    })()
  })

  createEffect(
    on(
      () => latestAutomation()?.id,
      () => {
        const latest = latestAutomation()
        if (!latest) return
        batch(() => {
          closeSessionPanels()
          setWorkbench({
            active: AUTOMATION_SURFACE[latest.tool],
            automation: AUTOMATION_SURFACE[latest.tool],
            collapsed: false,
          })
        })
        persistCollapsed(false)
      },
    ),
  )

  let previousPanels = { review: false, terminal: false, files: false }
  createEffect(() => {
    const next = {
      review: reviewOpen(),
      terminal: terminalOpen(),
      files: fileTreeOpen(),
    }
    const opened = (Object.keys(next) as Array<keyof typeof next>).filter((key) => next[key])

    if (opened.length === 0) {
      if (isSessionPanelSurface(workbench.active)) setWorkbench("active", workbench.automation)
      previousPanels = next
      return
    }

    const active = isSessionPanelSurface(workbench.active) && next[workbench.active] ? workbench.active : undefined
    const newlyOpened = opened.find((key) => !previousPanels[key])
    const selected = active ?? newlyOpened ?? opened[opened.length - 1]

    if (selected === "review") closeSessionPanels("review")
    if (selected === "terminal") closeSessionPanels("terminal")
    if (selected === "files") {
      closeSessionPanels("files")
      view.reviewPanel.open()
    }
    if (workbench.active !== selected) setWorkbench("active", selected)

    previousPanels = next
  })

  const workbenchTabs = createMemo<
    Array<{
      surface: WorkbenchSurface
      label: string
      icon: Parameters<typeof Icon>[0]["name"]
      disabled?: boolean
      running?: boolean
    }>
  >(() => [
    {
      surface: "review",
      label: t("desktop.workbench.review"),
      icon: "checklist",
      disabled: !available(),
    },
    {
      surface: "terminal",
      label: t("desktop.workbench.terminal"),
      icon: "console",
      disabled: !available(),
    },
    {
      surface: "browser",
      label: t("desktop.workbench.browser"),
      icon: "window-cursor",
      running: hasRunningAutomation("browser"),
    },
    {
      surface: "computer",
      label: t("desktop.workbench.computer"),
      icon: "console",
      running: hasRunningAutomation("computer"),
    },
    {
      surface: "preview",
      label: t("desktop.workbench.preview"),
      icon: "eye",
      disabled: !available(),
    },
    {
      surface: "files",
      label: t("desktop.workbench.files"),
      icon: "folder",
      disabled: !available(),
    },
    {
      surface: "visualEditor",
      label: t("desktop.workbench.visualEditor"),
      icon: "edit",
      disabled: !available(),
    },
  ])

  return (
    <aside
      class="desktop-tools"
      classList={{
        "desktop-tools--automation": isAutomationSurface(workbench.active),
        "desktop-tools--preview": workbench.active === "preview",
        "desktop-tools--visual-editor": workbench.active === "visualEditor",
        "desktop-tools--review": reviewTabOpen(),
        "desktop-tools--terminal": terminalTabOpen(),
        "desktop-tools--files": fileTabOpen(),
        "desktop-tools--collapsed": workbench.collapsed,
        "desktop-tools--fullscreen": workbench.fullscreen,
      }}
      style={{ bottom: "0px" }}
      aria-label={t("desktop.workbench.title")}
    >
      <Show
        when={!workbench.collapsed}
        fallback={
          <button
            type="button"
            class="desktop-workbench__collapsed-trigger"
            aria-label={t("desktop.workbench.show")}
            title={t("desktop.workbench.show")}
            onClick={toggleCollapsed}
          >
            <Icon name="layout-right-full" size="normal" />
          </button>
        }
      >
        <div
          class="desktop-workbench__bar"
          role="tablist"
          aria-label={t("desktop.workbench.title")}
          onKeyDown={handleTabKeyDown}
        >
          <For each={workbenchTabs()}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                class="desktop-workbench__tab"
                classList={{
                  "desktop-workbench__tab--active": workbench.active === tab.surface,
                }}
                aria-label={tab.label}
                aria-selected={workbench.active === tab.surface}
                aria-controls={workbench.active === tab.surface ? panelControl(tab.surface) : undefined}
                title={tab.label}
                disabled={tab.disabled}
                onClick={() => openSurface(tab.surface)}
              >
                <Icon name={tab.icon} size="small" />
                <span>{tab.label}</span>
                <Show when={tab.running}>
                  <span class="desktop-workbench__running" />
                </Show>
              </button>
            )}
          </For>
          <div class="desktop-workbench__controls">
            <button
              type="button"
              aria-label={workbench.fullscreen ? t("desktop.workbench.restore") : t("desktop.workbench.expand")}
              title={workbench.fullscreen ? t("desktop.workbench.restore") : t("desktop.workbench.expand")}
              aria-pressed={workbench.fullscreen}
              onClick={toggleFullscreen}
            >
              <Icon name={workbench.fullscreen ? "collapse" : "expand"} size="small" />
            </button>
            <button
              type="button"
              aria-label={t("desktop.workbench.collapse")}
              title={t("desktop.workbench.collapse")}
              onClick={toggleCollapsed}
            >
              <Icon name="layout-right" size="small" />
            </button>
          </div>
        </div>
        <Show when={isAutomationSurface(workbench.active)}>
          <AutomationPanel surface={activeAutomation()} part={latestPart()} />
        </Show>
        <Show when={workbench.active === "preview"}>
          <PreviewPanel items={previewItems()} />
        </Show>
        <Show when={workbench.active === "visualEditor"}>
          <section id="desktop-workbench-panel-visualEditor" class="desktop-visual-editor">
            <BrowserVisualEditor />
          </section>
        </Show>
      </Show>
    </aside>
  )
}

export function DesktopBridge() {
  const sidebarMount = () => document.getElementById("desktop-sidebar-mount")
  const toolsMount = () => document.getElementById("desktop-tools-mount")

  return (
    <>
      <Show when={sidebarMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <DesktopSidebar />
          </Portal>
        )}
      </Show>
      <Show when={toolsMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <DesktopTools />
          </Portal>
        )}
      </Show>
    </>
  )
}

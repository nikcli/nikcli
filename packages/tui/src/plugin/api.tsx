import type { ParsedKey } from "@opentui/core"
import type { TuiDialogSelectOption, TuiPluginApi, TuiRouteDefinition, TuiThemeCurrent } from "@nikcli-ai/plugin/tui"
import type { useCommandDialog } from "@tui/component/dialog-command"
import type { useKeybind } from "@tui/context/keybind"
import type { useRoute } from "@tui/context/route"
import type { useSDK } from "@tui/context/sdk"
import type { useSync } from "@tui/context/sync"
import type { useSessionTabs } from "@tui/context/session-tabs"
import type { useTheme } from "@tui/context/theme"
import { Dialog as DialogUI, type useDialog } from "@tui/ui/dialog"
import type { TuiConfig } from "@nikcli-ai/sdk/httpapi"
import { createPluginKeybind } from "../context/plugin-keybinds"
import { createKeymapApi } from "./keymap"
import { hasTheme } from "../context/theme"
import type { useKV } from "../context/kv"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption as SelectOption } from "../ui/dialog-select"
import type { useToast } from "../ui/toast"
import { VERSION } from "@nikcli-ai/util/version"
import { TuiPluginRuntime } from "./runtime"
import { createV2Data } from "./data"

type RouteEntry = {
  key: symbol
  render: TuiRouteDefinition["render"]
}

export type RouteMap = Map<string, RouteEntry[]>

type Input = {
  command: ReturnType<typeof useCommandDialog>
  tuiConfig: TuiConfig
  dialog: ReturnType<typeof useDialog>
  keybind: ReturnType<typeof useKeybind>
  kv: ReturnType<typeof useKV>
  route: ReturnType<typeof useRoute>
  routes: RouteMap
  bump: () => void
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  theme: ReturnType<typeof useTheme>
  toast: ReturnType<typeof useToast>
  renderer: TuiPluginApi["renderer"]
  tabs: ReturnType<typeof useSessionTabs>
}

function routeRegister(routes: RouteMap, list: TuiRouteDefinition[], bump: () => void) {
  const key = Symbol()
  for (const item of list) {
    const prev = routes.get(item.name) ?? []
    prev.push({ key, render: item.render })
    routes.set(item.name, prev)
  }
  bump()

  return () => {
    for (const item of list) {
      const prev = routes.get(item.name)
      if (!prev) continue
      const next = prev.filter((x) => x.key !== key)
      if (!next.length) {
        routes.delete(item.name)
        continue
      }
      routes.set(item.name, next)
    }
    bump()
  }
}

function routeNavigate(
  route: ReturnType<typeof useRoute>,
  sync: ReturnType<typeof useSync>,
  name: string,
  params?: Record<string, unknown>,
) {
  if (name === "home") {
    route.navigate({ type: "home" })
    return
  }

  if (name === "session") {
    const sessionID = params?.sessionID
    if (typeof sessionID !== "string") return
    route.navigate({ type: "session", sessionID })
    return
  }

  if (name === "changes") {
    const sessionID = params?.sessionID
    if (typeof sessionID !== "string") return
    route.navigate({ type: "workspace", tab: "changes", sessionID })
    return
  }

  if (name === "tree") {
    const sessionID = params?.sessionID
    route.navigate({
      type: "workspace",
      tab: "tree",
      sessionID: typeof sessionID === "string" ? sessionID : undefined,
    })
    return
  }

  if (name === "git-graph" || name === "graph") {
    const sessionID =
      typeof params?.sessionID === "string"
        ? params.sessionID
        : route.data.type === "session"
          ? route.data.sessionID
          : undefined
    const workspaceID = sessionID
      ? (sync.session.get(sessionID)?.workspaceID ??
        (route.data.type === "session" ? route.data.workspaceID : undefined))
      : route.data.workspaceID
    route.navigate({ type: "workspace", tab: "graph", sessionID, workspaceID })
    return
  }

  if (name === "github" || name === "gh") {
    const sessionID =
      typeof params?.sessionID === "string"
        ? params.sessionID
        : route.data.type === "session"
          ? route.data.sessionID
          : undefined
    const workspaceID = sessionID
      ? (sync.session.get(sessionID)?.workspaceID ??
        (route.data.type === "session" ? route.data.workspaceID : undefined))
      : route.data.workspaceID
    route.navigate({ type: "workspace", tab: "github", sessionID, workspaceID })
    return
  }

  if (name === "actions" || name === "ci") {
    const sessionID =
      typeof params?.sessionID === "string"
        ? params.sessionID
        : route.data.type === "session"
          ? route.data.sessionID
          : undefined
    const workspaceID = sessionID
      ? (sync.session.get(sessionID)?.workspaceID ??
        (route.data.type === "session" ? route.data.workspaceID : undefined))
      : route.data.workspaceID
    route.navigate({ type: "workspace", tab: "actions", sessionID, workspaceID })
    return
  }

  route.navigate({ type: "plugin", id: name, data: params })
}

function routeCurrent(route: ReturnType<typeof useRoute>): TuiPluginApi["route"]["current"] {
  if (route.data.type === "home") return { name: "home" }
  if (route.data.type === "session") {
    return {
      name: "session",
      params: {
        sessionID: route.data.sessionID,
        initialPrompt: route.data.initialPrompt,
      },
    }
  }

  if (route.data.type === "changes") {
    return {
      name: "changes",
      params: {
        sessionID: route.data.sessionID,
      },
    }
  }

  if (route.data.type === "tree") {
    return {
      name: "tree",
      params: route.data.sessionID ? { sessionID: route.data.sessionID } : undefined,
    }
  }

  if (route.data.type === "git-graph") {
    return {
      name: "git-graph",
      params: route.data.sessionID ? { sessionID: route.data.sessionID } : undefined,
    }
  }

  if (route.data.type === "github") {
    return {
      name: "github",
      params: route.data.sessionID ? { sessionID: route.data.sessionID } : undefined,
    }
  }

  if (route.data.type === "actions") {
    return {
      name: "actions",
      params: route.data.sessionID ? { sessionID: route.data.sessionID } : undefined,
    }
  }

  if (route.data.type === "workspace") {
    return {
      name: "workspace",
      params: {
        tab: route.data.tab,
        sessionID: route.data.sessionID,
        workspaceID: route.data.workspaceID,
      },
    }
  }

  return {
    name: route.data.id,
    params: route.data.data,
  }
}

function mapOption<Value>(item: TuiDialogSelectOption<Value>): SelectOption<Value> {
  return {
    ...item,
    onSelect: () => item.onSelect?.(),
  }
}

function pickOption<Value>(item: SelectOption<Value>): TuiDialogSelectOption<Value> {
  return {
    title: item.title,
    value: item.value,
    description: item.description,
    footer: item.footer,
    category: item.category,
    disabled: item.disabled,
  }
}

function mapOptionCb<Value>(cb?: (item: TuiDialogSelectOption<Value>) => void) {
  if (!cb) return
  return (item: SelectOption<Value>) => cb(pickOption(item))
}

function stateApi(sync: ReturnType<typeof useSync>): TuiPluginApi["state"] {
  return {
    get ready() {
      return sync.ready
    },
    get config() {
      return sync.data.config
    },
    get provider() {
      return sync.data.provider
    },
    get path() {
      return sync.data.path
    },
    get vcs() {
      if (!sync.data.vcs) return
      return {
        branch: sync.data.vcs.branch,
      }
    },
    workspace: {
      list() {
        return sync.data.workspaceList
      },
      get(workspaceID) {
        return sync.workspace.get(workspaceID)
      },
    },
    session: {
      count() {
        return sync.data.session.length
      },
      diff(sessionID) {
        return sync.data.session_diff[sessionID] ?? []
      },
      todo(sessionID) {
        return sync.data.todo[sessionID] ?? []
      },
      messages(sessionID) {
        return sync.data.message[sessionID] ?? []
      },
      status(sessionID) {
        return sync.data.session_status[sessionID]
      },
      permission(sessionID) {
        return sync.data.permission[sessionID] ?? []
      },
      question(sessionID) {
        return sync.data.question[sessionID] ?? []
      },
    },
    part(messageID) {
      return sync.data.part[messageID] ?? []
    },
    lsp() {
      return sync.data.lsp.map((item) => ({ id: item.id, root: item.root, status: item.status }))
    },
    mcp() {
      return Object.entries(sync.data.mcp)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => ({
          name,
          status: item.status,
          error: item.status === "failed" ? item.error : undefined,
        }))
    },
  }
}

function appApi(): TuiPluginApi["app"] {
  return {
    get version() {
      return VERSION
    },
  }
}

export function createTuiApi(input: Input): TuiPluginApi {
  const lifecycle: TuiPluginApi["lifecycle"] = {
    signal: new AbortController().signal,
    onDispose() {
      return () => {}
    },
  }

  const command: TuiPluginApi["command"] = {
    register(cb) {
      return input.command.register(() => cb())
    },
    trigger(value) {
      input.command.trigger(value)
    },
    show() {
      input.command.show()
    },
  }
  const data = createV2Data(input)

  return {
    app: appApi(),
    command,
    keymap: createKeymapApi(command),
    route: {
      register(list) {
        return routeRegister(input.routes, list, input.bump)
      },
      navigate(name, params) {
        routeNavigate(input.route, input.sync, name, params)
      },
      get current() {
        return routeCurrent(input.route)
      },
    },
    ui: {
      Dialog(props) {
        return (
          <DialogUI size={props.size} onClose={props.onClose}>
            {props.children}
          </DialogUI>
        )
      },
      DialogAlert(props) {
        return <DialogAlert {...props} />
      },
      DialogConfirm(props) {
        return <DialogConfirm {...props} />
      },
      DialogPrompt(props) {
        return <DialogPrompt {...props} description={props.description} />
      },
      DialogSelect(props) {
        return (
          <DialogSelect
            title={props.title}
            placeholder={props.placeholder}
            options={props.options.map(mapOption)}
            onMove={mapOptionCb(props.onMove)}
            onFilter={props.onFilter}
            onSelect={mapOptionCb(props.onSelect)}
            skipFilter={props.skipFilter}
            current={props.current}
          />
        )
      },
      toast(inputToast) {
        input.toast.show({
          title: inputToast.title,
          message: inputToast.message,
          variant: inputToast.variant ?? "info",
          duration: inputToast.duration,
        })
      },
      dialog: {
        replace(render, onClose) {
          input.dialog.replace(render, onClose)
        },
        clear() {
          input.dialog.clear()
        },
        setSize(size) {
          input.dialog.setSize(size)
        },
        get size() {
          return input.dialog.size
        },
        get depth() {
          return input.dialog.stack.length
        },
        get open() {
          return input.dialog.stack.length > 0
        },
      },
      tabs: {
        enabled() {
          return true
        },
        list() {
          return input.tabs.list().map((tab) => ({
            sessionID: tab.id,
            title: tab.title,
            active: tab.active,
            busy: tab.busy,
            attention: tab.attention,
            unread: tab.unread,
          }))
        },
        open(sessionID) {
          // Navigating to a session is what creates its tab, so this covers "open" and "focus".
          input.tabs.open(sessionID)
        },
        focus(sessionID) {
          if (!input.tabs.ids().includes(sessionID)) return false
          input.tabs.open(sessionID)
          return true
        },
        close(sessionID) {
          if (!input.tabs.ids().includes(sessionID)) return false
          input.tabs.close(sessionID)
          return true
        },
      },
    },
    keybind: {
      match(key, evt: ParsedKey) {
        return input.keybind.match(key, evt)
      },
      print(key) {
        return input.keybind.print(key)
      },
      create(defaults, overrides) {
        return createPluginKeybind(input.keybind, defaults, overrides)
      },
    },
    get tuiConfig() {
      return input.tuiConfig
    },
    kv: {
      get(key, fallback) {
        return input.kv.get(key, fallback)
      },
      set(key, value) {
        input.kv.set(key, value)
      },
      get ready() {
        return input.kv.ready
      },
    },
    storage: {
      memory() {
        throw new Error("storage.memory is only available in plugin context")
      },
      store() {
        throw new Error("storage.store is only available in plugin context")
      },
    },
    state: stateApi(input.sync),
    data,
    get client() {
      return input.sdk.client
    },
    event: {
      on(type, handler) {
        return input.sdk.event.on(type, handler)
      },
      listen(handler) {
        return input.sdk.onEnvelope((event) => handler({ details: event.payload }))
      },
    },
    renderer: input.renderer,
    slots: {
      register() {
        throw new Error("slots.register is only available in plugin context")
      },
      registerDisposable() {
        throw new Error("slots.registerDisposable is only available in plugin context")
      },
    },
    plugins: {
      list() {
        return TuiPluginRuntime.list()
      },
      async activate() {
        return false
      },
      async deactivate() {
        return false
      },
      async add() {
        return false
      },
      async install() {
        return {
          ok: false,
          message: "plugins.install is only available in plugin context",
        }
      },
    },
    lifecycle,
    theme: {
      get current() {
        return input.theme.theme as unknown as TuiThemeCurrent
      },
      get selected() {
        return input.theme.selected
      },
      has(name) {
        return hasTheme(name)
      },
      set(name) {
        input.theme.set(name)
      },
      async install(_jsonPath) {
        throw new Error("theme.install is only available in plugin context")
      },
      mode() {
        return input.theme.mode()
      },
      get ready() {
        return input.theme.ready
      },
    },
  }
}

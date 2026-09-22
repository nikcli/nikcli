// @refresh reload
import { webviewZoom } from "./webview-zoom"
import { render } from "solid-js/web"
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  Platform,
  serverUrlMatchesRequest,
  useCommand,
} from "@nikcli-ai/app"
import { open, save } from "@tauri-apps/plugin-dialog"
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link"
import { open as shellOpen } from "@tauri-apps/plugin-shell"
import { type as ostype } from "@tauri-apps/plugin-os"
import { check, Update } from "@tauri-apps/plugin-updater"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { listen } from "@tauri-apps/api/event"
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification"
import { relaunch } from "@tauri-apps/plugin-process"
import { AsyncStorage } from "@solid-primitives/storage"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { Store } from "@tauri-apps/plugin-store"
import { Splash } from "@nikcli-ai/ui/logo"
import { createSignal, Show, Accessor, JSX, createResource, onMount, onCleanup } from "solid-js"

import { UPDATER_ENABLED } from "./updater"
import { initI18n, t } from "./i18n"
import pkg from "../package.json"
import "./styles.css"
import { commands, InitStep } from "./bindings"
import { Channel } from "@tauri-apps/api/core"
import { createMenu } from "./menu"
import { DesktopBridge, DesktopFrame } from "./shell"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

void initI18n()

let update: Update | null = null
const TAURI_AVAILABLE = typeof window === "object" && "__TAURI_INTERNALS__" in window
const SERVER_AUTH_STORE = "nikcli.server-auth.dat"
const SERVER_BEARER_TOKENS_KEY = "bearerTokens"
const SERVER_BEARER_TOKENS_FALLBACK_KEY = "nikcli:desktop:server-bearer-tokens"
const DESKTOP_VERSION = (import.meta.env.VITE_NIKCLI_DESKTOP_VERSION as string | undefined)?.trim() || pkg.version

type ServerBearerTokens = Record<string, string>

let serverAuthStore: Promise<Store> | undefined
let serverBearerTokens: Promise<ServerBearerTokens> | undefined

const serverKey = (url: string) => url.trim().replace(/\/+$/, "")

const validServerBearerTokens = (value: unknown): ServerBearerTokens => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim())
      .map(([url, token]) => [serverKey(url), token.trim()]),
  )
}

const loadServerBearerTokens = () => {
  if (serverBearerTokens) return serverBearerTokens
  serverBearerTokens = (async () => {
    if (!TAURI_AVAILABLE) {
      const raw = localStorage.getItem(SERVER_BEARER_TOKENS_FALLBACK_KEY)
      if (!raw) return {}
      try {
        return validServerBearerTokens(JSON.parse(raw))
      } catch {
        return {}
      }
    }

    serverAuthStore ??= Store.load(SERVER_AUTH_STORE)
    const store = await serverAuthStore
    return validServerBearerTokens(await store.get<unknown>(SERVER_BEARER_TOKENS_KEY))
  })()
  return serverBearerTokens
}

const saveServerBearerToken = async (url: string, token: string | null) => {
  const current = await loadServerBearerTokens()
  const next = { ...current }
  const key = serverKey(url)
  const value = token?.trim()
  if (value) next[key] = value
  else delete next[key]

  if (!TAURI_AVAILABLE) {
    localStorage.setItem(SERVER_BEARER_TOKENS_FALLBACK_KEY, JSON.stringify(next))
  } else {
    serverAuthStore ??= Store.load(SERVER_AUTH_STORE)
    const store = await serverAuthStore
    await store.set(SERVER_BEARER_TOKENS_KEY, next)
    await store.save()
  }
  serverBearerTokens = Promise.resolve(next)
}

const findServerBearerToken = async (input: RequestInfo | URL) => {
  const tokens = await loadServerBearerTokens()
  return (
    Object.entries(tokens)
      .filter(([url]) => serverUrlMatchesRequest(url, input))
      .sort(([a], [b]) => b.length - a.length)[0]?.[1] ?? null
  )
}

const detectedOS = (): Platform["os"] => {
  if (TAURI_AVAILABLE) {
    const value = ostype()
    if (value === "macos" || value === "windows" || value === "linux") return value
  }
  if (typeof navigator !== "object") return undefined
  const value = navigator.platform || navigator.userAgent
  if (/Mac|iPhone|iPad/i.test(value)) return "macos"
  if (/Win/i.test(value)) return "windows"
  if (/Linux/i.test(value)) return "linux"
  return undefined
}

const deepLinkEvent = "nikcli:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__NIKCLI__ ??= {}
  const pending = window.__NIKCLI__.deepLinks ?? []
  window.__NIKCLI__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = async () => {
  const startUrls = await getCurrent().catch(() => null)
  if (startUrls?.length) emitDeepLinks(startUrls)
  await Promise.all([
    onOpenUrl((urls) => emitDeepLinks(urls.filter((url) => !url.startsWith("nikcli://auth/callback")))).catch(
      () => undefined,
    ),
    listen<string>("nikcli:auth-callback", (event) => emitDeepLinks([event.payload])).catch(() => undefined),
  ])
}

const createPlatform = (password: Accessor<string | null>): Platform => ({
  platform: "desktop",
  os: detectedOS(),
  version: DESKTOP_VERSION,

  async openDirectoryPickerDialog(opts) {
    if (!TAURI_AVAILABLE) return null
    const result = await open({
      directory: true,
      multiple: opts?.multiple ?? false,
      title: opts?.title ?? t("desktop.dialog.chooseFolder"),
    })
    return result
  },

  async openFilePickerDialog(opts) {
    if (!TAURI_AVAILABLE) return null
    const result = await open({
      directory: false,
      multiple: opts?.multiple ?? false,
      title: opts?.title ?? t("desktop.dialog.chooseFile"),
    })
    return result
  },

  async saveFilePickerDialog(opts) {
    if (!TAURI_AVAILABLE) return null
    const result = await save({
      title: opts?.title ?? t("desktop.dialog.saveFile"),
      defaultPath: opts?.defaultPath,
    })
    return result
  },

  openLink(url: string) {
    if (TAURI_AVAILABLE) {
      void shellOpen(url).catch(() => undefined)
      return
    }
    window.open(url, "_blank", "noopener,noreferrer")
  },

  async openPath(path: string, app?: string) {
    if (!TAURI_AVAILABLE) return
    await commands.openPath(path, app ?? null)
  },

  back() {
    window.history.back()
  },

  forward() {
    window.history.forward()
  },

  storage: (() => {
    if (!TAURI_AVAILABLE) {
      const cache = new Map<string, AsyncStorage>()
      return (name = "default.dat") => {
        const existing = cache.get(name)
        if (existing) return existing
        const prefix = `nikcli:${name}:`
        const keys = () => Object.keys(localStorage).filter((key) => key.startsWith(prefix))
        const storage: AsyncStorage = {
          getItem: async (key) => localStorage.getItem(prefix + key),
          setItem: async (key, value) => localStorage.setItem(prefix + key, value),
          removeItem: async (key) => localStorage.removeItem(prefix + key),
          clear: async () => keys().forEach((key) => localStorage.removeItem(key)),
          key: async (index: number) => keys()[index]?.slice(prefix.length),
          getLength: async () => keys().length,
          get length() {
            return storage.getLength()
          },
        }
        cache.set(name, storage)
        return storage
      }
    }

    type StoreLike = {
      get(key: string): Promise<string | null | undefined>
      set(key: string, value: string): Promise<unknown>
      delete(key: string): Promise<unknown>
      clear(): Promise<unknown>
      keys(): Promise<string[]>
      length(): Promise<number>
    }

    const WRITE_DEBOUNCE_MS = 250

    const storeCache = new Map<string, Promise<StoreLike>>()
    const apiCache = new Map<string, AsyncStorage & { flush: () => Promise<void> }>()
    const memoryCache = new Map<string, StoreLike>()

    const flushAll = async () => {
      const apis = Array.from(apiCache.values())
      await Promise.all(apis.map((api) => api.flush().catch(() => undefined)))
    }

    if ("addEventListener" in globalThis) {
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        void flushAll()
      }

      window.addEventListener("pagehide", () => void flushAll())
      document.addEventListener("visibilitychange", handleVisibility)
    }

    const createMemoryStore = () => {
      const data = new Map<string, string>()
      const store: StoreLike = {
        get: async (key) => data.get(key),
        set: async (key, value) => {
          data.set(key, value)
        },
        delete: async (key) => {
          data.delete(key)
        },
        clear: async () => {
          data.clear()
        },
        keys: async () => Array.from(data.keys()),
        length: async () => data.size,
      }
      return store
    }

    const getStore = (name: string) => {
      const cached = storeCache.get(name)
      if (cached) return cached

      const store = Store.load(name).catch(() => {
        const cached = memoryCache.get(name)
        if (cached) return cached

        const memory = createMemoryStore()
        memoryCache.set(name, memory)
        return memory
      })

      storeCache.set(name, store)
      return store
    }

    const createStorage = (name: string) => {
      const pending = new Map<string, string | null>()
      let timer: ReturnType<typeof setTimeout> | undefined
      let flushing: Promise<void> | undefined

      const flush = async () => {
        if (flushing) return flushing

        flushing = (async () => {
          const store = await getStore(name)
          while (pending.size > 0) {
            const batch = Array.from(pending.entries())
            pending.clear()
            for (const [key, value] of batch) {
              if (value === null) {
                await store.delete(key).catch(() => undefined)
              } else {
                await store.set(key, value).catch(() => undefined)
              }
            }
          }
        })().finally(() => {
          flushing = undefined
        })

        return flushing
      }

      const schedule = () => {
        if (timer) return
        timer = setTimeout(() => {
          timer = undefined
          void flush()
        }, WRITE_DEBOUNCE_MS)
      }

      const api: AsyncStorage & { flush: () => Promise<void> } = {
        flush,
        getItem: async (key: string) => {
          const next = pending.get(key)
          if (next !== undefined) return next

          const store = await getStore(name)
          const value = await store.get(key).catch(() => null)
          if (value === undefined) return null
          return value
        },
        setItem: async (key: string, value: string) => {
          pending.set(key, value)
          schedule()
        },
        removeItem: async (key: string) => {
          pending.set(key, null)
          schedule()
        },
        clear: async () => {
          pending.clear()
          const store = await getStore(name)
          await store.clear().catch(() => undefined)
        },
        key: async (index: number) => {
          const store = await getStore(name)
          return (await store.keys().catch(() => []))[index]
        },
        getLength: async () => {
          const store = await getStore(name)
          return await store.length().catch(() => 0)
        },
        get length() {
          return api.getLength()
        },
      }

      return api
    }

    return (name = "default.dat") => {
      const cached = apiCache.get(name)
      if (cached) return cached

      const api = createStorage(name)
      apiCache.set(name, api)
      return api
    }
  })(),

  checkUpdate: async () => {
    if (!TAURI_AVAILABLE || !UPDATER_ENABLED) return { updateAvailable: false }
    const next = await check().catch(() => null)
    if (!next) return { updateAvailable: false }
    const ok = await next
      .download()
      .then(() => true)
      .catch(() => false)
    if (!ok) return { updateAvailable: false }
    update = next
    return { updateAvailable: true, version: next.version }
  },

  update: async () => {
    if (!TAURI_AVAILABLE || !UPDATER_ENABLED || !update) return
    if (ostype() === "windows") await commands.killSidecar().catch(() => undefined)
    await update.install().catch(() => undefined)
  },

  restart: async () => {
    if (!TAURI_AVAILABLE) {
      window.location.reload()
      return
    }
    await commands.killSidecar().catch(() => undefined)
    await relaunch()
  },

  notify: async (title, description, href) => {
    const granted = TAURI_AVAILABLE
      ? await isPermissionGranted().catch(() => false)
      : typeof Notification === "function" && Notification.permission === "granted"
    const permission = granted
      ? "granted"
      : TAURI_AVAILABLE
        ? await requestPermission().catch(() => "denied")
        : typeof Notification === "function"
          ? await Notification.requestPermission().catch(() => "denied")
          : "denied"
    if (permission !== "granted") return

    const focused = TAURI_AVAILABLE
      ? await getCurrentWindow()
          .isFocused()
          .catch(() => document.hasFocus())
      : document.hasFocus()
    if (focused) return

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
          icon: "https://nikcli-ai.dev/favicon-96x96-v3.png",
        })
        notification.onclick = () => {
          if (TAURI_AVAILABLE) {
            const win = getCurrentWindow()
            void win.show().catch(() => undefined)
            void win.unminimize().catch(() => undefined)
            void win.setFocus().catch(() => undefined)
          } else {
            window.focus()
          }
          if (href) {
            window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
          notification.close()
        }
      })
      .catch(() => undefined)
  },

  fetch: (async (input, init) => {
    const pw = password()
    const bearer = await findServerBearerToken(input).catch(() => null)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    if (!headers.has("Authorization")) {
      if (bearer) headers.set("Authorization", `Bearer ${bearer}`)
      else if (pw) headers.set("Authorization", `Basic ${btoa(`nikcli:${pw}`)}`)
    }

    if (input instanceof Request) {
      const request = new Request(input, { ...init, headers })
      return TAURI_AVAILABLE ? tauriFetch(request) : globalThis.fetch(request)
    }

    const request = { ...(init as RequestInit), headers }
    return TAURI_AVAILABLE ? tauriFetch(input, request) : globalThis.fetch(input, request)
  }) as typeof fetch,

  externalFetch: (async (input, init) => {
    if (input instanceof Request) {
      const request = new Request(input, init)
      return TAURI_AVAILABLE ? tauriFetch(request) : globalThis.fetch(request)
    }
    return TAURI_AVAILABLE ? tauriFetch(input, init as RequestInit | undefined) : globalThis.fetch(input, init)
  }) as typeof fetch,

  getDefaultServerUrl: async () => {
    if (!TAURI_AVAILABLE) return localStorage.getItem("nikcli:desktop:server-url")
    const result = await commands.getDefaultServerUrl().catch(() => null)
    return result
  },

  setDefaultServerUrl: async (url: string | null) => {
    if (!TAURI_AVAILABLE) {
      if (url) localStorage.setItem("nikcli:desktop:server-url", url)
      else localStorage.removeItem("nikcli:desktop:server-url")
      return
    }
    await commands.setDefaultServerUrl(url)
  },

  getServerBearerToken: async (url: string) => {
    const tokens = await loadServerBearerTokens()
    return tokens[serverKey(url)] ?? null
  },

  setServerBearerToken: (url: string, token: string | null) => saveServerBearerToken(url, token),

  parseMarkdown: TAURI_AVAILABLE ? (markdown: string) => commands.parseMarkdownCommand(markdown) : undefined,

  webviewZoom,

  checkAppExists: async (appName: string) => {
    if (!TAURI_AVAILABLE) return false
    return commands.checkAppExists(appName)
  },
})

let menuTrigger = null as null | ((id: string) => void)
if (TAURI_AVAILABLE) {
  void createMenu((id) => {
    menuTrigger?.(id)
  })
  void listenForDeepLinks()
}

render(() => {
  const [serverPassword, setServerPassword] = createSignal<string | null>(null)
  const platform = createPlatform(() => serverPassword())

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <ServerGate>
          {(data) => {
            setServerPassword(data().password)
            window.__NIKCLI__ ??= {}
            window.__NIKCLI__.serverPassword = data().password ?? undefined

            function Inner() {
              const cmd = useCommand()

              menuTrigger = (id) => cmd.trigger(id)

              return null
            }

            return (
              <DesktopFrame>
                <AppInterface defaultUrl={data().url}>
                  <Inner />
                  <DesktopBridge />
                </AppInterface>
              </DesktopFrame>
            )
          }}
        </ServerGate>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)

type ServerReadyData = { url: string; password: string | null }

// Gate component that waits for the server to be ready
function ServerGate(props: { children: (data: Accessor<ServerReadyData>) => JSX.Element }) {
  if (!TAURI_AVAILABLE) {
    const url =
      localStorage.getItem("nikcli:desktop:server-url") ??
      import.meta.env.VITE_NIKCLI_SERVER_URL ??
      "http://127.0.0.1:4096"
    return props.children(() => ({ url, password: null }))
  }

  const [serverData] = createResource(() => commands.awaitInitialization(new Channel<InitStep>() as any))

  if (serverData.state === "errored") throw serverData.error

  return (
    // Not using suspense as not all components are compatible with it (undefined refs)
    <Show
      when={serverData.state !== "pending" && serverData()}
      fallback={
        <div class="h-screen w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
          <div data-tauri-decorum-tb class="flex flex-row absolute top-0 right-0 z-10 h-10" />
        </div>
      }
    >
      {(data) => props.children(data)}
    </Show>
  )
}

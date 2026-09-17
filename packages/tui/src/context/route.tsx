import { createContext, type ParentProps, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptInfo } from "../component/prompt/history"

export type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
  workspaceID?: string
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
  workspaceID?: string
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
  workspaceID?: string
}

export type ChangesRoute = {
  type: "changes"
  sessionID: string
  workspaceID?: string
}

export type SessionTreeRoute = {
  type: "tree"
  sessionID?: string
  workspaceID?: string
}

export type GitGraphRoute = {
  type: "git-graph"
  sessionID?: string
  workspaceID?: string
}

export type GitHubRoute = {
  type: "github"
  sessionID?: string
  workspaceID?: string
}

export type WorkspaceRoute = {
  type: "workspace"
  tab?: "tree" | "changes" | "graph" | "github"
  sessionID?: string
  workspaceID?: string
}

export type Route =
  | HomeRoute
  | SessionRoute
  | PluginRoute
  | ChangesRoute
  | SessionTreeRoute
  | GitGraphRoute
  | GitHubRoute
  | WorkspaceRoute

export type RouteContext = {
  readonly data: Route
  navigate(route: Route): void
}

const RouteCtx = createContext<RouteContext>()

export function RouteProvider(props: ParentProps) {
  const [store, setStore] = createStore<Route>(
    (() => {
      const raw = process.env["NIKCLI_ROUTE"]
      if (raw) {
        try {
          return JSON.parse(raw) as Route
        } catch (err) {
          console.warn("[route] Failed to parse NIKCLI_ROUTE, falling back to home:", err)
          return { type: "home" } as Route
        }
      }
      return { type: "home" } as Route
    })(),
  )

  const value: RouteContext = {
    get data() {
      return store
    },
    navigate(route: Route) {
      setStore(route)
    },
  }

  return <RouteCtx.Provider value={value}>{props.children}</RouteCtx.Provider>
}

/**
 * Provide an alternate route value to descendants. Used by composite views
 * (e.g. the unified workspace panel) that mount child route components which
 * each expect their own `useRouteData("…")` to resolve.
 */
export function RouteOverrideProvider(props: ParentProps<{ value: RouteContext }>) {
  return <RouteCtx.Provider value={props.value}>{props.children}</RouteCtx.Provider>
}

export function useRoute(): RouteContext {
  const value = useContext(RouteCtx)
  if (!value) throw new Error("Route context must be used within RouteProvider")
  return value
}

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}

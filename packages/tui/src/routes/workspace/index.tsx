import { createEffect, createMemo, createResource, createSignal, Match, on, Switch } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useKeybind } from "@tui/context/keybind"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import {
  RouteOverrideProvider,
  useRoute,
  useRouteData,
  type ActionsRoute,
  type ChangesRoute,
  type GitHubRoute,
  type RouteContext,
  type SessionTreeRoute,
} from "@tui/context/route"
import { ActionsPanel } from "@tui/routes/actions"
import { loadLatestRun, runTone } from "@tui/routes/actions/ci"
import { Changes } from "@tui/routes/changes"
import { GitGraph } from "@tui/routes/git-graph"
import { GitHubPanel } from "@tui/routes/github"
import { SessionTree } from "@tui/routes/tree"
import type { GitGraphRoute } from "@tui/context/route"
import { RepoStrip, WorkspaceTabBar, WORKSPACE_TABS, type WorkspaceTab } from "./chrome"
import { openRepoActions } from "./repo-actions-menu"
import { dirtyCount, loadRepoStatus } from "./repo-status"
import { WorkspaceShellProvider, type WorkspaceShell } from "./shell"

export function Workspace() {
  const routeData = useRouteData("workspace")
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const keybind = useKeybind()
  const { theme } = useTheme()

  const activeTab = createMemo<WorkspaceTab>(() => routeData.tab ?? "tree")
  const directory = createMemo(() => sync.data.path.directory || sdk.directory || process.cwd())

  const [captured, setCaptured] = createSignal(false)
  const [status, { refetch: refetchStatus }] = createResource(directory, loadRepoStatus)

  /**
   * The CI chip is a second, slower signal than the git status: it costs a
   * GitHub API round trip through `gh`, so it only loads for a GitHub remote
   * on a real branch, and it never blocks the strip.
   */
  const ciQuery = createMemo(() => {
    const current = status()
    if (!current || current.error || !current.slug) return undefined
    if (!current.branch || current.detached) return undefined
    return { directory: current.directory, branch: current.branch }
  })
  const [latestRun, { refetch: refetchRun }] = createResource(ciQuery, (input) =>
    loadLatestRun(input.directory, input.branch),
  )

  // Switching tabs is the cheapest honest moment to re-read the working tree:
  // the user has just been somewhere else, possibly committing. The CI chip is
  // deliberately left out — that one costs an API call.
  createEffect(on(activeTab, () => void refetchStatus(), { defer: true }))

  function refresh() {
    void refetchStatus()
    void refetchRun()
  }

  function setTab(tab: WorkspaceTab) {
    route.navigate({
      type: "workspace",
      tab,
      sessionID: routeData.sessionID,
      workspaceID: routeData.workspaceID,
    })
  }

  function openActions() {
    openRepoActions({
      dialog,
      toast,
      theme,
      directory,
      status,
      refresh,
    })
  }

  const shell: WorkspaceShell = {
    status,
    loading: () => status.loading,
    refresh,
    captured,
    setCaptured,
    openActions,
  }

  useKeyboard((evt) => {
    // The shell registers before its panels, so it sees every key first. Stand
    // down for anything a panel, a dialog or a leader chord already owns.
    if (evt.defaultPrevented || dialog.stack.length > 0 || keybind.leader || captured()) return
    if (evt.ctrl || evt.meta || evt.super) return

    if (evt.name === "tab" || evt.name === "shift+tab") {
      evt.preventDefault()
      const index = WORKSPACE_TABS.findIndex((tab) => tab.id === activeTab())
      const delta = evt.shift || evt.name === "shift+tab" ? -1 : 1
      setTab(WORKSPACE_TABS[(index + delta + WORKSPACE_TABS.length) % WORKSPACE_TABS.length].id)
      return
    }
    if (evt.name === ".") {
      evt.preventDefault()
      openActions()
      return
    }
    for (const tab of WORKSPACE_TABS) {
      if (evt.name === tab.key) {
        evt.preventDefault()
        setTab(tab.id)
        return
      }
    }
  })

  return (
    <WorkspaceShellProvider value={shell}>
      <box flexGrow={1} flexDirection="column">
        <WorkspaceTabBar
          theme={theme}
          active={activeTab()}
          onSelect={setTab}
          dirty={() => (status() ? dirtyCount(status()!.dirty) : 0)}
          ciTone={() => (latestRun() ? runTone(latestRun()!) : undefined)}
        />
        <RepoStrip theme={theme} status={status()} loading={status.loading} run={latestRun()} onActions={openActions} />
        <box flexGrow={1} minHeight={0}>
          <Switch>
            <Match when={activeTab() === "tree"}>
              <SubRoute
                data={{ type: "tree", sessionID: routeData.sessionID, workspaceID: routeData.workspaceID }}
                outerRoute={route}
              >
                <SessionTree />
              </SubRoute>
            </Match>
            <Match when={activeTab() === "changes"}>
              <SubRoute
                data={{
                  type: "changes",
                  sessionID: routeData.sessionID ?? "",
                  workspaceID: routeData.workspaceID,
                }}
                outerRoute={route}
              >
                <box flexGrow={1} flexDirection="column">
                  <Changes />
                </box>
              </SubRoute>
            </Match>
            <Match when={activeTab() === "graph"}>
              <SubRoute
                data={{ type: "git-graph", sessionID: routeData.sessionID, workspaceID: routeData.workspaceID }}
                outerRoute={route}
              >
                <GitGraph />
              </SubRoute>
            </Match>
            <Match when={activeTab() === "github"}>
              <SubRoute
                data={{ type: "github", sessionID: routeData.sessionID, workspaceID: routeData.workspaceID }}
                outerRoute={route}
              >
                <GitHubPanel />
              </SubRoute>
            </Match>
            <Match when={activeTab() === "actions"}>
              <SubRoute
                data={{ type: "actions", sessionID: routeData.sessionID, workspaceID: routeData.workspaceID }}
                outerRoute={route}
              >
                <ActionsPanel />
              </SubRoute>
            </Match>
          </Switch>
        </box>
      </box>
    </WorkspaceShellProvider>
  )
}

function SubRoute(props: {
  data: ChangesRoute | SessionTreeRoute | GitHubRoute | GitGraphRoute | ActionsRoute
  outerRoute: RouteContext
  children: any
}) {
  // Inner route value: data reflects the active tab; navigate falls back to the
  // outer workspace route so child components that call `route.navigate(...)`
  // still escape cleanly (e.g. back-to-session from <Changes />).
  const value: RouteContext = {
    get data() {
      return props.data
    },
    navigate(next) {
      props.outerRoute.navigate(next)
    },
  }
  return <RouteOverrideProvider value={value}>{props.children}</RouteOverrideProvider>
}

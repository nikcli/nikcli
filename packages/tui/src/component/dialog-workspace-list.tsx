import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createResource, createSignal, onMount } from "solid-js"
import type { Session, Workspace } from "@nikcli-ai/sdk/httpapi"
import { createNikcliClient } from "@nikcli-ai/sdk/httpapi"
import { Keybind } from "@tui/util/keybind"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useKeybind } from "../context/keybind"
import { DialogSessionList } from "./dialog-session-list"
import { useTheme } from "../context/theme"
import { DialogWorkspaceCreate, DialogWorkspaceScope, workspaceScopeDirectory } from "./dialog-workspace-create"
import type { WorkspaceScope } from "./dialog-workspace-create"
import { useProject } from "../context/project"

export { DialogWorkspaceCreate } from "./dialog-workspace-create"

export async function openWorkspace(input: {
  dialog: ReturnType<typeof useDialog>
  route: ReturnType<typeof useRoute>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
  workspaceID: string
  forceCreate?: boolean
  /** Instance the workspace is owned by; defaults to the current directory. */
  directory?: string
}) {
  const cacheSession = (session: Session) => {
    input.sync.set(
      "session",
      [...input.sync.data.session.filter((item) => item.id !== session.id), session].toSorted((a, b) =>
        a.id.localeCompare(b.id),
      ),
    )
  }

  const directory = input.directory || input.sync.data.path.directory || input.sdk.directory
  function scoped(workspaceID?: string) {
    return createNikcliClient({
      baseUrl: input.sdk.url,
      fetch: input.sdk.fetch,
      directory,
      workspace: workspaceID,
    })
  }
  const client = scoped(input.workspaceID)
  const restored = await scoped()
    .experimental.workspace.restore({ id: input.workspaceID })
    .catch(() => undefined)
  if (!restored?.data) {
    input.toast.show({
      message: "Failed to connect workspace",
      variant: "error",
    })
    return
  }

  const sessionID = input.forceCreate ? undefined : restored.data.sessions?.[0]
  if (sessionID) {
    const session = await input.sync.session.sync(sessionID, { full: true }).catch(() => undefined)
    if (session) cacheSession(session)
    input.route.navigate({
      type: "session",
      sessionID,
      workspaceID: session?.workspaceID ?? input.workspaceID,
    })
    input.dialog.clear()
    return
  }

  let created: Session | undefined
  while (!created) {
    const result = await client.session.create({ workspaceID: input.workspaceID }).catch(() => undefined)
    if (!result) {
      input.toast.show({
        message: "Failed to open workspace",
        variant: "error",
      })
      return
    }
    const status = result.response?.status
    if (status !== undefined && status >= 500 && status < 600) {
      await Bun.sleep(1000)
      continue
    }
    if (!result.data) {
      input.toast.show({
        message: "Failed to open workspace",
        variant: "error",
      })
      return
    }
    created = result.data
  }

  cacheSession(created)
  input.route.navigate({
    type: "session",
    sessionID: created.id,
    workspaceID: created.workspaceID ?? input.workspaceID,
  })
  input.dialog.clear()
}

export function DialogWorkspaceList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const project = useProject()

  function scoped(workspaceID?: string) {
    return createNikcliClient({
      baseUrl: sdk.url,
      fetch: sdk.fetch,
      directory: ownerDirectory(),
      workspace: workspaceID,
    })
  }
  const [toDelete, setToDelete] = createSignal<string>()
  const [removing, setRemoving] = createSignal<string>()
  const [counts, setCounts] = createSignal<Record<string, number | null | undefined>>({})
  const [scope, setScope] = createSignal<WorkspaceScope>("project")

  const currentDirectory = () => sync.data.path.directory || sdk.directory || process.cwd()
  const ownerDirectory = createMemo(() => workspaceScopeDirectory(currentDirectory(), scope()))

  /**
   * `keybind.all` is typed from the generated `KeybindsConfig`, which only
   * catches up with the config schema when the SDK is rebuilt — so read the
   * configured binding off the raw config and fall back to the schema default.
   */
  const scopeKeybind = createMemo(() => {
    const keybinds = sync.data.config.keybinds as Record<string, string | undefined> | undefined
    return Keybind.parse(keybinds?.["session_scope_toggle"] || "ctrl+g")[0]
  })

  // Workspaces are owned by a project, so the global ones are simply the ones
  // an instance bound outside any repo sees.
  const [globalWorkspaces, { refetch: refetchGlobal }] = createResource(
    () => (scope() === "global" ? ownerDirectory() : undefined),
    async (directory) => {
      const client = createNikcliClient({ baseUrl: sdk.url, fetch: sdk.fetch, directory })
      const result = await client.experimental.workspace.list().catch(() => undefined)
      if (!result) {
        toast.show({ message: "Failed to load global environments", variant: "error" })
        return [] as Workspace[]
      }
      return (result.data ?? []) as Workspace[]
    },
  )

  const workspaces = createMemo(() =>
    scope() === "global" ? (globalWorkspaces() ?? []) : (sync.data.workspaceList as Workspace[]),
  )

  async function syncWorkspaces() {
    await sdk.client.experimental.workspace.syncList().catch(() => undefined)
    await Promise.all([sync.workspace.sync(), project.workspace.sync()])
  }

  const open = (workspaceID: string, forceCreate?: boolean, directory?: string) =>
    openWorkspace({
      dialog,
      route,
      sdk,
      sync,
      toast,
      workspaceID,
      forceCreate,
      directory: directory ?? ownerDirectory(),
    })

  function openCreate() {
    dialog.replace(() => (
      <DialogWorkspaceScope
        currentDirectory={currentDirectory()}
        current={scope()}
        onSelect={(next) =>
          dialog.replace(() => (
            <DialogWorkspaceCreate
              scope={next}
              onSelect={(workspaceID) => open(workspaceID, true, workspaceScopeDirectory(currentDirectory(), next))}
            />
          ))
        }
      />
    ))
  }

  async function selectWorkspace(workspaceID: string) {
    if (workspaceID === "__local__") {
      // Back to the root checkout: drop the workspace scope and re-fetch
      // path/vcs/sessions from the local instance (opencode parity).
      if (project.workspace.current() !== undefined) {
        project.workspace.set(undefined)
        void sync.bootstrap().catch(() => undefined)
      }
      if (localCount() > 0) {
        dialog.replace(() => <DialogSessionList localOnly={true} />)
        return
      }
      route.navigate({
        type: "home",
      })
      dialog.clear()
      return
    }

    const count = counts()[workspaceID]
    if (count && count > 0) {
      dialog.replace(() => <DialogSessionList workspaceID={workspaceID} directory={ownerDirectory()} />)
      return
    }

    if (count === 0) {
      await open(workspaceID)
      return
    }

    const client = scoped(workspaceID)
    const listed = await client.session.list({ roots: true, limit: 1 }).catch(() => undefined)
    if (listed?.data?.length) {
      dialog.replace(() => <DialogSessionList workspaceID={workspaceID} directory={ownerDirectory()} />)
      return
    }
    await open(workspaceID)
  }

  const currentWorkspaceID = createMemo(() => {
    if (route.data.type === "session") {
      return route.data.workspaceID ?? sync.session.get(route.data.sessionID)?.workspaceID ?? "__local__"
    }
    return route.data.workspaceID ?? "__local__"
  })

  const localCount = createMemo(
    () => sync.data.session.filter((session) => !session.workspaceID && !session.parentID).length,
  )

  let run = 0
  createEffect(() => {
    const list = workspaces()
    const directory = ownerDirectory()
    const next = ++run
    if (!list.length) {
      setCounts({})
      return
    }

    setCounts(Object.fromEntries(list.map((workspace) => [workspace.id, undefined])))
    void Promise.all(
      list.map(async (workspace) => {
        const client = createNikcliClient({
          baseUrl: sdk.url,
          fetch: sdk.fetch,
          directory,
          workspace: workspace.id,
        })
        const result = await client.session.list({ roots: true }).catch(() => undefined)
        return [workspace.id, result ? (result.data?.length ?? 0) : null] as const
      }),
    ).then((entries) => {
      if (run !== next) return
      setCounts(Object.fromEntries(entries))
    })
  })

  const options = createMemo(() => [
    // The main checkout is this project's own directory, so it has no meaning
    // while the list shows what the global project owns.
    ...(scope() === "project"
      ? [
          {
            title: "Main checkout",
            value: "__local__",
            category: "Project",
            description: "Use the canonical project directory",
            footer: `${localCount()} session${localCount() === 1 ? "" : "s"}`,
          },
        ]
      : []),
    ...workspaces()
      .toSorted((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .map((workspace) => {
        const count = counts()[workspace.id]
        const label = workspace.name || workspace.id
        const status = project.workspace.status(workspace.id)
        return {
          title:
            removing() === workspace.id
              ? "Deleting..."
              : toDelete() === workspace.id
                ? `Delete ${label}? Press ${keybind.print("session_delete")} again`
                : label,
          value: workspace.id,
          category: workspace.config.type === "worktree" ? "Project copy" : "Remote workspace",
          description: workspace.branch
            ? `Branch ${workspace.branch}`
            : workspace.config.type === "worktree"
              ? "Detached"
              : undefined,
          gutter: (
            <text
              fg={
                status === "connected"
                  ? theme.status.success.fg
                  : status === "error"
                    ? theme.status.error.fg
                    : theme.foreground.muted
              }
            >
              ●
            </text>
          ),
          footer:
            count === undefined
              ? "Loading sessions..."
              : count === null
                ? "Sessions unavailable"
                : `${count} session${count === 1 ? "" : "s"}`,
        }
      }),
    {
      title: "+ New environment",
      value: "__create__",
      category: "Actions",
      description: "Create a local project copy or remote workspace",
    },
  ])

  onMount(() => {
    dialog.setSize("large")
    void syncWorkspaces()
  })

  return (
    <DialogSelect
      title={scope() === "global" ? "Workspaces · Global" : "Workspaces · Project"}
      skipFilter={true}
      options={options()}
      current={currentWorkspaceID()}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        setToDelete(undefined)
        if (option.value === "__create__") {
          openCreate()
          return
        }
        void selectWorkspace(option.value)
      }}
      keybind={[
        {
          keybind: scopeKeybind(),
          title: scope() === "global" ? "project scope" : "global scope",
          // Fires with nothing selected on purpose: a scope with no
          // environments must still be switchable back.
          allowEmpty: true,
          onTrigger: () => {
            setToDelete(undefined)
            setScope((current) => (current === "global" ? "project" : "global"))
          },
        },
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (option.value === "__create__" || option.value === "__local__") return
            if (removing()) return
            if (toDelete() !== option.value) {
              setToDelete(option.value)
              return
            }
            setRemoving(option.value)
            // Removal has to go through the instance that owns the workspace,
            // which for the global scope is not this project's.
            const result = await scoped()
              .experimental.workspace.remove({ id: option.value })
              .catch(() => undefined)
            setToDelete(undefined)
            if (result?.error) {
              setRemoving(undefined)
              toast.show({
                message: "Failed to delete workspace",
                variant: "error",
              })
              return
            }
            if (currentWorkspaceID() === option.value) {
              project.workspace.set(undefined)
              route.navigate({
                type: "home",
              })
            }
            if (scope() === "global") {
              refetchGlobal()
            } else {
              await syncWorkspaces()
              await sync.bootstrap().catch(() => undefined)
            }
            setRemoving(undefined)
          },
        },
      ]}
    />
  )
}

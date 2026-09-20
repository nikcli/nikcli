import { createMemo, createSignal, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useKeybind } from "../context/keybind"
import { Identifier } from "@nikcli-ai/util/id"
import { DialogWorkspaceCreate } from "./dialog-workspace-create"
import { DialogWorkspaceFileChanges } from "./dialog-workspace-file-changes"

function moveReminderText(directory: string) {
  return `<system-reminder>The user has changed the current working directory to "${directory}". This is still the same project but at a possibly new location; take this into account when working with any files from now on.</system-reminder>`
}

/**
 * Move the current session to another workspace, or detach it back to the local project.
 */
export function DialogSessionWarp(props: { sessionID: string }) {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const keybind = useKeybind()
  const [pending, setPending] = createSignal(false)
  const [toDelete, setToDelete] = createSignal<string>()

  const currentWorkspaceID = createMemo(() => {
    const session = sync.session.get(props.sessionID)
    return session?.workspaceID
  })

  // The location the session currently lives in, mapped to an option value.
  const currentValue = createMemo(() => currentWorkspaceID() ?? "__local__")

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    // Keep the most recently used workspaces first, matching upstream discovery behavior.
    const workspaces = [...(sync.data.workspaceList ?? [])].sort(
      (a, b) => b.timeUsed - a.timeUsed || (a.name || a.id).localeCompare(b.name || b.id),
    )
    const current = currentValue()
    const items: DialogSelectOption<string>[] = []

    items.push({
      title: "Main checkout",
      value: "__local__",
      description: current === "__local__" ? "Current location" : undefined,
    })

    for (const ws of workspaces) {
      const label = ws.name || ws.id
      items.push({
        title: toDelete() === ws.id ? `Delete ${label}? Press ${keybind.print("session_delete")} again` : label,
        value: ws.id,
        description:
          ws.id === current
            ? "Current location"
            : ws.config.type === "worktree"
              ? ws.branch
                ? `Project copy · Branch ${ws.branch}`
                : "Project copy · Detached"
              : "Remote workspace",
      })
    }

    items.push({
      title: "+ New environment",
      value: "__create__",
      description: "Create a project copy or remote workspace and move this session",
    })

    return items
  })

  async function deleteWorkspace(id: string) {
    if (id === "__local__" || id === "__create__") return
    if (id === currentWorkspaceID()) {
      toast.show({
        message: "Cannot delete the workspace this session lives in",
        variant: "error",
      })
      return
    }
    if (toDelete() !== id) {
      setToDelete(id)
      return
    }
    const result = await sdk.client.experimental.workspace.remove({ id }).catch(() => undefined)
    setToDelete(undefined)
    if (result?.error) {
      toast.show({ message: "Failed to delete workspace", variant: "error" })
      return
    }
    await sync.workspace.sync()
  }

  async function confirmCopyChanges() {
    const sourceWorkspaceID = currentWorkspaceID()
    if (!sourceWorkspaceID) return false

    const status = await sdk.client.vcs.status({ workspace: sourceWorkspaceID }).catch(() => undefined)
    const files = status?.data ?? []
    if (files.length === 0) return false

    const choice = await DialogWorkspaceFileChanges.show(dialog, files)
    if (!choice) return undefined
    return choice === "yes"
  }

  async function warp(target: string, copyChanges: boolean) {
    if (pending()) return
    setPending(true)
    const workspaceID = target === "__local__" ? null : target
    try {
      const result = await sdk.client.experimental.workspace.warp({
        id: workspaceID,
        sessionID: props.sessionID,
        copyChanges,
      })
      if (result.error) {
        toast.show({ message: "Failed to warp session", variant: "error" })
        return
      }
      const refreshed = await sdk.client.session.get({ sessionID: props.sessionID }).catch(() => undefined)
      if (refreshed?.data) {
        sync.set(
          "session",
          [...sync.data.session.filter((item) => item.id !== refreshed.data!.id), refreshed.data].toSorted((a, b) =>
            a.id.localeCompare(b.id),
          ),
        )
      }
      // Tell the model the working directory changed so it resolves files at the new location.
      const newDirectory = refreshed?.data?.directory
      if (newDirectory) {
        await sdk.client.session
          .promptAsync({
            sessionID: props.sessionID,
            noReply: true,
            ...(workspaceID ? { workspace: workspaceID } : {}),
            directory: newDirectory,
            parts: [
              {
                id: Identifier.ascending("part"),
                type: "text",
                text: moveReminderText(newDirectory),
                synthetic: true,
              },
            ],
          })
          .catch(() => undefined)
      }
      toast.show({
        message: workspaceID ? "Moved to selected environment" : "Moved to main checkout",
        variant: "info",
      })
      route.navigate({
        type: "session",
        sessionID: props.sessionID,
        workspaceID: workspaceID ?? undefined,
      })
      dialog.clear()
    } catch (error) {
      toast.show({
        message: error instanceof Error ? error.message : "Failed to warp session",
        variant: "error",
      })
    } finally {
      setPending(false)
    }
  }

  onMount(() => {
    void (async () => {
      await sdk.client.experimental.workspace.syncList().catch(() => undefined)
      await sync.workspace.sync()
    })()
  })

  return (
    <DialogSelect
      title={pending() ? "Warping..." : "Move session to"}
      options={options()}
      current={currentValue()}
      onMove={() => setToDelete(undefined)}
      onSelect={(option) => {
        if (pending()) return
        setToDelete(undefined)
        if (option.value === "__create__") {
          dialog.replace(() => (
            <DialogWorkspaceCreate
              onSelect={async (workspaceID) => {
                await sync.workspace.sync()
                const copyChanges = await confirmCopyChanges()
                if (copyChanges === undefined) return
                await warp(workspaceID, copyChanges)
              }}
            />
          ))
          return
        }
        // Selecting the location the session is already in is a no-op.
        if (option.value === currentValue()) {
          dialog.clear()
          return
        }
        void (async () => {
          const copyChanges = await confirmCopyChanges()
          if (copyChanges === undefined) return
          await warp(option.value, copyChanges)
        })()
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          disabled: pending(),
          onTrigger: (option) => void deleteWorkspace(option.value),
        },
      ]}
    />
  )
}

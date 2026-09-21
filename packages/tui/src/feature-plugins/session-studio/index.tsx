import type { TuiPlugin, TuiPluginModule } from "@nikcli-ai/plugin/tui"

const tui: TuiPlugin = async (api) => {
  let disposed = false
  let generation = 0
  let opened = false
  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: "session-studio.open",
        title: "Session studio",
        namespace: "Appearance",
        description: "Preview and customize session presentation",
        slashName: "studio",
        run() {
          if (disposed) return
          const request = ++generation
          const route = api.route.current
          const sessionID =
            route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
          void import("./dialog")
            .then(({ SessionStudioDialog }) => {
              if (disposed || api.lifecycle.signal.aborted || request !== generation) return
              api.ui.dialog.replace(
                () => <SessionStudioDialog sessionID={sessionID} />,
                () => {
                  opened = false
                },
              )
              opened = true
            })
            .catch((error: unknown) => {
              if (disposed || request !== generation) return
              api.ui.toast({
                variant: "error",
                message: error instanceof Error ? error.message : "Could not open session studio",
              })
            })
        },
      },
    ],
  })
  api.lifecycle.onDispose(() => {
    disposed = true
    generation++
    unregister()
    if (opened) api.ui.dialog.clear()
  })
}

export default {
  id: "internal:session-studio",
  tui,
} satisfies TuiPluginModule & { id: string }

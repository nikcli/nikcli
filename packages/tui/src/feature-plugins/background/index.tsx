/**
 * Background image — internal TUI plugin.
 *
 * Mirrors `feature-plugins/browser`: a self-contained plugin that owns one
 * feature end to end. It paints a real image behind the TUI — truecolor cell
 * backgrounds, composed by OpenTUI's native super-sampler — the way a terminal
 * wallpaper would, without needing the terminal to support one, and registers
 * the `/background` command that configures it. Nothing renders until an
 * image is picked.
 *
 * The plugin owns the settings, the dialogs and the commands, but *not* the
 * mounting: `app.tsx` renders {@link ./view#BackgroundImage} itself. Going
 * through a slot would nest the image under a `SlotRenderable`, where its
 * `zIndex: -1` only sorts against that node's own children — against the app
 * it would keep the order it was mounted in and paint over the tabs and the
 * prompt. Being a direct child of the app root is what puts it behind.
 */
import type { TuiPlugin, TuiPluginModule } from "@nikcli-ai/plugin/tui"
import { sourceLabel } from "./settings"
import { readSettings, rotation, writeSettings } from "./store"
import { isLocalSource } from "./source"
import { DialogBackground, DialogBackgroundPicker } from "./dialog"
import { dbg } from "./__debug"

const id = "internal:background"

const tui: TuiPlugin = async (api) => {
  dbg("plugin setup")
  // The runtime scopes the registration to the plugin's lifetime.
  api.keymap.registerLayer({
    commands: () => {
      const settings = readSettings(api.kv)
      return [
        {
          name: "background.configure",
          title: "Background image",
          namespace: "Appearance",
          description: settings.source
            ? `Background: ${sourceLabel(settings.source)}`
            : "Paint an image behind the TUI",
          slashName: "background",
          slashAliases: ["bg", "wallpaper"],
          run() {
            api.ui.dialog.replace(() => <DialogBackground />)
          },
        },
        {
          name: "background.choose",
          title: "Choose background image",
          namespace: "Appearance",
          description: "Browse the filesystem and pick an image",
          run() {
            api.ui.dialog.replace(() => <DialogBackgroundPicker />)
          },
        },
        {
          name: "background.toggle",
          title: settings.enabled ? "Hide background image" : "Show background image",
          namespace: "Appearance",
          description: "Keep the image configured but stop painting it",
          enabled: settings.source !== "",
          run() {
            writeSettings(api.kv, { enabled: !readSettings(api.kv).enabled })
          },
        },
        {
          name: "background.shuffle",
          title: "Shuffle background image",
          namespace: "Appearance",
          description: "Pick the next image when the source is a folder",
          // Rotation only means something for a path on this machine; a URL
          // or an attached image has nothing to rotate through.
          enabled: isLocalSource(settings.source),
          hidden: !isLocalSource(settings.source),
          run() {
            rotation.next()
          },
        },
      ]
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin

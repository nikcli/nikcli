/**
 * `/background` — pick the image and tune how it is painted.
 *
 * Rows act on `enter`: toggles flip, opacity cycles a step at a time. The
 * image can be picked from a list of images found on the machine, or typed
 * in (a file, a folder to rotate through, or a URL).
 */
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import path from "path"
import { useKV } from "@tui/context/kv"
import { useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { cleanSource, detailLabel, opacityLabel, sourceLabel, stepOpacity } from "./settings"
import { readSettings, rotation, writeSettings } from "./store"
import { isLocalSource, listDirectory, pickerStart, shortenPath, suggestedFolders } from "./source"

type Row = "browse" | "path" | "shuffle" | "opacity" | "fit" | "grayscale" | "detail" | "scope" | "enabled" | "clear"

type PickerRow =
  | { kind: "up"; path: string }
  | { kind: "directory"; path: string }
  | { kind: "image"; path: string }
  | { kind: "use-folder"; path: string }
  | { kind: "message" }

/**
 * Browse the filesystem and save the picked image.
 *
 * `enter` on a folder walks into it, `enter` on an image stores it as the
 * background. The list is remounted per directory (`keyed`) so the search
 * filter never leaks from one folder into the next.
 */
export function DialogBackgroundPicker() {
  const kv = useKV()
  const { theme } = useTheme()

  const [directory, setDirectory] = createSignal(pickerStart(readSettings(kv).source))
  const [entries] = createResource(directory, listDirectory)

  const save = (file: string, ctx: DialogContext) => {
    writeSettings(kv, { source: file, enabled: true })
    ctx.clear()
  }

  const options = createMemo((): DialogSelectOption<PickerRow>[] => {
    const current = directory()
    const rows: DialogSelectOption<PickerRow>[] = []
    const parent = path.dirname(current)

    if (parent !== current) {
      rows.push({
        value: { kind: "up", path: parent },
        title: "..",
        description: shortenPath(parent),
        category: "Navigate",
        gutter: <text fg={theme.foreground.muted}>↰</text>,
        onSelect: () => setDirectory(parent),
      })
    }

    const found = entries() ?? []
    const images = found.filter((entry) => entry.kind === "image")

    if (images.length > 1) {
      rows.push({
        value: { kind: "use-folder", path: current },
        title: "Use this folder",
        description: `Rotate through its ${images.length} images`,
        category: "Navigate",
        gutter: <text fg={theme.foreground.muted}>◇</text>,
        onSelect: (ctx) => save(current, ctx),
      })
    }

    for (const folder of suggestedFolders()) {
      if (path.resolve(folder.directory) === path.resolve(current)) continue
      rows.push({
        value: { kind: "directory", path: folder.directory },
        title: folder.label,
        description: shortenPath(folder.directory),
        category: "Jump to",
        gutter: <text fg={theme.foreground.muted}>→</text>,
        onSelect: () => setDirectory(folder.directory),
      })
    }

    if (entries.loading) {
      rows.push({ value: { kind: "message" }, title: "Reading folder...", category: "Contents", disabled: true })
      return rows
    }
    if (entries.error) {
      rows.push({
        value: { kind: "message" },
        title: "Cannot read this folder",
        description: (entries.error as Error).message,
        category: "Contents",
        disabled: true,
      })
      return rows
    }

    for (const entry of found) {
      if (entry.kind === "directory") {
        rows.push({
          value: { kind: "directory", path: entry.path },
          title: entry.name,
          category: "Folders",
          gutter: <text fg={theme.foreground.muted}>▸</text>,
          onSelect: () => setDirectory(entry.path),
        })
        continue
      }
      rows.push({
        value: { kind: "image", path: entry.path },
        title: entry.name,
        category: "Images",
        gutter: <text fg={theme.accent.fg}>◆</text>,
        footer: <span style={{ fg: theme.foreground.muted }}>{path.extname(entry.name).slice(1)}</span>,
        onSelect: (ctx) => save(entry.path, ctx),
      })
    }

    if (found.length === 0) {
      rows.push({
        value: { kind: "message" },
        title: "Nothing here",
        description: "No sub-folders and no images in this folder",
        category: "Contents",
        disabled: true,
      })
    }

    return rows
  })

  return (
    <Show when={directory()} keyed>
      {(current) => (
        <DialogSelect
          title={`Background · ${shortenPath(current)}`}
          placeholder="Search this folder..."
          options={options()}
        />
      )}
    </Show>
  )
}

export function DialogBackground() {
  const dialog = useDialog()
  const kv = useKV()
  const { theme } = useTheme()

  const settings = createMemo(() => readSettings(kv))
  const update = (patch: Parameters<typeof writeSettings>[1]) => writeSettings(kv, patch)

  const value = (text: string, muted = false) => (
    <span
      style={{
        fg: muted ? theme.foreground.muted : theme.foreground.default,
        attributes: muted ? undefined : TextAttributes.BOLD,
      }}
    >
      {text}
    </span>
  )

  const promptForSource = () =>
    dialog.replace(() => (
      <DialogPrompt
        title="Background image"
        placeholder="/path/to/image.png, a folder of images, or https://…"
        value={settings().source}
        onConfirm={(input) => {
          update({ source: cleanSource(input), enabled: true })
          dialog.clear()
        }}
        onCancel={() => dialog.clear()}
      />
    ))

  const options = createMemo((): DialogSelectOption<Row>[] => {
    const current = settings()
    const rows: DialogSelectOption<Row>[] = [
      {
        value: "browse",
        title: "Choose image",
        description: "Browse the filesystem and pick an image",
        category: "Source",
        footer: value(sourceLabel(current.source), current.source === ""),
        onSelect: () => dialog.replace(() => <DialogBackgroundPicker />),
      },
      {
        value: "path",
        title: "Enter path or URL",
        description: "A file, a folder to rotate through, or an https:// image",
        category: "Source",
        onSelect: promptForSource,
      },
    ]

    if (isLocalSource(current.source)) {
      rows.push({
        value: "shuffle",
        title: "Shuffle",
        description: "Pick the next image when the source is a folder",
        category: "Source",
        onSelect: () => rotation.next(),
      })
    }

    rows.push(
      {
        value: "opacity",
        title: "Opacity",
        description: "How strongly the image shows through the theme background",
        category: "Appearance",
        footer: value(opacityLabel(current.opacity)),
        onSelect: () => update({ opacity: stepOpacity(current.opacity) }),
      },
      {
        value: "fit",
        title: "Fit",
        description: "Fill the terminal, or letterbox the whole image",
        category: "Appearance",
        footer: value(current.fit),
        onSelect: () => update({ fit: current.fit === "cover" ? "contain" : "cover" }),
      },
      {
        value: "grayscale",
        title: "Grayscale",
        description: "Drop the color and keep only the luminance",
        category: "Appearance",
        footer: value(current.grayscale ? "on" : "off", !current.grayscale),
        onSelect: () => update({ grayscale: !current.grayscale }),
      },
      {
        value: "detail",
        title: "Detail",
        description:
          current.detail === "blocks"
            ? "Half-blocks are sharper, but the terminal's own selection and cmd-click read them as text"
            : "One color per cell, painted as a space — the terminal still selects and links normally",
        category: "Appearance",
        footer: value(detailLabel(current.detail), current.detail === "flat"),
        onSelect: () => update({ detail: current.detail === "flat" ? "blocks" : "flat" }),
      },
      {
        value: "scope",
        title: "Show on",
        description: "Home screen only, or behind every route",
        category: "Appearance",
        footer: value(current.scope === "all" ? "everywhere" : "home"),
        onSelect: () => update({ scope: current.scope === "all" ? "home" : "all" }),
      },
      {
        value: "enabled",
        title: current.enabled ? "Hide background" : "Show background",
        description: "Keep the image configured but stop painting it",
        category: "Appearance",
        footer: value(current.enabled ? "visible" : "hidden", !current.enabled),
        onSelect: () => update({ enabled: !current.enabled }),
      },
      {
        value: "clear",
        title: "Remove image",
        description: "Forget the configured source",
        category: "Appearance",
        disabled: current.source === "",
        onSelect: (ctx) => {
          update({ source: "" })
          ctx.clear()
        },
      },
    )

    return rows
  })

  return <DialogSelect title="Background" placeholder="Search settings..." options={options()} />
}

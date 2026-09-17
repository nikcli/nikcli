import type { Command } from "../command/registry"
import { DEFAULT_BINDINGS } from "../keyboard/bindings"
import { formatChord, parseChord, type Platform } from "../keyboard/keymap"
import type { RecentEntry } from "../host/recent"
import { t } from "../i18n"
import { ADE_VIEW_LABELS, VISIBLE_VIEWS, nextView, type AdeView, type Workbench } from "./state"

export interface SurfaceCommand extends Command {
  /** Why the command cannot run now. Shown instead of hiding the row. */
  disabledReason?: string
  description?: string
}

/**
 * One command a loaded plugin has offered.
 *
 * Deliberately not `RegisteredCommand` from `../plugin/registry`: what the
 * palette needs is four strings, and the registry entry also carries the
 * handler. Keeping the handler out of here means nothing in this module can
 * run plugin code, which is the point — `buildCommands` only decides what is
 * *listed*, and the workbench decides what is invoked.
 */
export interface PluginCommandEntry {
  /** Already namespaced by the plugin host: `plugin:<id>:<command>`. */
  id: string
  title: string
  group: string
  keywords?: string[]
}

export interface CommandContext {
  workbench: Workbench
  recents: RecentEntry[]
  hasHost: boolean
  /** Ids of panes with a live process behind them. */
  running: ReadonlySet<string>
  platform: Platform
  voiceAvailable?: boolean
  voiceActive?: boolean
  voiceChord?: string
  /** True while a take is being recorded (S36), so the palette offers to stop it. */
  recording?: boolean
  /** The chosen quality, written out with its size per minute. */
  recordQuality?: string
  /** The microphone is on for the takes the user starts. */
  recordMic?: boolean
  /** Commands contributed by loaded plugins. Empty when none are loaded. */
  pluginCommands?: PluginCommandEntry[]
  /** The sections that can be reached. `VISIBLE_VIEWS` unless a test injects the other branch. */
  views?: readonly AdeView[]
}

/**
 * The shortcut a command is actually bound to.
 *
 * Derived rather than written out beside each command: a palette that shows a
 * key combination the keymap does not implement teaches the user something
 * false, and that drift is invisible until someone presses the key.
 */
function shortcutFor(commandId: string, platform: Platform, voiceChord?: string): string | undefined {
  if (commandId === "voice.toggle") {
    const chordStr = voiceChord ?? "mod+shift+k"
    return formatChord(parseChord(chordStr, platform), platform)
  }
  const entry = DEFAULT_BINDINGS.find((binding) => binding.commandId === commandId)
  return entry ? formatChord(parseChord(entry.chord, platform), platform) : undefined
}

/**
 * Whether running this command must leave the palette open.
 *
 * `runCommand` closes the palette on its last line, which is right for every
 * command that does something elsewhere — you picked it, it ran, the overlay
 * gets out of the way. It is exactly wrong for the one command whose whole
 * effect is to open the palette: opening and then closing in the same
 * synchronous pass meant Ctrl+Shift+P opened nothing at all, while the header
 * button kept working because it calls the setter directly. The rule lives
 * here, named and pinned by a test, rather than as a `return` inside a
 * component nothing can reach.
 */
export function keepsPaletteOpen(commandId: string): boolean {
  return commandId === "palette.open"
}

/**
 * Every command the palette can offer, given what is true right now.
 *
 * A command that cannot run stays in the list with the reason attached. Removing
 * it would be worse: the user who looked for it concludes they misremembered the
 * name, and goes looking again.
 */
export function buildCommands(ctx: CommandContext): SurfaceCommand[] {
  const { workbench, recents, hasHost, running, platform } = ctx
  const views = ctx.views ?? VISIBLE_VIEWS
  const focusedPane = workbench.focusedId ? workbench.panes.find((pane) => pane.id === workbench.focusedId) : undefined
  const focusedRuns = !!focusedPane && running.has(focusedPane.id)
  const desktopOnly = hasHost ? undefined : t("palette.desktopOnly")

  const commands: SurfaceCommand[] = [
    {
      id: "session.new",
      title: t("palette.session.new"),
      group: t("palette.group.session"),
      keywords: ["avvia", "agente", "lancia", "start", "agent", "launch"],
      shortcut: shortcutFor("session.new", platform),
    },
    {
      id: "project.open",
      title: t("palette.project.open"),
      group: t("palette.group.project"),
      keywords: ["cartella", "repository", "folder"],
      enabled: hasHost,
      disabledReason: desktopOnly,
    },
    {
      id: "pane.close",
      title: t("palette.pane.close"),
      group: t("palette.group.pane"),
      enabled: !!focusedPane,
      disabledReason: focusedPane ? undefined : t("palette.noFocusedPane"),
      shortcut: shortcutFor("pane.close", platform),
    },
    {
      id: "pane.expand",
      title: workbench.expandedId ? t("palette.pane.shrink") : t("palette.pane.expand"),
      group: t("palette.group.pane"),
      enabled: !!focusedPane,
      disabledReason: focusedPane ? undefined : t("palette.noFocusedPane"),
      shortcut: shortcutFor("pane.expand", platform),
    },
    {
      id: "pane.rename",
      title: t("palette.pane.rename"),
      group: t("palette.group.pane"),
      enabled: !!focusedPane,
      disabledReason: focusedPane ? undefined : t("palette.noFocusedPane"),
      shortcut: shortcutFor("pane.rename", platform),
    },
    {
      id: "view.toggle",
      title: t("palette.view.next", ADE_VIEW_LABELS[nextView(workbench.view, views)]),
      group: t("palette.group.view"),
      shortcut: shortcutFor("view.toggle", platform),
    },
    /*
     * One command per section, beside the cycle.
     *
     * With two views a toggle was the whole navigation; with four it is a way
     * of pressing a key three times to get somewhere. The palette is how ADE
     * is driven, so each section is reachable by name from it — and the one
     * already open is offered as disabled rather than hidden, so the list does
     * not change shape as you move around it.
     */
    ...views.map((view) => ({
      id: `view.${view}`,
      title: t("palette.view.goTo", ADE_VIEW_LABELS[view]),
      group: t("palette.group.view"),
      enabled: workbench.view !== view,
      disabledReason: workbench.view === view ? t("palette.view.here") : undefined,
    })),
    {
      id: "theme.toggle",
      title: t("palette.theme.toggle"),
      group: t("palette.group.view"),
      keywords: ["chiaro", "scuro", "light", "dark", "theme"],
      shortcut: shortcutFor("theme.toggle", platform),
    },
    {
      id: "voice.toggle",
      title: ctx.voiceActive ? t("palette.voice.off") : t("palette.voice.on"),
      group: t("palette.group.view"),
      keywords: ["voce", "microfono", "audio", "parla", "voice", "microphone", "speak"],
      enabled: ctx.voiceAvailable !== false,
      disabledReason: ctx.voiceAvailable !== false ? undefined : t("palette.voice.unsupported"),
      shortcut: shortcutFor("voice.toggle", platform, ctx.voiceChord),
    },
    {
      id: "record.toggle",
      title: ctx.recording ? t("palette.record.stop") : t("palette.record.start"),
      group: t("palette.group.view"),
      keywords: [
        "video",
        "registra",
        "schermo",
        "cattura",
        "demo",
        "pubblicità",
        "record",
        "screen",
        "capture",
        "promo",
      ],
      enabled: ctx.hasHost,
      disabledReason: ctx.hasHost ? undefined : t("palette.record.desktopOnly"),
    },
    {
      id: "record.quality",
      title: ctx.recordQuality ? t("palette.record.qualityIs", ctx.recordQuality) : t("palette.record.quality"),
      group: t("palette.group.view"),
      keywords: ["video", "qualità", "fps", "peso", "dimensione", "quality", "size"],
      enabled: ctx.hasHost,
      disabledReason: ctx.hasHost ? undefined : t("palette.record.desktopOnly"),
    },
    {
      id: "record.export",
      title: t("palette.record.export"),
      group: t("palette.group.view"),
      keywords: ["video", "esporta", "zoom", "clic", "pubblicità", "promo", "export", "click"],
      enabled: ctx.hasHost,
      disabledReason: ctx.hasHost ? undefined : t("palette.record.desktopOnly"),
    },
    {
      id: "record.mic",
      title: ctx.recordMic ? t("palette.record.micOff") : t("palette.record.micOn"),
      group: t("palette.group.view"),
      keywords: ["video", "registra", "microfono", "audio", "voce", "record", "microphone"],
      enabled: ctx.hasHost,
      disabledReason: ctx.hasHost ? undefined : t("palette.record.desktopOnly"),
    },
    {
      id: "record.folder",
      title: t("palette.record.folder"),
      group: t("palette.group.view"),
      keywords: ["video", "registra", "cartella", "salva", "folder", "save"],
      enabled: ctx.hasHost,
      disabledReason: ctx.hasHost ? undefined : t("palette.record.desktopOnly"),
    },
    {
      id: "voice.settings",
      title: t("palette.voice.settings"),
      group: t("palette.group.view"),
      keywords: ["voce", "impostazioni", "microfono", "audio", "configurazione", "voice", "settings", "microphone"],
    },
    {
      id: "browser.new",
      title: t("palette.browser.new"),
      group: t("palette.group.pane"),
      keywords: ["anteprima", "localhost", "preview"],
    },
    {
      id: "video.new",
      title: t("palette.video.new"),
      group: t("palette.group.pane"),
      keywords: ["riproduttore", "player", "registrazione", "mp4", "fotogramma", "recording", "frame"],
    },
    {
      id: "model.new",
      title: t("palette.model.new"),
      group: t("palette.group.pane"),
      keywords: ["3d", "gltf", "glb", "obj", "stl", "fbx", "mesh", "visualizzatore", "model", "viewer"],
    },
    {
      id: "app.new",
      title: t("palette.app.new"),
      group: t("palette.group.pane"),
      keywords: [
        "simulatore",
        "emulatore",
        "telefono",
        "mobile",
        "expo",
        "tauri",
        "dispositivo",
        "finestra",
        "simulator",
        "emulator",
        "phone",
        "device",
        "window",
      ],
    },
    {
      id: "decisions.open",
      title: t("palette.decisions.open"),
      group: t("palette.group.pane"),
      keywords: [
        "decisioni",
        "decidere",
        "scelte",
        "domande",
        "master",
        "bearings",
        "rispondi",
        "decisions",
        "questions",
        "answer",
      ],
    },
    {
      id: "decisions.pane",
      title: t("palette.decisions.pane"),
      group: t("palette.group.pane"),
      keywords: ["decisioni", "registro", "risposte", "rimandate", "chiuse", "bearings", "decisions", "log", "answers"],
    },
    {
      id: "update.check",
      title: t("palette.update.check"),
      group: "ADE",
      keywords: ["aggiornamento", "versione", "release", "novità", "installa", "update", "version", "install"],
      enabled: hasHost,
      disabledReason: desktopOnly,
    },
    {
      id: "process.kill",
      title: t("palette.process.kill"),
      group: t("palette.group.process"),
      keywords: ["ferma", "termina", "stop", "kill", "terminate"],
      enabled: focusedRuns,
      disabledReason: focusedRuns ? undefined : t("palette.process.none"),
    },
  ]

  for (const recent of recents) {
    commands.push({
      id: `project.recent.${recent.root}`,
      title: recent.name,
      group: t("palette.group.recent"),
      enabled: hasHost,
      disabledReason: desktopOnly,
      description: recent.root,
    })
  }

  /*
   * Plugin commands go last, and they go through a collision check on the way.
   *
   * Last because ADE's own commands are what the palette is for and a plugin
   * should not outrank them in an empty query. The check because this is the
   * final gate before the list reaches the palette: `trust.ts` already
   * namespaces every plugin command so a collision cannot be constructed, and
   * a collision arriving here anyway would mean that namespacing has broken —
   * in which case dropping the row is far better than letting a plugin answer
   * to `pane.close`.
   */
  const claimed = new Set(commands.map((command) => command.id))
  for (const plugin of ctx.pluginCommands ?? []) {
    if (claimed.has(plugin.id)) continue
    claimed.add(plugin.id)
    commands.push({
      id: plugin.id,
      title: plugin.title,
      group: plugin.group,
      keywords: plugin.keywords,
    })
  }

  return commands
}

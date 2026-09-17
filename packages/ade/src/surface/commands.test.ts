import { describe, expect, test } from "bun:test"
import { buildCommands, keepsPaletteOpen, type CommandContext } from "./commands"
import { resetLocaleForTests } from "../i18n"
import { CHAT_AND_BOT_ENABLED, createWorkbench, VISIBLE_VIEWS, visibleViews, type Pane, type Workbench } from "./state"

function context(overrides: Partial<CommandContext> & { workbench: Workbench }): CommandContext {
  return {
    recents: [],
    hasHost: true,
    running: new Set<string>(),
    platform: "other",
    ...overrides,
  }
}

function pane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "p1",
    title: "Test",
    status: "working",
    model: "agy",
    mode: "auto",
    lines: [],
    workspaceId: "ws1",
    ...overrides,
  }
}

describe("section commands", () => {
  test("every section is reachable by name from the palette", () => {
    // The palette is how ADE is driven, so a section that can only be reached
    // by pressing the cycle key three times is effectively hidden.
    const ids = buildCommands(context({ workbench: createWorkbench() })).map((c) => c.id)
    expect(ids).toContain("view.agent")
    expect(ids).toContain("view.code")
    for (const view of VISIBLE_VIEWS) expect(ids).toContain(`view.${view}`)
  })

  /*
   * S40: Chat and Bot are hidden behind one switch. Hidden means no way in
   * from here either — a palette entry for a section the bar does not show is
   * a door into a room with no door out.
   */
  test("a hidden section has no palette entry, and the switch brings both back", () => {
    for (const enabled of [false, true]) {
      const views = visibleViews(enabled)
      const cmds = buildCommands(context({ workbench: { ...createWorkbench(), view: "code" }, views }))
      const ids = cmds.map((c) => c.id)
      for (const view of ["chat", "bot"] as const) expect(ids.includes(`view.${view}`)).toBe(enabled)
      // From Code the cycle goes on to Chat only when Chat can be reached.
      expect(cmds.find((c) => c.id === "view.toggle")?.title).toContain(enabled ? "Chat" : "Agent")
    }
    const ids = buildCommands(context({ workbench: createWorkbench() })).map((c) => c.id)
    expect(ids.includes("view.chat")).toBe(CHAT_AND_BOT_ENABLED)
  })

  test("the section you are already in is offered as disabled, not hidden", () => {
    // A list that changes length as you move around it is a list you cannot
    // build muscle memory for.
    const cmds = buildCommands(context({ workbench: { ...createWorkbench(), view: "agent" } }))
    const here = cmds.find((c) => c.id === "view.agent")
    expect(here?.enabled).toBe(false)
    expect(here?.disabledReason).toBe("Sei già qui")
    expect(cmds.find((c) => c.id === "view.code")?.enabled).toBe(true)
  })

  test("the cycle names where it will land, and wraps", () => {
    const at = (view: Workbench["view"]) =>
      buildCommands(context({ workbench: { ...createWorkbench(), view } })).find((c) => c.id === "view.toggle")?.title

    expect(at("agent")).toBe("Sezione successiva (Code)")
    if (CHAT_AND_BOT_ENABLED) {
      expect(at("chat")).toBe("Sezione successiva (Bot)")
      // The wrap is the point of the test, and `bot` is the last section.
      expect(at("bot")).toBe("Sezione successiva (Agent)")
    } else {
      // With Chat and Bot hidden the cycle is two long, and never stops on either.
      expect(at("code")).toBe("Sezione successiva (Agent)")
    }
  })
})

describe("keepsPaletteOpen", () => {
  /*
   * `runCommand` closes the palette on its way out, so the command that opens
   * it has to say so or it closes itself in the same pass — which is exactly
   * what Ctrl+Shift+P did: nothing. The keyboard was the only way to see it,
   * because the header button bypasses `runCommand` entirely.
   */
  test("the command that opens the palette is the one that keeps it open", () => {
    expect(keepsPaletteOpen("palette.open")).toBe(true)
  })

  test("every other command lets it close behind them", () => {
    const others = buildCommands(context({ workbench: createWorkbench() }))
    expect(others.length).toBeGreaterThan(0)
    for (const command of others) {
      expect(keepsPaletteOpen(command.id)).toBe(false)
    }
  })
})

describe("surface commands", () => {
  test("offers starting a session, and says why closing is unavailable", () => {
    const cmds = buildCommands(context({ workbench: createWorkbench() }))

    expect(cmds.find((c) => c.id === "session.new")).toBeDefined()

    const close = cmds.find((c) => c.id === "pane.close")
    expect(close?.enabled).toBe(false)
    expect(close?.disabledReason).toBe("Nessun pannello a fuoco")
  })

  test("checking for updates is offered, and only where there is a version to update", () => {
    const desktop = buildCommands(context({ workbench: createWorkbench() }))
    const check = desktop.find((c) => c.id === "update.check")
    expect(check?.title).toBe("Controlla aggiornamenti")
    expect(check?.enabled).not.toBe(false)
    expect(check?.keywords).toContain("aggiornamento")

    // In a browser tab of the dev server there is no installed build to be behind.
    const browser = buildCommands(context({ workbench: createWorkbench(), hasHost: false }))
    expect(browser.find((c) => c.id === "update.check")?.enabled).toBe(false)
  })

  test("a focused pane enables the pane commands", () => {
    const wb = createWorkbench()
    wb.panes.push(pane())
    wb.focusedId = "p1"

    const cmds = buildCommands(context({ workbench: wb }))

    expect(cmds.find((c) => c.id === "pane.close")?.enabled).toBe(true)
    expect(cmds.find((c) => c.id === "pane.expand")?.enabled).toBe(true)
    expect(cmds.find((c) => c.id === "pane.rename")?.enabled).toBe(true)
    expect(cmds.find((c) => c.id === "pane.rename")?.shortcut).toBe("F2")
  })

  /*
   * The distinction the old version got wrong: a pane that is not a browser is
   * not the same as a pane with a live process. Killing what has already exited
   * is a command that can only disappoint.
   */
  test("killing is offered only when the focused pane has a live process", () => {
    const wb = createWorkbench()
    wb.panes.push(pane())
    wb.focusedId = "p1"

    const idle = buildCommands(context({ workbench: wb }))
    expect(idle.find((c) => c.id === "process.kill")?.enabled).toBe(false)

    const live = buildCommands(context({ workbench: wb, running: new Set(["p1"]) }))
    expect(live.find((c) => c.id === "process.kill")?.enabled).toBe(true)
  })

  test("without a host, the commands that need the disk say so", () => {
    const cmds = buildCommands(context({ workbench: createWorkbench(), hasHost: false }))

    const open = cmds.find((c) => c.id === "project.open")
    expect(open?.enabled).toBe(false)
    expect(open?.disabledReason).toBe("Richiede l'app desktop")
  })

  test("shortcuts come from the keymap rather than from prose", () => {
    const cmds = buildCommands(context({ workbench: createWorkbench() }))

    // Bound in DEFAULT_BINDINGS as mod+w, which is Ctrl on this platform.
    expect(cmds.find((c) => c.id === "pane.close")?.shortcut).toBe("Ctrl+W")
    // Not bound to anything, so it must not claim a key.
    expect(cmds.find((c) => c.id === "browser.new")?.shortcut).toBeUndefined()
  })

  test("a loaded plugin's commands are offered, after ADE's own", () => {
    const cmds = buildCommands(
      context({
        workbench: createWorkbench(),
        pluginCommands: [
          { id: "plugin:my.plugin:overview", title: "Mostra tutto", group: "Plugin", keywords: ["estensioni"] },
        ],
      }),
    )

    const last = cmds[cmds.length - 1]
    expect(last?.id).toBe("plugin:my.plugin:overview")
    expect(last?.title).toBe("Mostra tutto")
    expect(last?.keywords).toEqual(["estensioni"])
    // Not disabled by default: a loaded plugin's command is always runnable.
    expect(last?.enabled).toBeUndefined()
  })

  /*
   * `trust.ts` namespaces every plugin command so a collision cannot be
   * constructed. This is the last gate before the palette, and a collision
   * arriving here anyway means the namespacing has broken — in which case
   * dropping the row is far better than letting a plugin answer to a name the
   * user reads as ADE's.
   */
  test("a plugin command cannot take an id ADE has already claimed", () => {
    const cmds = buildCommands(
      context({
        workbench: createWorkbench(),
        pluginCommands: [{ id: "pane.close", title: "Non sono io", group: "Plugin" }],
      }),
    )

    expect(cmds.filter((c) => c.id === "pane.close")).toHaveLength(1)
    expect(cmds.find((c) => c.id === "pane.close")?.title).toBe("Chiudi pannello")
  })

  test("two plugin commands with the same id keep only the first", () => {
    const cmds = buildCommands(
      context({
        workbench: createWorkbench(),
        pluginCommands: [
          { id: "plugin:a:run", title: "Primo", group: "Plugin" },
          { id: "plugin:a:run", title: "Secondo", group: "Plugin" },
        ],
      }),
    )

    const hits = cmds.filter((c) => c.id === "plugin:a:run")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.title).toBe("Primo")
  })

  test("recent projects become commands of their own", () => {
    const cmds = buildCommands(
      context({
        workbench: createWorkbench(),
        recents: [{ name: "Nikcli", root: "/path", openedAt: 123 }],
      }),
    )

    const recent = cmds.find((c) => c.id.startsWith("project.recent."))
    expect(recent?.title).toBe("Nikcli")
    expect(recent?.description).toBe("/path")
  })

  test("offers recording, says stop while it films, and only in the desktop app", () => {
    const idle = buildCommands(context({ workbench: createWorkbench() }))
    expect(idle.find((c) => c.id === "record.toggle")?.title).toBe("Registra la finestra")
    expect(idle.find((c) => c.id === "record.folder")?.enabled).toBe(true)

    const filming = buildCommands(context({ workbench: createWorkbench(), recording: true }))
    expect(filming.find((c) => c.id === "record.toggle")?.title).toBe("Ferma la registrazione")

    const browser = buildCommands(context({ workbench: createWorkbench(), hasHost: false }))
    const offered = browser.find((c) => c.id === "record.toggle")
    expect(offered?.enabled).toBe(false)
    expect(offered?.disabledReason).toContain("desktop")
  })

  test("the microphone for recordings is a switch that says what it will do", () => {
    const off = buildCommands(context({ workbench: createWorkbench() }))
    expect(off.find((c) => c.id === "record.mic")?.title).toBe("Attiva il microfono nelle registrazioni")
    const on = buildCommands(context({ workbench: createWorkbench(), recordMic: true }))
    expect(on.find((c) => c.id === "record.mic")?.title).toBe("Disattiva il microfono nelle registrazioni")
  })

  test("offers voice.toggle, toggling title and disabling when voice unavailable", () => {
    const defaultCmds = buildCommands(context({ workbench: createWorkbench(), voiceAvailable: true }))
    const voiceCmd = defaultCmds.find((c) => c.id === "voice.toggle")
    expect(voiceCmd).toBeDefined()
    expect(voiceCmd?.enabled).toBe(true)
    expect(voiceCmd?.title).toBe("Attiva il controllo vocale")
    expect(voiceCmd?.shortcut).toBe("Ctrl+Shift+K")
    expect(voiceCmd?.disabledReason).toBeUndefined()

    const activeCmds = buildCommands(
      context({ workbench: createWorkbench(), voiceAvailable: true, voiceActive: true }),
    )
    const activeVoiceCmd = activeCmds.find((c) => c.id === "voice.toggle")
    expect(activeVoiceCmd?.title).toBe("Disattiva il controllo vocale")

    const disabledCmds = buildCommands(context({ workbench: createWorkbench(), voiceAvailable: false }))
    const disabledVoiceCmd = disabledCmds.find((c) => c.id === "voice.toggle")
    expect(disabledVoiceCmd?.enabled).toBe(false)
    expect(disabledVoiceCmd?.disabledReason).toBe("Riconoscimento vocale non supportato da questo browser")

    const configuredCmds = buildCommands(
      context({ workbench: createWorkbench(), voiceAvailable: true, voiceChord: "mod+shift+z" })
    )
    const configuredVoiceCmd = configuredCmds.find((c) => c.id === "voice.toggle")
    expect(configuredVoiceCmd?.shortcut).toBe("Ctrl+Shift+Z")
  })

  test("offers voice.settings command under Vista group", () => {
    const cmds = buildCommands(context({ workbench: createWorkbench() }))
    const settingsCmd = cmds.find((c) => c.id === "voice.settings")
    expect(settingsCmd).toBeDefined()
    expect(settingsCmd?.title).toBe("Impostazioni vocali")
    expect(settingsCmd?.group).toBe("Vista")
    expect(settingsCmd?.keywords).toContain("impostazioni")
    expect(settingsCmd?.keywords).toContain("voce")
  })
})

describe("the palette in English (S41)", () => {
  test("titles, groups and reasons follow the language, and Italian keywords still match", () => {
    resetLocaleForTests("en")
    try {
      const cmds = buildCommands(context({ workbench: createWorkbench() }))
      const close = cmds.find((c) => c.id === "pane.close")
      expect(close?.title).toBe("Close panel")
      expect(close?.group).toBe("Panel")
      expect(close?.disabledReason).toBe("No panel is focused")
      const theme = cmds.find((c) => c.id === "theme.toggle")
      expect(theme?.keywords).toContain("scuro")
      expect(theme?.keywords).toContain("dark")
    } finally {
      resetLocaleForTests("it")
    }
  })
})

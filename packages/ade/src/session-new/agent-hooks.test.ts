import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  HOOK_MARKER,
  HOOK_TARGETS,
  hookCommand,
  hookScript,
  hookTarget,
  installHook,
  installedCommand,
  isAdeCommand,
  missingActivityEvents,
  readHookStatus,
  removeHook,
  setHook,
} from "./agent-hooks"

/**
 * The real shape of `~/.claude/settings.json` on a machine that already has
 * four other tools hooked into `SessionStart`, trimmed to the parts that
 * matter. Kept verbatim on purpose: the whole risk in this module is damaging
 * somebody else's file, and a made-up fixture would not catch it.
 */
const CLAUDE = JSON.stringify(
  {
    model: "opus",
    permissions: { allow: ["Bash(git diff:*)"] },
    hooks: {
      SessionStart: [
        { matcher: "startup|resume|clear", hooks: [{ type: "command", command: "gh-axi", timeout: 10 }] },
        { matcher: "startup|resume|clear", hooks: [{ type: "command", command: "lavish-axi", timeout: 10 }] },
      ],
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "node hook.mjs", timeout: 5 }] }],
    },
  },
  null,
  2,
)

/** `~/.codex/hooks.json`, whose ADE-relevant entry carries no matcher at all. */
const CODEX = JSON.stringify(
  {
    hooks: {
      SessionStart: [
        { hooks: [{ command: "gh-axi", timeout: 10, type: "command" }], matcher: "" },
        {
          hooks: [
            {
              command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\x\\.codex\\herdr-agent-state.ps1" session',
              timeout: 10,
              type: "command",
            },
          ],
        },
      ],
    },
  },
  null,
  2,
)

const CLAUDE_SCRIPT = "C:\\Users\\x\\.claude\\hooks\\ade-agent-session.ps1"

describe("targets", () => {
  test("only the two CLIs whose format has been read off disk", () => {
    expect(HOOK_TARGETS.map((target) => target.id)).toEqual(["claude-code", "codex"])
  })

  test("every target is an agent ADE can also resume", async () => {
    const { RESUME } = await import("./resume")
    for (const target of HOOK_TARGETS) expect(RESUME[target.id]).toBeDefined()
  })

  test("codex carries no matcher, mirroring the entry that is known to work", () => {
    expect(hookTarget("codex")?.matcher).toBeUndefined()
    expect(hookTarget("claude-code")?.matcher).toBe("startup|resume|clear")
  })

  test("an unknown agent has no target", () => {
    expect(hookTarget("gemini")).toBeUndefined()
  })
})

describe("the targets here and the paths in Rust", () => {
  /*
   * Two tables in two languages: this one decides what to write, and
   * `HOOK_TARGETS` in `src-tauri/src/agent_link.rs` decides where. Both files
   * carry a comment telling the reader about the other, and a comment is not
   * a check — an agent added here and not there produces "nessun hook noto
   * per <id>" from a button that should have worked.
   *
   * Read out of the Rust rather than restated, for the same reason as
   * `allowlist.test.ts`: a second copy in TypeScript would be a third thing
   * to keep in step, and would pass while the real table was wrong.
   */
  const source = readFileSync(new URL("../../src-tauri/src/agent_link.rs", import.meta.url), "utf8")

  /** The `id:` of every entry in the Rust table. */
  const rustIds = [...source.matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1])

  test("the Rust table was actually found, so a rename cannot make this vacuous", () => {
    expect(rustIds.length).toBeGreaterThan(1)
  })

  test("the two tables name the same CLIs", () => {
    expect(rustIds.toSorted()).toEqual(HOOK_TARGETS.map((target) => target.id).toSorted())
  })

  test("Rust puts the script where this module says the marker is", () => {
    expect(source).toContain(`const SCRIPT_NAME: &str = "${HOOK_MARKER}.ps1";`)
  })

  test("the environment variables the script reads are the ones Rust sets", () => {
    const pty = readFileSync(new URL("../../src-tauri/src/pty.rs", import.meta.url), "utf8")
    for (const name of ["ADE_PANE_ID", "ADE_SPAWN_NONCE", "ADE_SESSION_DIR"]) {
      expect(hookScript("codex")).toContain(`$env:${name}`)
      expect(pty).toContain(`builder.env("${name}"`)
    }
  })
})

describe("recognising ADE's own entry", () => {
  test("by the marker in the script path, not by the whole command", () => {
    expect(isAdeCommand(hookCommand(CLAUDE_SCRIPT))).toBe(true)
    // An entry left by an older version, at a path ADE no longer uses.
    expect(isAdeCommand(`sh /opt/${HOOK_MARKER}.sh`)).toBe(true)
    expect(isAdeCommand("gh-axi")).toBe(false)
    expect(isAdeCommand(undefined)).toBe(false)
  })

  test("finds nothing in a config ADE has never touched", () => {
    expect(installedCommand(CLAUDE)).toBeUndefined()
    expect(installedCommand(CODEX)).toBeUndefined()
    expect(installedCommand(undefined)).toBeUndefined()
  })
})

describe("installHook", () => {
  test("leaves every other tool's hook exactly where it was", () => {
    const command = hookCommand(CLAUDE_SCRIPT)
    const after = JSON.parse(installHook(CLAUDE, command, "startup|resume|clear"))
    const before = JSON.parse(CLAUDE)

    expect(after.model).toBe("opus")
    expect(after.permissions).toEqual(before.permissions)
    expect(after.hooks.PostToolUse).toEqual(before.hooks.PostToolUse)
    expect(after.hooks.SessionStart.slice(0, 2)).toEqual(before.hooks.SessionStart)
  })

  test("appends one entry, last, in the CLI's own format", () => {
    const command = hookCommand(CLAUDE_SCRIPT)
    const groups = JSON.parse(installHook(CLAUDE, command, "startup|resume|clear")).hooks.SessionStart
    expect(groups).toHaveLength(3)
    expect(groups[2]).toEqual({
      matcher: "startup|resume|clear",
      hooks: [{ type: "command", command, timeout: 5 }],
    })
  })

  test("omits the matcher key entirely when the target has none", () => {
    const groups = JSON.parse(installHook(CODEX, hookCommand("C:\\s.ps1"))).hooks.SessionStart
    expect(Object.keys(groups[2])).toEqual(["hooks"])
  })

  test("installing twice leaves one entry, at the new path", () => {
    const once = installHook(CLAUDE, hookCommand("C:\\old\\ade-agent-session.ps1"), "startup")
    const twice = installHook(once, hookCommand(CLAUDE_SCRIPT), "startup")
    const groups = JSON.parse(twice).hooks.SessionStart
    expect(groups.filter((g: { hooks: { command: string }[] }) => isAdeCommand(g.hooks[0].command))).toHaveLength(1)
    expect(installedCommand(twice)).toBe(hookCommand(CLAUDE_SCRIPT))
  })

  test("writes a usable file when there was none", () => {
    const text = installHook(undefined, hookCommand(CLAUDE_SCRIPT))
    expect(installedCommand(text)).toBe(hookCommand(CLAUDE_SCRIPT))
    expect(text.endsWith("\n")).toBe(true)
  })

  test("a config that does not parse is replaced rather than refused", () => {
    expect(installedCommand(installHook("{ nope,", hookCommand(CLAUDE_SCRIPT)))).toBeDefined()
  })
})

describe("removeHook", () => {
  test("puts the config back exactly as it was", () => {
    const installed = installHook(CLAUDE, hookCommand(CLAUDE_SCRIPT), "startup|resume|clear")
    expect(JSON.parse(removeHook(installed))).toEqual(JSON.parse(CLAUDE))
    expect(installedCommand(removeHook(installed))).toBeUndefined()
  })

  test("keeps a neighbour that shared the group", () => {
    // Not a shape ADE writes, but one a user can easily hand-edit into being.
    const shared = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "gh-axi" },
              { type: "command", command: hookCommand(CLAUDE_SCRIPT) },
            ],
          },
        ],
      },
    })
    const groups = JSON.parse(removeHook(shared)).hooks.SessionStart
    expect(groups).toHaveLength(1)
    expect(groups[0].hooks).toEqual([{ type: "command", command: "gh-axi" }])
  })

  test("removing when nothing is installed changes nothing", () => {
    expect(JSON.parse(removeHook(CODEX))).toEqual(JSON.parse(CODEX))
  })
})

describe("readHookStatus and setHook", () => {
  /** A pair of files in memory, behaving the way the Rust commands do. */
  function disk(configText: string | null = null, scriptPresent = false) {
    const state = { configText, scriptPresent, writes: 0 }
    const host = {
      readAgentHook: async () => ({
        configPath: "C:\\Users\\x\\.claude\\settings.json",
        configText: state.configText,
        scriptPath: CLAUDE_SCRIPT,
        scriptPresent: state.scriptPresent,
      }),
      writeAgentHook: async (_agent: string, configText: string, script: string | null) => {
        state.writes++
        state.configText = configText
        state.scriptPresent = script !== null
      },
    }
    return { state, host }
  }

  const claude = hookTarget("claude-code")!

  test("off, when nothing has been installed", async () => {
    const status = await readHookStatus(disk(CLAUDE).host, claude)
    expect(status).toMatchObject({ installed: false, broken: false })
    expect(status.configPath).toContain("settings.json")
  })

  test("installing writes both halves and reads back as on", async () => {
    const { state, host } = disk(CLAUDE)
    const status = await setHook(host, claude, true)

    expect(status.installed).toBe(true)
    expect(status.broken).toBe(false)
    expect(state.scriptPresent).toBe(true)
    expect(installedCommand(state.configText ?? undefined)).toBe(hookCommand(CLAUDE_SCRIPT))
  })

  test("removing puts the file back and deletes the script", async () => {
    const { state, host } = disk(CLAUDE)
    await setHook(host, claude, true)
    const status = await setHook(host, claude, false)

    expect(status.installed).toBe(false)
    expect(state.scriptPresent).toBe(false)
    expect(JSON.parse(state.configText!)).toEqual(JSON.parse(CLAUDE))
  })

  test("an entry whose script is gone reads as broken, not as off", async () => {
    const installed = installHook(CLAUDE, hookCommand(CLAUDE_SCRIPT), "startup|resume|clear")
    const status = await readHookStatus(disk(installed, false).host, claude)
    expect(status).toMatchObject({ installed: false, broken: true })
  })

  test("an entry left at an old path reads as broken", async () => {
    const installed = installHook(CLAUDE, hookCommand("C:\\old\\ade-agent-session.ps1"), "startup")
    const status = await readHookStatus(disk(installed, true).host, claude)
    expect(status).toMatchObject({ installed: false, broken: true })
  })

  test("merges against the file as it is now, not as the panel last saw it", async () => {
    const { state, host } = disk(CLAUDE)
    // Somebody else's tool adds a hook while the settings panel sits open.
    state.configText = installHook(CLAUDE, "another-tool --hook", "startup")

    await setHook(host, claude, true)

    const groups = JSON.parse(state.configText).hooks.SessionStart
    expect(groups.some((g: { hooks: { command: string }[] }) => g.hooks[0].command === "another-tool --hook")).toBe(true)
    expect(installedCommand(state.configText)).toBe(hookCommand(CLAUDE_SCRIPT))
  })

  test("a host that cannot reach the files says so instead of throwing", async () => {
    const status = await readHookStatus({}, claude)
    expect(status.installed).toBe(false)
    expect(status.error).toBeDefined()
  })

  test("a command that fails is reported, not swallowed", async () => {
    const host = {
      readAgentHook: async () => {
        throw new Error("cartella utente non trovata")
      },
    }
    expect((await readHookStatus(host, claude)).error).toBe("cartella utente non trovata")
  })
})

describe("hookScript", () => {
  const script = hookScript("codex")

  test("does nothing at all outside ADE", () => {
    // The first guard is the nonce, so a CLI the user started themselves
    // exits before reading stdin — a hook that consumed the payload and then
    // declined would look, to the CLI, like a hook that hung.
    const guards = script.split("\n").filter((line) => line.startsWith("if ("))
    expect(guards[0]).toContain("ADE_SPAWN_NONCE")
    expect(script).toContain("ADE_PANE_ID")
    expect(script).toContain("ADE_SESSION_DIR")
  })

  test("refuses an event that is not a session start or a turn", () => {
    expect(script).toContain('$event -ne "SessionStart"')
  })

  test("a turn starting or ending is written beside the report, not over it", () => {
    expect(script).toContain('$event -eq "UserPromptSubmit" -or $event -eq "Stop"')
    expect(script).toContain('("$env:ADE_SPAWN_NONCE" + ".activity")')
  })

  test("refuses a nested codex thread reporting its parent's id", () => {
    expect(script).toContain("CODEX_THREAD_ID")
  })

  test("stages the file and moves it, so nobody reads half a report", () => {
    expect(script).toContain('$staging = $target + ".part"')
    expect(script).toContain("Move-Item -LiteralPath $staging")
  })

  test("names the drop after the nonce", () => {
    expect(script).toContain('Join-Path $env:ADE_SESSION_DIR ("$env:ADE_SPAWN_NONCE" + ".json")')
  })

  test("reports the agent it was installed for", () => {
    expect(script).toContain('agent     = "codex"')
    expect(hookScript("claude")).toContain('agent     = "claude"')
  })

  test("says who owns the file, since it sits in the user's config", () => {
    expect(script.startsWith(`# installed by ADE — ${HOOK_MARKER}`)).toBe(true)
  })
})

describe("activity events", () => {
  const events = ["UserPromptSubmit", "Stop"]
  const command = hookCommand(CLAUDE_SCRIPT)

  test("claude-code asks for them, codex does not", () => {
    expect(hookTarget("claude-code")?.activityEvents).toEqual(events)
    expect(hookTarget("codex")?.activityEvents).toBeUndefined()
  })

  test("installed beside everyone else's, once each, and removed with the rest", () => {
    const installed = installHook(CLAUDE, command, "startup|resume|clear", events)
    const hooks = JSON.parse(installed).hooks
    expect(hooks.Stop).toEqual([{ hooks: [{ type: "command", command, timeout: 5 }] }])
    expect(hooks.UserPromptSubmit).toHaveLength(1)
    expect(hooks.PostToolUse).toEqual(JSON.parse(CLAUDE).hooks.PostToolUse)
    expect(missingActivityEvents(installed, events)).toEqual([])
    const twice = installHook(installed, command, "startup|resume|clear", events)
    expect(JSON.parse(twice).hooks.Stop).toHaveLength(1)
    expect(JSON.parse(removeHook(twice)).hooks.Stop).toBeUndefined()
  })

  test("an install from before them is found missing", () => {
    const old = installHook(CLAUDE, command, "startup|resume|clear")
    expect(missingActivityEvents(old, events)).toEqual(events)
  })
})
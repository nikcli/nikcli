import { describe, expect, test } from "bun:test"
import { createAdeVoiceHost, type AdeVoiceHostDeps } from "./host"
import { AGENTS } from "../session-new/agents"
import { createWorkbench, type Pane, type Workbench } from "../surface/state"
import type { PermissionAnswer, PermissionRequest } from "../session/permission"
import type { Project } from "../host/project"

function createMockDeps(overrides: Partial<AdeVoiceHostDeps> = {}): {
  deps: AdeVoiceHostDeps
  written: Record<string, string[]>
  appendedLines: { paneId: string; text: string; kind?: string }[]
  commandsRun: string[]
  permissionsAnswered: { paneId: string; answer: PermissionAnswer }[]
  currentWb: () => Workbench
} {
  let wbState: Workbench = createWorkbench()
  let projectState: Project | undefined = undefined
  let permissionsState: Record<string, PermissionRequest> = {}
  const runningSessions = new Map<string, { write: (line: string) => void; kill?: () => void }>()
  const written: Record<string, string[]> = {}
  const appendedLines: { paneId: string; text: string; kind?: string }[] = []
  const commandsRun: string[] = []
  const permissionsAnswered: { paneId: string; answer: PermissionAnswer }[] = []

  const deps: AdeVoiceHostDeps = {
    wb: () => wbState,
    setWb: (updater) => {
      wbState = updater(wbState)
    },
    project: () => projectState,
    runCommand: async (id) => {
      commandsRun.push(id)
    },
    isRunning: (id) => runningSessions.has(id),
    getRunningSession: (id) => runningSessions.get(id),
    openFile: async () => {},
    appendLine: (paneId, text, kind) => {
      appendedLines.push({ paneId, text, kind })
    },
    permissions: () => permissionsState,
    answerPermission: (paneId, answer) => {
      permissionsAnswered.push({ paneId, answer })
      delete permissionsState[paneId]
    },
    ...overrides,
  }

  return {
    deps,
    written,
    appendedLines,
    commandsRun,
    permissionsAnswered,
    currentWb: () => wbState,
  }
}

function makePane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "p1",
    title: "Session 1",
    status: "working",
    model: "test-agent",
    mode: "auto",
    lines: [],
    workspaceId: "ws1",
    ...overrides,
  }
}

describe("createAdeVoiceHost", () => {
  test("a command that opens a pane brings the Code view up; one that does not leaves the view alone", async () => {
    const { deps, commandsRun, currentWb } = createMockDeps()
    deps.setWb((w) => ({ ...w, view: "agent" }))
    const host = createAdeVoiceHost(deps)

    await host.runCommand("decisions.open")
    expect(currentWb().view).toBe("agent")
    await host.runCommand("app.new")
    expect(currentWb().view).toBe("code")
    expect(commandsRun).toEqual(["decisions.open", "app.new"])
  })

  test("listPanes produces 1-based indices and consistent flags", () => {
    const { deps, currentWb } = createMockDeps()
    deps.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "p1", title: "Session", status: "working" }),
        makePane({ id: "p2", title: "Browser", status: "done", browserUrl: "http://localhost:3000" }),
        makePane({ id: "p3", title: "File", status: "done", filePath: "/path/to/file.ts" }),
      ],
    }))

    // Mark p1 as running in fake deps
    const liveDeps: AdeVoiceHostDeps = {
      ...deps,
      isRunning: (id) => id === "p1",
    }

    const host = createAdeVoiceHost(liveDeps)
    const panes = host.listPanes()

    expect(panes).toHaveLength(3)

    expect(panes[0]).toEqual({
      id: "p1",
      title: "Session",
      status: "working",
      index: 1,
      hasLiveProcess: true,
      isBrowser: false,
      isFile: false,
    })

    expect(panes[1]).toEqual({
      id: "p2",
      title: "Browser",
      status: "done",
      index: 2,
      hasLiveProcess: false,
      isBrowser: true,
      isFile: false,
    })

    expect(panes[2]).toEqual({
      id: "p3",
      title: "File",
      status: "done",
      index: 3,
      hasLiveProcess: false,
      isBrowser: false,
      isFile: true,
    })
  })

  test("sendPrompt rejects with a descriptive message on pane without live process", async () => {
    const { deps } = createMockDeps({
      isRunning: () => false,
    })
    const host = createAdeVoiceHost(deps)

    expect(host.sendPrompt("p-dead", "ciao agente")).rejects.toThrow(
      "Il pannello 'p-dead' non ha un processo vivo",
    )
  })

  test("sendPrompt writes one submitted line and shows what it sent", async () => {
    const writtenLines: string[] = []
    const session = {
      write: (line: string) => writtenLines.push(line),
    }

    const { deps, appendedLines } = createMockDeps({
      isRunning: (id) => id === "p1",
      getRunningSession: (id) => (id === "p1" ? session : undefined),
    })
    const host = createAdeVoiceHost(deps)

    await host.sendPrompt("p1", "prima riga\nseconda riga")

    /*
     * Terminated, because the transcript below already claims it was sent.
     * Without the terminator the words sat unread in the agent's input line
     * while the user watched their own message appear and waited.
     */
    expect(writtenLines).toEqual([`prima riga seconda riga${String.fromCharCode(13)}`])
    // And the transcript shows the whole message, not only its first line:
    // half a dictated sentence is a confusing thing to be shown as sent.
    expect(appendedLines).toHaveLength(1)
    expect(appendedLines[0].text).toBe("> prima riga seconda riga")
  })

  test("sendPrompt cannot be made to submit twice", async () => {
    const writtenLines: string[] = []
    const session = { write: (line: string) => writtenLines.push(line) }
    const { deps } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => session,
    })
    const host = createAdeVoiceHost(deps)

    const CR = String.fromCharCode(13)
    await host.sendPrompt("p1", `innocuo${CR}git push --force`)

    expect(writtenLines[0].split(CR).length - 1).toBe(1)
  })

  /*
   * Dictation has to survive a pane that has no composer.
   *
   * The composer only exists under panes with no live terminal now — under a
   * running session it was a second keyboard writing to the same pty, costing
   * every tile a row of terminal. `insertText` used to look for that textarea
   * and throw when it was absent, which is every running agent: transcription
   * mode, whose default send is "manual", would have failed on exactly the
   * panes it is for.
   */
  test("insertText reaches the terminal when the pane has no composer", async () => {
    const writtenLines: string[] = []
    const session = { write: (line: string) => writtenLines.push(line) }
    const { deps } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => session,
    })
    const host = createAdeVoiceHost(deps)

    await host.insertText("p1", "crea un componente")

    // Inserted, not submitted: no carriage return anywhere in what was written.
    expect(writtenLines).toEqual(["crea un componente "])
    expect(writtenLines[0]).not.toContain(String.fromCharCode(13))
  })

  test("insertText refuses rather than guessing when the pane can receive nothing", async () => {
    const { deps } = createMockDeps({
      isRunning: () => false,
      getRunningSession: () => undefined,
    })
    const host = createAdeVoiceHost(deps)

    expect(host.insertText("p1", "ciao")).rejects.toThrow(
      "Il pannello selezionato non ha dove ricevere il testo.",
    )
  })

  test("insertText never lets a dictated newline submit the line", async () => {
    const writtenLines: string[] = []
    const session = { write: (line: string) => writtenLines.push(line) }
    const { deps } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => session,
    })
    const host = createAdeVoiceHost(deps)

    const CR = String.fromCharCode(13)
    await host.insertText("p1", `innocuo${CR}git push --force`)

    expect(writtenLines[0]).not.toContain(CR)
    expect(writtenLines[0]).toBe("innocuo git push --force ")
  })

  test("answerPermission does nothing when no permission is pending", () => {
    let answered = false
    const { deps } = createMockDeps({
      permissions: () => ({}),
      answerPermission: () => {
        answered = true
      },
    })
    const host = createAdeVoiceHost(deps)

    // `false` is what lets the voice say so instead of «Permesso concesso».
    expect(host.answerPermission("p1", "allow")).toBe(false)
    expect(answered).toBe(false)

    expect(host.answerPermission("p1", "deny")).toBe(false)
    expect(answered).toBe(false)
  })

  test("answerPermission picks correct allow/deny answer when pending", () => {
    const answered: PermissionAnswer[] = []
    const pendingRequest: PermissionRequest = {
      what: "run command",
      kind: "shell",
      answers: [
        { label: "Sì", send: "y", tone: "primary" },
        { label: "No", send: "n", tone: "secondary" },
      ],
    }

    const { deps } = createMockDeps({
      permissions: () => ({ p1: pendingRequest }),
      answerPermission: (_id, ans) => {
        answered.push(ans)
      },
    })
    const host = createAdeVoiceHost(deps)

    expect(host.answerPermission("p1", "allow")).toBe(true)
    expect(answered).toHaveLength(1)
    expect(answered[0].send).toBe("y")

    host.answerPermission("p1", "deny")
    expect(answered).toHaveLength(2)
    expect(answered[1].send).toBe("n")
  })

  /*
   * The one failure this path must not have. "Deny" used to fall back to the
   * second option, whatever it was — so on a question whose options are
   * "Allow once" and "Allow always", saying "nega" out loud granted the
   * permission permanently, by voice, with no confirmation.
   */
  describe("a spoken refusal can never grant", () => {
    const permissive: PermissionRequest = {
      what: "Bash command",
      kind: "shell",
      answers: [
        { label: "Consenti una volta", send: "1", tone: "primary" },
        { label: "Sì, e non chiedere più", send: "2", tone: "secondary" },
      ],
    }

    test("nothing is sent when no answer is a refusal", () => {
      const answered: PermissionAnswer[] = []
      const { deps, appendedLines } = createMockDeps({
        permissions: () => ({ p1: permissive }),
        answerPermission: (_id, ans) => {
          answered.push(ans)
        },
      })

      createAdeVoiceHost(deps).answerPermission("p1", "deny")

      expect(answered).toHaveLength(0)
      // And the user is told, so the request does not simply appear ignored.
      expect(appendedLines.some((line) => line.text.includes("rifiuto"))).toBe(true)
    })

    test("a refusal is still found when one is offered third", () => {
      const answered: PermissionAnswer[] = []
      const { deps } = createMockDeps({
        permissions: () => ({
          p1: {
            ...permissive,
            answers: [...permissive.answers, { label: "No", send: "3", tone: "secondary" as const }],
          },
        }),
        answerPermission: (_id, ans) => {
          answered.push(ans)
        },
      })

      createAdeVoiceHost(deps).answerPermission("p1", "deny")

      expect(answered).toHaveLength(1)
      expect(answered[0].send).toBe("3")
    })

    test("allow still works on an all-permissive question", () => {
      const answered: PermissionAnswer[] = []
      const { deps } = createMockDeps({
        permissions: () => ({ p1: permissive }),
        answerPermission: (_id, ans) => {
          answered.push(ans)
        },
      })

      createAdeVoiceHost(deps).answerPermission("p1", "allow")

      expect(answered).toHaveLength(1)
      expect(answered[0].send).toBe("1")
    })
  })

  test("describeState counts sessions, not panels: video, 3D, simulator, file, browser and plugin tiles do not count", () => {
    const { deps } = createMockDeps()
    deps.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "p1", status: "working" }),
        // An empty player: no path yet, so only its mode says what it is.
        makePane({ id: "p2", status: "done", mode: "video", videoPath: "" }),
        makePane({ id: "p3", status: "done", modelPath: "/m.glb" }),
        makePane({ id: "p4", status: "done", appUrl: "http://localhost:5173" }),
        makePane({ id: "p5", status: "done", filePath: "/src/index.ts" }),
        makePane({ id: "p6", status: "done", browserUrl: "http://localhost:3000" }),
        makePane({ id: "p7", status: "done", plugin: { pluginId: "x", name: "Tile" } }),
        // A panel is known by its mode as well: Decisioni has no path at all,
        // and its status is the session's «working» until it is answered.
        makePane({ id: "p8", status: "working", mode: "decisions" }),
        makePane({ id: "p9", status: "working", mode: "app" }),
      ],
    }))
    const state = createAdeVoiceHost(deps).describeState()
    expect(state.totalSessions).toBe(1)
    expect(state.workingSessions).toBe(1)
    expect(state.spokenSummary.toLowerCase()).toContain("una sessione")
  })

  test("describeState produces correct Italian grammatical number for 0, 1 and 3 sessions", () => {
    // 0 sessions
    const { deps: deps0 } = createMockDeps()
    const host0 = createAdeVoiceHost(deps0)
    const state0 = host0.describeState()
    expect(state0.totalSessions).toBe(0)
    expect(state0.spokenSummary.toLowerCase()).toContain("nessuna sessione")

    // 1 session
    const { deps: deps1 } = createMockDeps()
    deps1.setWb((w) => ({
      ...w,
      panes: [makePane({ id: "p1", status: "working" })],
    }))
    const host1 = createAdeVoiceHost(deps1)
    const state1 = host1.describeState()
    expect(state1.totalSessions).toBe(1)
    expect(state1.spokenSummary.toLowerCase()).toContain("una sessione")
    expect(state1.spokenSummary).toContain("in esecuzione")

    // 3 sessions
    const { deps: deps3 } = createMockDeps()
    deps3.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "p1", status: "working" }),
        makePane({ id: "p2", status: "waiting" }),
        makePane({ id: "p3", status: "done" }),
      ],
    }))
    const host3 = createAdeVoiceHost(deps3)
    const state3 = host3.describeState()
    expect(state3.totalSessions).toBe(3)
    expect(state3.spokenSummary.toLowerCase()).toContain("tre sessioni")
    expect(state3.spokenSummary).toContain("in esecuzione")
    expect(state3.spokenSummary).toContain("in attesa")
    expect(state3.spokenSummary).toContain("completata")
  })

  test("focusPane and browserNavigate update workbench state", () => {
    const { deps, currentWb } = createMockDeps()
    deps.setWb((w) => ({
      ...w,
      panes: [makePane({ id: "b1", browserUrl: "http://localhost:3000" })],
    }))
    const host = createAdeVoiceHost(deps)

    host.focusPane("b1")
    expect(currentWb().focusedId).toBe("b1")

    host.browserNavigate("b1", "http://localhost:5173")
    expect(currentWb().panes[0].browserUrl).toBe("http://localhost:5173")
  })
})

/**
 * The three capabilities a spoken plan needs before it can act: what can be
 * started, where, and starting one.
 *
 * The pane itself is made by the workbench — a `.tsx` no test can import — so
 * `openAgentSession` is faked here with a counter. What is under test is the
 * part that lives in this module: which agent id was resolved, which project
 * was switched to, and that each call carries its own task.
 */
describe("createAdeVoiceHost, spoken planning", () => {
  const nikcli: Project = { root: "C:/Users/x/nikcli", name: "nikcli", git: true }

  function planningDeps(overrides: Partial<AdeVoiceHostDeps> = {}) {
    const started: { agentId: string; task: string }[] = []
    const switched: string[] = []
    let opened = 0

    const { deps } = createMockDeps({
      openAgentSession: (input) => {
        started.push(input)
        opened += 1
        return { paneId: `voice-${opened}`, title: input.task || `Sessione ${opened}` }
      },
      switchProject: async (root) => {
        switched.push(root)
      },
      ...overrides,
    })

    return { deps, started, switched }
  }

  test("listAgents lists the whole catalogue, not a subset", () => {
    const { deps } = planningDeps()
    const agents = createAdeVoiceHost(deps).listAgents!()

    expect(agents).toHaveLength(AGENTS.length)
    expect(agents.find((a) => a.id === "claude-code")?.label).toBe("Claude Code")
  })

  test("listAgents reports an agent the probe did not find as unavailable", () => {
    const { deps } = planningDeps({
      agentAvailability: () =>
        AGENTS.map((agent) => ({
          agent,
          availability: agent.id === "codex" ? ("assente" as const) : ("presente" as const),
        })),
    })

    const agents = createAdeVoiceHost(deps).listAgents!()

    expect(agents.find((a) => a.id === "codex")?.available).toBe(false)
    expect(agents.find((a) => a.id === "claude-code")?.available).toBe(true)
  })

  /*
   * A probe that has not answered yet must never read as "not installed": the
   * user would be told to install an agent they already have.
   */
  test("listAgents calls every agent available while availability is unknown", () => {
    const { deps } = planningDeps({ agentAvailability: () => undefined })
    const agents = createAdeVoiceHost(deps).listAgents!()

    expect(agents.every((a) => a.available)).toBe(true)
  })

  test("listProjects marks only the open project, and dedupes it from the recents", () => {
    const { deps } = planningDeps({
      project: () => nikcli,
      // The same directory as the open one, spelled the way a shell spells it.
      recents: () => [
        { root: "C:\\Users\\x\\nikcli", name: "nikcli", openedAt: 2 },
        { root: "C:/Users/x/altro", name: "altro", openedAt: 1 },
      ],
    })

    const projects = createAdeVoiceHost(deps).listProjects!()

    expect(projects.map((p) => p.name)).toEqual(["nikcli", "altro"])
    expect(projects.map((p) => p.isOpen)).toEqual([true, false])
  })

  test("startSession resolves a spoken agent name and returns the pane it made", async () => {
    const { deps, started } = planningDeps({ project: () => nikcli })

    const pane = await createAdeVoiceHost(deps).startSession!({
      agent: "Claude",
      task: "sistema il parser",
    })

    expect(started).toEqual([{ agentId: "claude-code", task: "sistema il parser" }])
    expect(pane.paneId).toBe("voice-1")
    expect(pane.title).toBe("sistema il parser")
  })

  /*
   * «avvia 4 sessioni claude, una sul parser, una sui test» è il caso che ha
   * fatto nascere questa capability: quattro chiamate, quattro compiti
   * diversi, quattro pannelli distinti a cui poter parlare dopo.
   */
  test("four calls produce four panes with four different tasks", async () => {
    const { deps, started } = planningDeps({ project: () => nikcli })
    const host = createAdeVoiceHost(deps)

    const tasks = ["il parser", "i test", "la documentazione", "le prestazioni"]
    const panes = await Promise.all(tasks.map((task) => host.startSession!({ agent: "claude", task })))

    expect(started.map((s) => s.task)).toEqual(tasks)
    expect(new Set(panes.map((p) => p.paneId)).size).toBe(4)
    expect(panes.map((p) => p.title)).toEqual(tasks)
  })

  test("startSession refuses an agent that does not exist, and opens nothing", async () => {
    const { deps, started } = planningDeps({ project: () => nikcli })

    await expect(
      createAdeVoiceHost(deps).startSession!({ agent: "copilot", task: "qualsiasi cosa" }),
    ).rejects.toThrow(/Non conosco l'agente «copilot»/)
    expect(started).toHaveLength(0)
  })

  test("startSession switches project first when the task names another one", async () => {
    const { deps, started, switched } = planningDeps({
      project: () => nikcli,
      recents: () => [{ root: "C:/Users/x/altro", name: "altro", openedAt: 1 }],
    })

    await createAdeVoiceHost(deps).startSession!({
      agent: "codex",
      task: "i test",
      project: "Altro",
    })

    expect(switched).toEqual(["C:/Users/x/altro"])
    expect(started).toEqual([{ agentId: "codex", task: "i test" }])
  })

  test("startSession does not switch when the named project is the open one", async () => {
    const { deps, switched } = planningDeps({
      project: () => nikcli,
      recents: () => [{ root: "C:\\Users\\x\\nikcli", name: "nikcli", openedAt: 1 }],
    })

    await createAdeVoiceHost(deps).startSession!({ agent: "claude", project: "nikcli" })

    expect(switched).toEqual([])
  })

  test("startSession refuses an unknown project without opening or switching anything", async () => {
    const { deps, started, switched } = planningDeps({
      project: () => nikcli,
      recents: () => [{ root: "C:/Users/x/altro", name: "altro", openedAt: 1 }],
    })

    await expect(
      createAdeVoiceHost(deps).startSession!({ agent: "claude", project: "contabilità" }),
    ).rejects.toThrow(/Non conosco il progetto/)
    expect(switched).toEqual([])
    expect(started).toHaveLength(0)
  })

  /*
   * Senza progetto aperto `startProcess` rinuncia in silenzio: il pannello
   * resta su «Inizializzazione» e l'assistente direbbe che è partito.
   */
  test("startSession asks which project instead of opening a pane that cannot start", async () => {
    const { deps, started } = planningDeps({ project: () => undefined })

    await expect(
      createAdeVoiceHost(deps).startSession!({ agent: "claude", task: "i test" }),
    ).rejects.toThrow(/nessun progetto aperto/)
    expect(started).toHaveLength(0)
  })

  test("startSession says so instead of pretending when the host cannot open sessions", async () => {
    const { deps } = createMockDeps({ project: () => nikcli })

    await expect(
      createAdeVoiceHost(deps).startSession!({ agent: "claude" }),
    ).rejects.toThrow("Non posso avviare sessioni da qui.")
  })
})

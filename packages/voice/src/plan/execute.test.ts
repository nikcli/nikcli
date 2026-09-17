import { describe, expect, test } from "bun:test"
import { announceExecution, executePlan } from "./execute"
import type { PlanStep } from "./schema"
import type { PaneSummary, VoiceHost } from "../bridge/host"

function pane(id: string, index: number): PaneSummary {
  return {
    id,
    title: id,
    status: "working",
    index,
    hasLiveProcess: true,
    isBrowser: false,
    isFile: false,
  }
}

function fakeHost(overrides: Partial<VoiceHost> = {}) {
  const calls: string[] = []
  const panes: PaneSummary[] = [pane("p1", 1)]
  let created = 0

  const host = {
    async runCommand(id: string) {
      calls.push(`runCommand:${id}`)
    },
    listPanes: () => panes,
    focusPane(paneId: string) {
      calls.push(`focusPane:${paneId}`)
    },
    async sendPrompt(paneId: string, text: string) {
      calls.push(`sendPrompt:${paneId}:${text}`)
    },
    async startSession(input: { agent: string; task?: string }) {
      created += 1
      const id = `new${created}`
      panes.push(pane(id, panes.length + 1))
      calls.push(`startSession:${input.agent}:${input.task ?? ""}`)
      return { paneId: id, title: id }
    },
    async insertText() {},
    async openFile() {},
    async searchProject() {
      return []
    },
    setPaneView() {},
    browserNavigate() {},
    answerPermission() {},
    setColumns() {},
    setView() {},
    scrollTranscript() {},
    describeState: () => ({
      totalSessions: panes.length,
      workingSessions: 0,
      waitingSessions: 0,
      doneSessions: 0,
      errorSessions: 0,
      currentView: "code" as const,
      spokenSummary: "",
    }),
    ...overrides,
  } as VoiceHost

  return { host, calls }
}

describe("executePlan", () => {
  test("avvia una sessione per ogni passo, ciascuna col suo compito", async () => {
    const { host, calls } = fakeHost()
    const steps: PlanStep[] = [
      { action: "start_session", agent: "claude-code", task: "il parser" },
      { action: "start_session", agent: "claude-code", task: "i test" },
    ]

    const result = await executePlan(steps, host)

    expect(result.done).toHaveLength(2)
    expect(result.openedPaneIds).toEqual(["new1", "new2"])
    expect(calls).toEqual(["startSession:claude-code:il parser", "startSession:claude-code:i test"])
  })

  /*
   * Quattro sessioni in cui la seconda fallisce devono essere tre sessioni e
   * una frase sulla quarta — non una sessione e silenzio.
   */
  test("un passo che fallisce non ferma i successivi", async () => {
    let attempt = 0
    const { host, calls } = fakeHost({
      async startSession(input: { agent: string; task?: string }) {
        attempt += 1
        if (attempt === 2) throw new Error("il binario non risponde")
        calls.push(`startSession:${input.agent}`)
        return { paneId: `p${attempt}`, title: "t" }
      },
    })

    const result = await executePlan(
      [
        { action: "start_session", agent: "claude-code" },
        { action: "start_session", agent: "claude-code" },
        { action: "start_session", agent: "claude-code" },
      ],
      host,
    )

    expect(result.done).toHaveLength(2)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain("il binario non risponde")
  })

  /*
   * Un piano che apre due sessioni e poi parla al «pannello tre» è corretto
   * solo dopo che quelle due esistono: l'indice va risolto al momento.
   */
  test("un indice di pannello si riferisce alla griglia com'è quando ci si arriva", async () => {
    const { host, calls } = fakeHost()

    await executePlan(
      [
        { action: "start_session", agent: "claude-code" },
        { action: "send_prompt", paneIndex: 2, text: "comincia" },
      ],
      host,
    )

    expect(calls).toContain("sendPrompt:new1:comincia")
  })

  test("un host che non sa avviare sessioni lo dice invece di fingere", async () => {
    const { host } = fakeHost({ startSession: undefined })
    const result = await executePlan([{ action: "start_session", agent: "claude-code" }], host)

    expect(result.done).toEqual([])
    expect(result.failures).toHaveLength(1)
  })

  test("un abort ferma i passi rimanenti", async () => {
    const controller = new AbortController()
    const { host } = fakeHost({
      async startSession() {
        controller.abort()
        return { paneId: "p", title: "t" }
      },
    })

    const result = await executePlan(
      [
        { action: "start_session", agent: "claude-code" },
        { action: "start_session", agent: "claude-code" },
      ],
      host,
      { signal: controller.signal },
    )

    expect(result.done).toHaveLength(1)
  })
})

describe("announceExecution", () => {
  const label = (id: string) => (id === "claude-code" ? "Claude Code" : id)

  test("conta le sessioni invece di elencarle", () => {
    const spoken = announceExecution({
      execution: {
        done: [
          { action: "start_session", agent: "claude-code" },
          { action: "start_session", agent: "claude-code" },
          { action: "start_session", agent: "claude-code" },
        ],
        failures: [],
        openedPaneIds: [],
      },
      refusals: [],
      agentLabel: label,
    })

    expect(spoken).toBe("Ho avviato 3 sessioni Claude Code.")
  })

  test("agenti diversi vengono detti separatamente", () => {
    const spoken = announceExecution({
      execution: {
        done: [
          { action: "start_session", agent: "claude-code" },
          { action: "start_session", agent: "codex" },
          { action: "start_session", agent: "codex" },
        ],
        failures: [],
        openedPaneIds: [],
      },
      refusals: [],
      agentLabel: label,
    })

    expect(spoken).toBe("Ho avviato una sessione Claude Code e 2 sessioni codex.")
  })

  /*
   * Il pezzo che conta quando qualcosa va storto: fatto e non fatto nella
   * stessa frase, perché un annuncio di successo parziale che tace la parte
   * mancante è peggio del silenzio.
   */
  test("dice sia quello che ha fatto sia quello che non ha fatto", () => {
    const spoken = announceExecution({
      execution: {
        done: [{ action: "start_session", agent: "claude-code" }],
        failures: ["Non sono riuscito ad avviare codex: manca il binario."],
        openedPaneIds: [],
      },
      refusals: ["Non conosco il progetto «pippo»."],
      agentLabel: label,
    })

    expect(spoken).toContain("Ho avviato una sessione Claude Code.")
    expect(spoken).toContain("pippo")
    expect(spoken).toContain("manca il binario")
  })

  test("un piano che non contiene niente lo dice", () => {
    expect(
      announceExecution({
        execution: { done: [], failures: [], openedPaneIds: [] },
        refusals: [],
      }),
    ).toBe("Non ho trovato niente da fare in quella frase.")
  })
})

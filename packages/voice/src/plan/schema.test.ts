import { describe, expect, test } from "bun:test"
import { MAX_PLAN_STEPS, PLANNABLE_COMMANDS, resolveAgent, validatePlan, type PlanContext } from "./schema"

const context: PlanContext = {
  agents: [
    { id: "claude-code", label: "Claude Code", available: true },
    { id: "codex", label: "Codex", available: true },
    { id: "gemini", label: "Gemini CLI", available: false },
  ],
  projects: [
    { name: "nikcli", root: "C:/Users/x/nikcli", isOpen: true },
    { name: "altro", root: "C:/Users/x/altro", isOpen: false },
  ],
  paneCount: 2,
  commands: ["palette.open", "session.new"],
}

describe("resolveAgent", () => {
  test("riconosce come lo dice una persona, non solo l'id esatto", () => {
    for (const spoken of ["claude", "Claude Code", "claude-code", "CLAUDE  CODE"]) {
      expect(resolveAgent(spoken, context.agents)?.id).toBe("claude-code")
    }
  })

  /*
   * Un prefisso che combacia con due agenti è un'ipotesi, non una risposta:
   * meglio dire «non ho capito» che avviare quello sbagliato.
   */
  test("un prefisso ambiguo non viene indovinato", () => {
    const agents = [
      { id: "claude-code", label: "Claude Code", available: true },
      { id: "claude-next", label: "Claude Next", available: true },
    ]
    expect(resolveAgent("claude", agents)).toBeUndefined()
  })

  test("un agente inesistente resta inesistente", () => {
    expect(resolveAgent("copilot", context.agents)).toBeUndefined()
  })
})

describe("validatePlan", () => {
  test("quattro sessioni con quattro compiti diversi restano quattro", () => {
    const plan = validatePlan(
      [
        { action: "start_session", agent: "claude", task: "il parser" },
        { action: "start_session", agent: "claude", task: "i test" },
        { action: "start_session", agent: "claude", task: "la documentazione" },
        { action: "start_session", agent: "claude", task: "la build" },
      ],
      context,
    )

    expect(plan.refusals).toEqual([])
    expect(plan.steps).toHaveLength(4)
    expect(plan.steps.map((s) => (s.action === "start_session" ? s.task : undefined))).toEqual([
      "il parser",
      "i test",
      "la documentazione",
      "la build",
    ])
    // L'id risolto, non la parola detta: è quello che l'host sa avviare.
    expect(plan.steps.every((s) => s.action === "start_session" && s.agent === "claude-code")).toBe(true)
  })

  /*
   * «Quattro» e «quaranta» sono una vocale di distanza, e quaranta sessioni
   * di agente sono soldi veri e una macchina in ginocchio.
   */
  test("un numero frainteso non apre quaranta sessioni", () => {
    const plan = validatePlan(
      Array.from({ length: 40 }, () => ({ action: "start_session", agent: "claude" })),
      context,
    )

    expect(plan.steps).toHaveLength(MAX_PLAN_STEPS)
    expect(plan.refusals.join(" ")).toContain(String(MAX_PLAN_STEPS))
  })

  /*
   * Nessuna operazione distruttiva esiste in questo vocabolario: non è una
   * guardia che si può aggirare convincendo il modello, è assenza.
   */
  test("chiudere e terminare non sono operazioni che un piano possa contenere", () => {
    const plan = validatePlan(
      [
        { action: "close_pane", paneIndex: 1 },
        { action: "kill_process", paneIndex: 2 },
      ],
      context,
    )

    expect(plan.steps).toEqual([])
    expect(plan.refusals).toHaveLength(2)
  })

  test("un agente non installato viene rifiutato dicendo quale", () => {
    const plan = validatePlan([{ action: "start_session", agent: "gemini" }], context)
    expect(plan.steps).toEqual([])
    expect(plan.refusals[0]).toContain("Gemini CLI")
  })

  test("un agente inventato viene rifiutato elencando quelli veri", () => {
    const plan = validatePlan([{ action: "start_session", agent: "copilot" }], context)
    expect(plan.steps).toEqual([])
    expect(plan.refusals[0]).toContain("copilot")
    expect(plan.refusals[0]).toContain("Claude Code")
  })

  test("un progetto sconosciuto ferma il passo, non tutto il piano", () => {
    const plan = validatePlan(
      [
        { action: "start_session", agent: "claude", project: "pippo" },
        { action: "start_session", agent: "codex" },
      ],
      context,
    )

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({ agent: "codex" })
    expect(plan.refusals[0]).toContain("pippo")
  })

  test("il progetto viene passato come radice, non come nome detto", () => {
    const plan = validatePlan([{ action: "start_session", agent: "codex", project: "nikcli" }], context)
    expect(plan.steps[0]).toMatchObject({ project: "C:/Users/x/nikcli" })
  })

  test("un indice di pannello fuori intervallo viene rifiutato con il conteggio vero", () => {
    const plan = validatePlan([{ action: "send_prompt", paneIndex: 7, text: "ciao" }], context)
    expect(plan.steps).toEqual([])
    expect(plan.refusals[0]).toContain("2")
  })

  test("un comando inventato non viene eseguito", () => {
    const plan = validatePlan([{ action: "run_command", command: "system.wipe" }], context)
    expect(plan.steps).toEqual([])
    expect(plan.refusals[0]).toContain("system.wipe")
  })

  /*
   * Senza questo il divieto sui passi distruttivi sarebbe una finzione: non
   * esiste un passo «chiudi pannello», ma `run_command` arriverebbe allo
   * stesso posto passando per l'id del comando.
   */
  test("nessun comando distruttivo è pianificabile", () => {
    for (const command of ["pane.close", "process.kill"]) {
      expect(PLANNABLE_COMMANDS).not.toContain(command)
      const plan = validatePlan([{ action: "run_command", command }], {
        ...context,
        commands: PLANNABLE_COMMANDS,
      })
      expect(plan.steps).toEqual([])
      expect(plan.refusals[0]).toContain(command)
    }
  })

  test("accetta sia l'array nudo sia { steps: [...] }", () => {
    const bare = validatePlan([{ action: "run_command", command: "palette.open" }], context)
    const wrapped = validatePlan({ steps: [{ action: "run_command", command: "palette.open" }] }, context)
    expect(bare.steps).toEqual(wrapped.steps)
  })

  test("una risposta che non è un piano non diventa un piano vuoto silenzioso", () => {
    const plan = validatePlan("mi dispiace, non posso aiutarti", context)
    expect(plan.steps).toEqual([])
    expect(plan.refusals).toHaveLength(1)
  })
})

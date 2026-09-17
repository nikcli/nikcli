import { describe, expect, test } from "bun:test"
import { buildPlannerPrompt, extractJson, planUtterance } from "./planner"
import type { PlanContext } from "./schema"

const context: PlanContext = {
  agents: [
    { id: "claude-code", label: "Claude Code", available: true },
    { id: "codex", label: "Codex", available: false },
  ],
  projects: [{ name: "nikcli", root: "C:/Users/x/nikcli", isOpen: true }],
  paneCount: 1,
  commands: ["palette.open"],
}

describe("buildPlannerPrompt", () => {
  /*
   * Senza il catalogo vero il modello inventa id plausibili, e il piano viene
   * poi rifiutato per un errore che nessuno gli aveva dato modo di evitare.
   */
  test("dice al modello cosa esiste davvero su questa macchina", () => {
    const { system } = buildPlannerPrompt("avvia due sessioni", context)

    expect(system).toContain("claude-code")
    expect(system).toContain("nikcli")
    expect(system).toContain("palette.open")
    // E cosa NON esiste, altrimenti lo propone e basta.
    expect(system).toContain("NON installato")
  })

  test("la frase dell'utente non viene riscritta", () => {
    const { user } = buildPlannerPrompt("avvia 4 sessioni claude", context)
    expect(user).toBe("avvia 4 sessioni claude")
  })
})

describe("extractJson", () => {
  test("legge il JSON nudo", () => {
    expect(extractJson('[{"action":"run_command","command":"palette.open"}]')).toHaveLength(1)
  })

  /*
   * Istruito a rispondere nudo, un modello incornicia comunque abbastanza
   * spesso da rendere il rifiuto una funzione che sembra rotta all'utente.
   */
  test("legge il JSON dentro un blocco di codice", () => {
    expect(extractJson('```json\n[{"action":"focus_pane","paneIndex":1}]\n```')).toHaveLength(1)
  })

  test("legge il JSON preceduto da una frase", () => {
    expect(extractJson('Certo, ecco:\n[{"action":"focus_pane","paneIndex":1}]')).toHaveLength(1)
  })

  test("una risposta senza JSON resta senza JSON", () => {
    expect(extractJson("mi dispiace, non ho capito")).toBeUndefined()
  })
})

describe("planUtterance", () => {
  test("una frase composta diventa un piano validato", async () => {
    const result = await planUtterance("avvia due sessioni claude, una sul parser e una sui test", context, async () =>
      JSON.stringify([
        { action: "start_session", agent: "claude", task: "il parser" },
        { action: "start_session", agent: "claude", task: "i test" },
      ]),
    )

    expect(result.failure).toBeUndefined()
    expect(result.steps).toHaveLength(2)
    expect(result.refusals).toEqual([])
  })

  /*
   * Un array vuoto è il modello che dice «questa frase non chiede niente»,
   * ed è una risposta valida: trattarla come errore trasformerebbe ogni
   * parola captata per sbaglio dal microfono in un messaggio di errore.
   */
  test("«niente da fare» non è un guasto", async () => {
    const result = await planUtterance("mm, vediamo", context, async () => "[]")
    expect(result.failure).toBeUndefined()
    expect(result.steps).toEqual([])
    expect(result.refusals).toEqual([])
  })

  test("una chiamata che esplode diventa qualcosa da dire, non un'eccezione", async () => {
    const result = await planUtterance("qualsiasi cosa", context, async () => {
      throw new Error("Manca la chiave OpenRouter")
    })

    expect(result.steps).toEqual([])
    expect(result.failure).toContain("chiave OpenRouter")
  })

  test("una risposta illeggibile viene detta, non ignorata", async () => {
    const result = await planUtterance("qualsiasi cosa", context, async () => "boh")
    expect(result.failure).toBeDefined()
  })

  test("il piano passa comunque dalla validazione: agente inventato, zero passi", async () => {
    const result = await planUtterance("avvia copilot", context, async () =>
      JSON.stringify([{ action: "start_session", agent: "copilot" }]),
    )

    expect(result.steps).toEqual([])
    expect(result.refusals[0]).toContain("copilot")
  })

  test("supporta una risposta puramente conversazionale di Jarvis con speech", async () => {
    const result = await planUtterance("chi sei e cosa puoi fare per me?", context, async () =>
      JSON.stringify({
        speech: "Sono Jarvis, il tuo assistente vocale in ADE. Posso avviare sessioni e guidarti nel codice.",
        steps: [],
      }),
    )

    expect(result.failure).toBeUndefined()
    expect(result.steps).toEqual([])
    expect(result.refusals).toEqual([])
    expect(result.speech).toBe(
      "Sono Jarvis, il tuo assistente vocale in ADE. Posso avviare sessioni e guidarti nel codice.",
    )
  })

  test("supporta risposta combinata con speech e steps", async () => {
    const result = await planUtterance("avvia claude sul parser", context, async () =>
      JSON.stringify({
        speech: "Subito Nik, avvio la sessione Claude Code per analizzare il parser.",
        steps: [{ action: "start_session", agent: "claude", task: "analizza il parser" }],
      }),
    )

    expect(result.failure).toBeUndefined()
    expect(result.steps).toHaveLength(1)
    expect(result.speech).toBe("Subito Nik, avvio la sessione Claude Code per analizzare il parser.")
  })

  test("buildPlannerPrompt include la cronologia dei turni precedenti quando fornita", () => {
    const multiTurnContext: PlanContext = {
      ...context,
      recentHistory: [
        { role: "user", text: "avvia claude sul parser" },
        { role: "assistant", text: "Sessione Claude avviata." },
      ],
    }
    const { system } = buildPlannerPrompt("ora chiedigli di eseguire i test", multiTurnContext)
    expect(system).toContain("Cronologia recente della conversazione")
    expect(system).toContain("avvia claude sul parser")
    expect(system).toContain("Sessione Claude avviata.")
  })
})

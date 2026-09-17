import { describe, expect, test } from "bun:test"
import { createVoiceEngine } from "../engine"
import { createFakeTranscriber } from "../asr/fake"
import { createFakeSpeaker } from "../tts/speaker"
import type { PaneSummary, VoiceHost, VoiceStateSnapshot } from "../bridge/host"

/*
 * Il percorso completo, senza rete: frase detta → grammatica che non la
 * riconosce → pianificatore → sessioni avviate → annuncio a voce.
 *
 * Nasce da una frase precisa dell'utente, «avvia 4 sessioni claude in tale
 * progetto, 1 riguardante questo ecc...», che era esattamente ciò che il
 * vocabolario a frasi fisse non poteva rappresentare: conteggio, agente,
 * progetto e un compito libero per sessione sono quattro dimensioni aperte
 * nella stessa frase.
 */

class PlanningHost implements VoiceHost {
  started: { agent: string; task?: string; project?: string }[] = []
  panes: PaneSummary[] = []

  async runCommand(): Promise<void> {}
  listPanes(): PaneSummary[] {
    return this.panes
  }
  listAgents() {
    return [
      { id: "claude-code", label: "Claude Code", available: true },
      { id: "codex", label: "Codex", available: true },
    ]
  }
  listProjects() {
    return [{ name: "nikcli", root: "C:/Users/x/nikcli", isOpen: true }]
  }
  async startSession(input: { agent: string; task?: string; project?: string }) {
    this.started.push(input)
    const id = `pane-${this.started.length}`
    this.panes.push({
      id,
      title: input.task ?? input.agent,
      status: "working",
      index: this.panes.length + 1,
      hasLiveProcess: true,
      isBrowser: false,
      isFile: false,
    })
    return { paneId: id, title: id }
  }
  focusPane(): void {}
  async sendPrompt(): Promise<void> {}
  async insertText(): Promise<void> {}
  async openFile(): Promise<void> {}
  async searchProject() {
    return []
  }
  setPaneView(): void {}
  browserNavigate(): void {}
  answerPermission(): void {}
  setColumns(): void {}
  setView(): void {}
  scrollTranscript(): void {}
  describeState(): VoiceStateSnapshot {
    return {
      totalSessions: this.panes.length,
      workingSessions: this.panes.length,
      waitingSessions: 0,
      doneSessions: 0,
      errorSessions: 0,
      currentView: "code",
      spokenSummary: "",
    }
  }
}

function setup(answer: string | ((prompt: { signal?: AbortSignal }) => Promise<string>)) {
  const host = new PlanningHost()
  const transcriber = createFakeTranscriber()
  const speaker = createFakeSpeaker()
  const prompts: { system: string; user: string }[] = []

  const engine = createVoiceEngine({
    host,
    transcriber,
    speaker,
    now: () => 10_000,
    plan: async (prompt) => {
      prompts.push({ system: prompt.system, user: prompt.user })
      return typeof answer === "string" ? answer : answer(prompt)
    },
    settings: { activation: "toggle" },
  })

  return { engine, host, transcriber, speaker, prompts }
}

/** Lets the forked planning fiber finish before the assertions run. */
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
}

describe("il pianificatore dentro il motore", () => {
  test("un agente che non può rispondere lascia la frase al pianificatore, e il problema resta scritto", async () => {
    const { engine, host, transcriber, speaker, prompts } = setup(
      JSON.stringify([{ action: "start_session", agent: "claude", task: "il parser", project: "nikcli" }]),
    )
    ;(host as VoiceHost).askAgent = async () => ({
      ok: false,
      text: "Per rispondere mi serve Claude Code o Codex.",
      ran: false,
    })

    await engine.start()
    transcriber.emit("avvia una sessione claude sul parser nel progetto nikcli", true)
    await settle()

    expect(prompts).toHaveLength(1)
    expect(host.started).toHaveLength(1)
    expect(speaker.lastSpoken).toBe("Ho avviato una sessione Claude Code.")
    expect(
      engine.history().some((entry) => entry.kind === "error" && entry.text.includes("mi serve Claude Code")),
    ).toBe(true)
    await engine.stop()
  })

  test("un turno che è partito e poi fallisce non passa la frase al pianificatore: niente sessioni doppie", async () => {
    const { engine, host, transcriber, prompts } = setup(
      JSON.stringify([{ action: "start_session", agent: "claude", task: "il parser", project: "nikcli" }]),
    )
    ;(host as VoiceHost).askAgent = async () => {
      // The turn opened the session itself, then its CLI timed out.
      host.started.push({ agent: "claude" })
      return { ok: false, text: "L'agente non ha risposto in tempo.", ran: true }
    }

    await engine.start()
    transcriber.emit("avvia una sessione claude sul parser nel progetto nikcli", true)
    await settle()

    expect(prompts).toHaveLength(0)
    expect(host.started).toHaveLength(1)
    expect(
      engine.history().some((entry) => entry.kind === "error" && entry.text.includes("non ha risposto in tempo")),
    ).toBe(true)
    await engine.stop()
  })

  test("«annulla» mentre il pianificatore pensa ferma il piano: niente parte", async () => {
    let aborted = false
    const { engine, host } = setup(
      (prompt) =>
        new Promise((resolve) => {
          prompt.signal?.addEventListener("abort", () => (aborted = true))
          setTimeout(
            () => resolve(JSON.stringify([{ action: "start_session", agent: "claude", task: "x", project: "nikcli" }])),
            60,
          )
        }),
    )

    void engine.submitText("avvia una sessione claude sul parser nel progetto nikcli")
    await settle()
    expect(engine.status()).toBe("executing")
    await engine.submitText("annulla")
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(aborted).toBe(true)
    expect(host.started).toHaveLength(0)
    await engine.stop()
  })

  test("addormentato, una frase sconosciuta non va né all'agente né al pianificatore", async () => {
    const { engine, host, transcriber, prompts } = setup("[]")
    let asked = 0
    ;(host as VoiceHost).askAgent = async () => {
      asked++
      return { ok: true, text: "no" }
    }

    await engine.start()
    transcriber.emit("vai a dormire", true)
    await settle()
    transcriber.emit("riassumimi il progetto in una frase", true)
    await settle()

    expect(asked).toBe(0)
    expect(prompts).toHaveLength(0)
    await engine.stop()
  })

  test("con una risposta testuale, quello che il piano rifiuta viene detto lo stesso", async () => {
    const { engine, host, transcriber, speaker } = setup(
      JSON.stringify({ speech: "Va bene.", steps: [{ action: "start_session", agent: "copilot" }] }),
    )

    await engine.start()
    transcriber.emit("avvia una sessione di copilot e dimmi quando", true)
    await settle()

    expect(host.started).toEqual([])
    expect(speaker.lastSpoken).toContain("Va bene.")
    expect(speaker.lastSpoken).toContain("copilot")
    await engine.stop()
  })

  test("«elenca pannelli» risponde a voce: è un'informazione, non un'azione da vedere", async () => {
    const { engine, host, transcriber, speaker } = setup("[]")
    host.panes.push({
      id: "p1",
      title: "Parser",
      status: "working",
      index: 1,
      hasLiveProcess: true,
      isBrowser: false,
      isFile: false,
    })

    await engine.start()
    transcriber.emit("elenca pannelli", true)
    await settle()

    expect(speaker.lastSpoken).toContain("Parser")
    expect(engine.history().filter((entry) => entry.kind === "action")).toHaveLength(0)
    await engine.stop()
  })

  test("«avvia 4 sessioni claude, una per argomento» avvia quattro sessioni", async () => {
    const { engine, host, transcriber, speaker } = setup(
      JSON.stringify([
        { action: "start_session", agent: "claude", task: "il parser", project: "nikcli" },
        { action: "start_session", agent: "claude", task: "i test", project: "nikcli" },
        { action: "start_session", agent: "claude", task: "la documentazione", project: "nikcli" },
        { action: "start_session", agent: "claude", task: "la build", project: "nikcli" },
      ]),
    )

    await engine.start()
    transcriber.emit(
      "avvia quattro sessioni claude nel progetto nikcli, una sul parser, una sui test, una sulla documentazione e una sulla build",
      true,
    )
    await settle()

    expect(host.started).toHaveLength(4)
    expect(host.started.map((s) => s.task)).toEqual(["il parser", "i test", "la documentazione", "la build"])
    // Il progetto arriva come radice, non come la parola detta.
    expect(host.started.every((s) => s.project === "C:/Users/x/nikcli")).toBe(true)
    expect(speaker.lastSpoken).toBe("Ho avviato 4 sessioni Claude Code.")

    await engine.stop()
  })

  /*
   * La ragione dell'ibrido: le frasi note non devono pagare un giro di rete.
   */
  test("una frase che la grammatica riconosce non arriva mai al pianificatore", async () => {
    const { engine, transcriber, prompts } = setup("[]")

    await engine.start()
    transcriber.emit("nuova sessione", true)
    await settle()

    expect(prompts).toHaveLength(0)

    await engine.stop()
  })

  test("il modello riceve gli agenti e i progetti veri di questa macchina", async () => {
    const { engine, transcriber, prompts } = setup("[]")

    await engine.start()
    transcriber.emit("fai una cosa complicatissima con i pannelli", true)
    await settle()

    expect(prompts).toHaveLength(1)
    expect(prompts[0].system).toContain("claude-code")
    expect(prompts[0].system).toContain("nikcli")
    expect(prompts[0].user).toBe("fai una cosa complicatissima con i pannelli")

    await engine.stop()
  })

  /*
   * Un agente che il modello si è inventato non deve diventare una sessione
   * silenziosamente mancante: viene rifiutato dicendolo.
   */
  test("un agente inventato viene rifiutato a voce", async () => {
    const { engine, host, transcriber, speaker } = setup(
      JSON.stringify([{ action: "start_session", agent: "copilot" }]),
    )

    await engine.start()
    transcriber.emit("avvia due sessioni di copilot", true)
    await settle()

    expect(host.started).toEqual([])
    expect(speaker.lastSpoken).toContain("copilot")

    await engine.stop()
  })

  /*
   * La garanzia strutturale: non esiste un passo distruttivo, e nemmeno un
   * comando distruttivo pianificabile. Il modello può chiederlo quanto vuole.
   */
  test("un piano che tenta di chiudere o terminare non esegue niente", async () => {
    const { engine, host, transcriber } = setup(
      JSON.stringify([
        { action: "close_pane", paneIndex: 1 },
        { action: "run_command", command: "process.kill" },
      ]),
    )

    await engine.start()
    transcriber.emit("chiudi tutto e ammazza i processi adesso", true)
    await settle()

    expect(host.started).toEqual([])
    expect(host.panes).toEqual([])

    await engine.stop()
  })

  test("un pianificatore irraggiungibile lo dice, invece di tacere", async () => {
    const { engine, transcriber, speaker } = setup(async () => {
      throw new Error("Il servizio ha risposto 429.")
    })

    await engine.start()
    transcriber.emit("orchestrami qualcosa di elaborato", true)
    await settle()

    expect(speaker.lastSpoken).toContain("429")

    await engine.stop()
  })

  test("Jarvis risponde a voce a domande discorsive senza tentare azioni UI", async () => {
    const { engine, host, transcriber, speaker } = setup(
      JSON.stringify({
        speech: "Al momento ci sono zero sessioni aperte. Vuoi che ne avvii una con Claude?",
        steps: [],
      }),
    )

    await engine.start()
    transcriber.emit("Jarvis, qual è la situazione dei pannelli in questo momento?", true)
    await settle()

    expect(host.started).toEqual([])
    expect(speaker.lastSpoken).toBe("Al momento ci sono zero sessioni aperte. Vuoi che ne avvii una con Claude?")
    expect(engine.history().some((entry) => entry.kind === "assistant" && entry.text.includes("zero sessioni"))).toBe(
      true,
    )

    await engine.stop()
  })

  test("Barge-in: un parlato parziale dell'utente tronca la sintesi vocale attiva", async () => {
    const { engine, transcriber, speaker } = setup("[]")
    await engine.start()

    // Sintesi attiva
    await speaker.speak("Sto pronunciando una frase lunghissima che l'utente vuole interrompere...")
    expect(speaker.lastSpoken).toContain("lunghissima")

    let cancelled = false
    const origCancel = speaker.cancel
    speaker.cancel = () => {
      cancelled = true
      origCancel.call(speaker)
    }

    // L'utente inizia a parlare (evento partial da ASR)
    transcriber.emit("fermati", false)
    await settle()

    expect(cancelled).toBe(true)

    await engine.stop()
  })
})

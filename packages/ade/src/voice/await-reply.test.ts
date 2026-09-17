import { describe, expect, test } from "bun:test"
import { awaitPaneReply, type WatchedLine, type WatchedStatus } from "./await-reply"

/**
 * A pane whose transcript grows on a script, driven by a clock the test owns.
 *
 * Each entry is what happens on one poll tick: `undefined` for "nothing new".
 * Nothing waits in real time, so a 180-second ceiling costs a millisecond.
 */
function scriptedPane(input: {
  script: ReadonlyArray<string | undefined>
  status?: WatchedStatus | ((tick: number) => WatchedStatus)
  backlog?: readonly string[]
  pollMs?: number
  /** Keeps only the last `cap` lines, as the workbench does with its 200. */
  cap?: number
}) {
  const pollMs = input.pollMs ?? 250
  const lines: WatchedLine[] = (input.backlog ?? []).map((text) => ({ kind: "step", text }))
  let clock = 0
  let tick = -1

  // The first read happens before any sleep, so the script advances on sleep.
  const advance = () => {
    tick += 1
    const next = input.script[tick]
    if (next !== undefined) lines.push({ kind: "step", text: next })
    if (input.cap !== undefined && lines.length > input.cap) lines.splice(0, lines.length - input.cap)
  }

  return {
    lines,
    deps: {
      linesOf: () => lines,
      statusOf: () => (typeof input.status === "function" ? input.status(tick) : (input.status ?? "working")),
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
        advance()
      },
    },
    pollMs,
  }
}

describe("awaitPaneReply", () => {
  test("restituisce solo ciò che arriva dopo il prompt, non l'arretrato", async () => {
    const pane = scriptedPane({
      backlog: ["conversazione precedente", "> domanda vecchia"],
      script: ["Sto guardando.", "Ho finito.", undefined, undefined, undefined, undefined, undefined, undefined],
    })

    const result = await awaitPaneReply(pane.deps, "p1", { pollMs: pane.pollMs })

    expect(result.reason).toBe("settled")
    expect(result.lines.map((l) => l.text)).toEqual(["Sto guardando.", "Ho finito."])
  })

  /*
   * Un transcript pieno non cresce più di lunghezza: le righe nuove spingono
   * fuori le vecchie. Contare le righe dava «silent» a ogni risposta.
   */
  test("un transcript già al limite restituisce comunque la risposta", async () => {
    const pane = scriptedPane({
      cap: 3,
      backlog: ["a", "b", "c"],
      script: ["Uno.", "Due.", undefined, undefined, undefined, undefined, undefined, undefined],
    })

    const result = await awaitPaneReply(pane.deps, "p1", { pollMs: pane.pollMs })

    expect(result.reason).toBe("settled")
    expect(result.lines.map((l) => l.text)).toEqual(["Uno.", "Due."])
  })

  test("una risposta più lunga del limite restituisce tutto ciò che resta", async () => {
    const pane = scriptedPane({
      cap: 2,
      backlog: ["a", "b"],
      script: ["1", "2", "3", undefined, undefined, undefined, undefined, undefined, undefined],
    })

    const result = await awaitPaneReply(pane.deps, "p1", { pollMs: pane.pollMs })

    expect(result.reason).toBe("settled")
    expect(result.lines.map((l) => l.text)).toEqual(["2", "3"])
  })

  /*
   * Il silenzio è la fine della risposta: nessun agente annuncia di aver
   * smesso, e molti ridisegnano il frame per sempre senza cambiare stato.
   */
  test("conclude quando l'output si ferma e resta fermo", async () => {
    const pane = scriptedPane({
      script: ["Prima riga.", undefined, undefined, undefined, "Non dovrebbe arrivarci."],
    })

    const result = await awaitPaneReply(pane.deps, "p1", {
      pollMs: 250,
      quietMs: 500,
    })

    expect(result.reason).toBe("settled")
    expect(result.lines.map((l) => l.text)).toEqual(["Prima riga."])
  })

  test("una pausa più corta del silenzio richiesto non chiude la risposta", async () => {
    const pane = scriptedPane({
      script: ["Uno.", undefined, "Due.", undefined, undefined, undefined, undefined],
    })

    const result = await awaitPaneReply(pane.deps, "p1", { pollMs: 250, quietMs: 600 })

    expect(result.lines.map((l) => l.text)).toEqual(["Uno.", "Due."])
  })

  /*
   * Un pannello in errore ha finito adesso. Aspettare il silenzio servirebbe
   * solo a ritardare il momento in cui glielo si dice.
   */
  test("un errore interrompe subito l'attesa", async () => {
    const pane = scriptedPane({
      script: ["Provo.", undefined],
      status: (tick) => (tick >= 1 ? "error" : "working"),
    })

    const result = await awaitPaneReply(pane.deps, "p1", { pollMs: 250, quietMs: 10_000 })

    expect(result.reason).toBe("error")
  })

  /*
   * Distinguere «non ha detto niente» da «ci ha messo troppo» conta, perché
   * l'assistente dice due cose diverse.
   */
  test("nessuna riga entro il primo limite è «silent», non «timeout»", async () => {
    const pane = scriptedPane({ script: Array.from({ length: 40 }, () => undefined) })

    const result = await awaitPaneReply(pane.deps, "p1", {
      pollMs: 250,
      firstLineTimeoutMs: 1_000,
    })

    expect(result.reason).toBe("silent")
    expect(result.lines).toEqual([])
  })

  test("un agente che non smette più viene chiuso dal tetto, tenendo ciò che ha detto", async () => {
    const pane = scriptedPane({ script: Array.from({ length: 40 }, () => "ancora") })

    const result = await awaitPaneReply(pane.deps, "p1", {
      pollMs: 250,
      quietMs: 10_000,
      timeoutMs: 1_000,
    })

    expect(result.reason).toBe("timeout")
    expect(result.lines.length).toBeGreaterThan(0)
  })

  test("un pannello chiuso mentre si aspetta non è un errore", async () => {
    const result = await awaitPaneReply(
      {
        linesOf: () => undefined,
        statusOf: () => undefined,
        now: () => 0,
        sleep: async () => {},
      },
      "sparito",
    )

    expect(result.reason).toBe("gone")
    expect(result.lines).toEqual([])
  })

  test("l'abort del chiamante restituisce quello che c'è finora", async () => {
    const controller = new AbortController()
    const pane = scriptedPane({
      script: ["Inizio.", undefined, undefined, undefined],
    })
    const deps = {
      ...pane.deps,
      sleep: async (ms: number) => {
        await pane.deps.sleep(ms)
        controller.abort()
      },
    }

    const result = await awaitPaneReply(deps, "p1", {
      pollMs: 250,
      quietMs: 10_000,
      signal: controller.signal,
    })

    expect(result.reason).toBe("aborted")
    expect(result.lines.map((l) => l.text)).toEqual(["Inizio."])
  })
})

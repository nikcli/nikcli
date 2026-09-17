import { describe, expect, test } from "bun:test"
import { appendEntry, groupIntoTurns, MAX_AGENT_ENTRIES, type AgentEntry } from "./log"

const user = (text: string, at = 1): AgentEntry => ({ kind: "user", text, at })
const assistant = (text: string, at = 1): AgentEntry => ({ kind: "assistant", text, at })

describe("appendEntry", () => {
  test("appends in order", () => {
    const log = appendEntry(appendEntry([], user("apri il pannello")), assistant("Apro il pannello."))
    expect(log.map((e) => e.kind)).toEqual(["user", "assistant"])
  })

  test("drops an immediate repeat, because onSpoken fires from two places", () => {
    const once = appendEntry([], assistant("Non ho capito, puoi ripetere?"))
    const twice = appendEntry(once, assistant("Non ho capito, puoi ripetere?"))
    expect(twice).toHaveLength(1)
    expect(twice).toBe(once)
  })

  test("keeps the same sentence when something happened in between", () => {
    let log = appendEntry([], assistant("Non ho capito, puoi ripetere?"))
    log = appendEntry(log, user("apri"))
    log = appendEntry(log, assistant("Non ho capito, puoi ripetere?"))
    expect(log).toHaveLength(3)
  })

  test("a repeated action collapses only when the outcome also matches", () => {
    let log = appendEntry([], { kind: "action", label: "Apro il pannello", ok: true, at: 1 })
    log = appendEntry(log, { kind: "action", label: "Apro il pannello", ok: true, at: 2 })
    expect(log).toHaveLength(1)
    log = appendEntry(log, { kind: "action", label: "Apro il pannello", ok: false, at: 3 })
    expect(log).toHaveLength(2)
  })

  test("caps the length, dropping the oldest", () => {
    let log: AgentEntry[] = []
    for (let i = 0; i < 10; i++) log = appendEntry(log, user(`riga ${i}`), { max: 4 })
    expect(log).toHaveLength(4)
    expect((log[0] as { text: string }).text).toBe("riga 6")
    expect((log[3] as { text: string }).text).toBe("riga 9")
  })

  test("the default cap is bounded, so an all-day session cannot grow without limit", () => {
    let log: AgentEntry[] = []
    for (let i = 0; i < MAX_AGENT_ENTRIES + 50; i++) log = appendEntry(log, user(`riga ${i}`))
    expect(log).toHaveLength(MAX_AGENT_ENTRIES)
  })
})

describe("groupIntoTurns", () => {
  test("a turn starts at every user entry and keeps what followed", () => {
    const turns = groupIntoTurns([
      user("avvia due sessioni"),
      assistant("Avvio due sessioni."),
      { kind: "plan", steps: ["claude su parser", "claude su test"], ok: 2, failed: 0, at: 1 },
      user("chiudi il primo"),
      assistant("Vuoi davvero chiudere il pannello?"),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0].prompt?.text).toBe("avvia due sessioni")
    expect(turns[0].replies).toHaveLength(2)
    expect(turns[1].prompt?.text).toBe("chiudi il primo")
    expect(turns[1].replies).toHaveLength(1)
  })

  test("what the assistant said before any prompt becomes a leading turn with no prompt", () => {
    const turns = groupIntoTurns([assistant("Sono sveglio e in ascolto."), user("ciao")])
    expect(turns).toHaveLength(2)
    expect(turns[0].prompt).toBeUndefined()
    expect(turns[0].replies).toHaveLength(1)
    expect(turns[1].prompt?.text).toBe("ciao")
  })

  test("an empty log produces no turns", () => {
    expect(groupIntoTurns([])).toEqual([])
  })
})

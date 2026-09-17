import { describe, expect, test } from "bun:test"
import { answerEvent, countLabel, deferFromInput, deferPresets, formatDay, sheetKey } from "./answer"
import {
  deliveryLine,
  deliveryState,
  enqueue,
  markDelivered,
  parseOutbox,
  pendingFor,
  pruneOutbox,
  chooseRecipient,
  parseRecipients,
  recipientChange,
  recipientOptions,
  resolveRecipient,
} from "./delivery"
import type { DecisionEvent } from "./log"
import { foldDecisions } from "./state"

const decision = { k: "D21", options: [{ label: "A · Rifinitura" }, { label: "B · Estensioni" }] }

describe("the window's keys", () => {
  test("digits pick, Enter records a choice, Esc closes, arrows move", () => {
    expect(sheetKey({ key: "2" }, 2, false, false)).toEqual({ kind: "pick", index: 1 })
    expect(sheetKey({ key: "3" }, 2, false, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 2, false, true)).toEqual({ kind: "submit" })
    expect(sheetKey({ key: "Escape" }, 2, true, false)).toEqual({ kind: "close" })
    expect(sheetKey({ key: "ArrowRight" }, 2, false, false)).toEqual({ kind: "next" })
  })

  test("a stray Enter with nothing chosen records nothing", () => {
    expect(sheetKey({ key: "Enter" }, 2, false, false)).toEqual({ kind: "need-choice" })
    expect(sheetKey({ key: "Enter" }, 0, false, false)).toEqual({ kind: "need-choice" })
  })

  test("in the note, keys are typing; only Ctrl+Enter records", () => {
    expect(sheetKey({ key: "2" }, 2, true, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 2, true, true)).toBeUndefined()
    expect(sheetKey({ key: "ArrowLeft" }, 2, true, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter", ctrlKey: true }, 2, true, false)).toEqual({ kind: "submit" })
  })
})

describe("an answer", () => {
  const at = new Date("2026-09-15T15:21:00Z")

  test("carries the option and the note together as the user's words", () => {
    expect(answerEvent(decision, 1, "  ma senza il globale ", at)).toEqual({
      type: "risposta",
      k: "D21",
      at: at.toISOString(),
      by: "utente",
      choice: "B · Estensioni",
      note: "ma senza il globale",
      words: "B · Estensioni — ma senza il globale",
    })
  })

  test("can be written words alone, but not nothing", () => {
    expect(answerEvent(decision, undefined, "nessuna delle due", at)).toMatchObject({ words: "nessuna delle due" })
    expect(answerEvent(decision, undefined, "  ", at)).toBe("scegli un'opzione o scrivi la risposta")
  })
})

describe("dates", () => {
  test("presets are the start of a later local day", () => {
    const now = new Date(2026, 8, 15, 17, 30) // a Tuesday
    const [tomorrow, three, monday] = deferPresets(now)
    expect(new Date(tomorrow!.until)).toEqual(new Date(2026, 8, 16))
    expect(new Date(three!.until)).toEqual(new Date(2026, 8, 18))
    expect(new Date(monday!.until)).toEqual(new Date(2026, 8, 21))
    expect(new Date(deferPresets(new Date(2026, 8, 21, 9))[2]!.until)).toEqual(new Date(2026, 8, 28))
  })

  test("a typed date must be in the future", () => {
    const now = new Date(2026, 8, 15, 17, 30)
    expect(deferFromInput("2026-09-20", now)).toBe(new Date(2026, 8, 20).toISOString())
    expect(deferFromInput("2026-09-15", now)).toBeUndefined()
    expect(deferFromInput("20/09/2026", now)).toBeUndefined()
  })

  test("days read the way people say them", () => {
    const now = new Date(2026, 8, 15, 17, 30)
    expect(formatDay(new Date(2026, 8, 15, 9).toISOString(), now)).toBe("oggi")
    expect(formatDay(new Date(2026, 8, 16).toISOString(), now)).toBe("domani")
    expect(formatDay(new Date(2026, 8, 20).toISOString(), now)).toBe("20 set")
    expect(formatDay(new Date(2027, 0, 4).toISOString(), now)).toBe("4 gen 2027")
    expect(countLabel(1)).toBe("1 decisione")
    expect(countLabel(3)).toBe("3 decisioni")
  })
})

describe("who hears about an answer", () => {
  const panes = [
    { id: "a", title: "Dario", project: "nikcli", running: true },
    { id: "b", title: "Master", project: "altro", running: true },
    { id: "c", title: "master · S18", project: "nikcli", running: false },
    { id: "d", title: "Master 2", project: "nikcli", running: true },
  ]

  test("only the chosen session, whatever it is called; nobody chosen is nobody", () => {
    // No title is special: a running "Master" gets nothing unless chosen.
    expect(resolveRecipient(panes, undefined)).toEqual({ state: "non scelta" })
    expect(resolveRecipient(panes, { id: "a", title: "Dario" })).toEqual({ state: "pronta", id: "a", title: "Dario" })
    // Another project's session is as good as one here.
    expect(resolveRecipient(panes, { id: "b", title: "vecchio nome" })).toEqual({
      state: "pronta",
      id: "b",
      title: "Master",
    })
    expect(resolveRecipient(panes, { id: "c", title: "master · S18" })).toEqual({
      state: "non attiva",
      id: "c",
      title: "master · S18",
    })
    expect(resolveRecipient(panes, { id: "z", title: "Chiusa" })).toEqual({
      state: "non attiva",
      id: "z",
      title: "Chiusa",
    })
  })

  test("moving through the selector sends nothing queued without a confirmation", () => {
    expect(recipientChange(undefined, "a", 2)).toBe("conferma")
    expect(recipientChange("a", "b", 1)).toBe("conferma")
    expect(recipientChange(undefined, "a", 0)).toBe("applica")
    expect(recipientChange("a", undefined, 3)).toBe("applica")
    expect(recipientChange("a", "a", 3)).toBe("nessuna")
    expect(recipientChange(undefined, undefined, 3)).toBe("nessuna")
  })

  test("the selector shows the real recipient, not its first entry", () => {
    const shown = (options: { value: string; selected: boolean }[]) =>
      options.filter((option) => option.selected).map((option) => option.value)
    // After "Consegna": the recipient is chosen and nothing is pending.
    expect(shown(recipientOptions(panes, { state: "pronta", id: "b", title: "Master" }))).toEqual(["b"])
    // Rebuilt from fresh session objects, as a delivery note causes: still "b".
    expect(
      shown(
        recipientOptions(
          panes.map((pane) => ({ ...pane })),
          { state: "pronta", id: "b", title: "Master" },
        ),
      ),
    ).toEqual(["b"])
    expect(shown(recipientOptions(panes, { state: "non scelta" }))).toEqual([""])
    // A pick waiting for confirmation is what the select shows meanwhile.
    expect(shown(recipientOptions(panes, { state: "non scelta" }, "a"))).toEqual(["a"])
    const closed = recipientOptions(panes, { state: "non attiva", id: "z", title: "Vecchia" })
    expect(closed.at(-1)).toEqual({ value: "z", label: "Vecchia (chiusa)", selected: true })
    expect(recipientOptions(panes, { state: "non scelta" }).map((option) => option.label)).toContain(
      "master · S18 · nikcli (ferma)",
    )
  })

  test("the choice is kept per project and survives a bad value", () => {
    let all = chooseRecipient({}, "/p/.ade/decisions.jsonl", { id: "a", title: "Dario" })
    all = chooseRecipient(all, "/q/.ade/decisions.jsonl", { id: "b", title: "Coordina" })
    expect(parseRecipients(JSON.stringify(all))).toEqual(all)
    expect(chooseRecipient(all, "/p/.ade/decisions.jsonl", undefined)).toEqual({
      "/q/.ade/decisions.jsonl": { id: "b", title: "Coordina" },
    })
    expect(parseRecipients("{rotto")).toEqual({})
    expect(parseRecipients(JSON.stringify({ x: { id: 3 }, y: { id: "d", title: "T" } }))).toEqual({
      y: { id: "d", title: "T" },
    })
  })

  test("the line starts with who it is from and the verb", () => {
    const { decisions } = foldDecisions([
      { type: "aperta", k: "D21", at: "2026-09-15T15:00:00Z", by: "Dario", title: "Pagina Plugin" },
      { type: "risposta", k: "D21", at: "2026-09-15T15:21:00Z", by: "utente", words: "la B" },
    ] as DecisionEvent[])
    expect(deliveryLine(decisions[0]!)).toBe('[Decisione da utente] risolta [k=D21] Pagina Plugin — parole: "la B"')
  })
})

describe("the outbox", () => {
  const path = "/p/.ade/decisions.jsonl"
  const events: DecisionEvent[] = [
    { type: "aperta", k: "D1", at: "2026-09-15T10:00:00Z", by: "Master", title: "Uno" },
    { type: "risposta", k: "D1", at: "2026-09-15T10:05:00Z", by: "utente", words: "sì" },
    { type: "aperta", k: "D2", at: "2026-09-15T10:00:00Z", by: "Master", title: "Due" },
  ]

  test("queued, delivered, and forgotten once closed or changed", () => {
    let outbox = enqueue([], { path, k: "D1", answeredAt: "2026-09-15T10:05:00Z", queuedAt: 1 })
    const { decisions } = foldDecisions(events)
    expect(deliveryState(outbox, path, decisions[0]!)).toEqual({ state: "in coda" })
    expect(pendingFor(outbox, path)).toHaveLength(1)

    outbox = markDelivered(outbox, outbox[0]!, "Master", 99)
    expect(deliveryState(outbox, path, decisions[0]!)).toEqual({ state: "consegnata", to: "Master", at: 99 })
    expect(pendingFor(outbox, path)).toHaveLength(0)
    expect(parseOutbox(JSON.stringify(outbox))).toEqual(outbox)

    const closed = foldDecisions([
      ...events,
      { type: "chiusa", k: "D1", at: "2026-09-15T11:00:00Z", by: "Master" },
    ]).decisions
    expect(pruneOutbox(outbox, path, closed)).toEqual([])
    const other = enqueue([], { path: "/q/.ade/decisions.jsonl", k: "D1", answeredAt: "x", queuedAt: 1 })
    expect(pruneOutbox(other, path, closed)).toEqual(other)
  })

  test("an answer written outside ADE is not sent anywhere", () => {
    const { decisions } = foldDecisions(events)
    expect(deliveryState([], path, decisions[0]!)).toEqual({ state: "fuori da ADE" })
    expect(parseOutbox("{rotto")).toEqual([])
  })
})

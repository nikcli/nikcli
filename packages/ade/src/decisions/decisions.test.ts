import { describe, expect, test } from "bun:test"
import { resetLocaleForTests } from "../i18n"
import { parseDecisionLog, serializeDecisionEvent, toEvent, type DecisionEvent } from "./log"
import { bucketDecisions, describeProblems, foldDecisions, nextDecisionKey, resolvedMessage } from "./state"
import { appendDecisionEvent, decisionsPath, loadDecisions, type DecisionsIo } from "./store"

const at = (minute: number) => new Date(Date.UTC(2026, 8, 15, 16, minute)).toISOString()

const opened = (k: string, extra: Partial<DecisionEvent> = {}): DecisionEvent =>
  ({
    type: "aperta",
    k,
    at: at(0),
    by: "Dario",
    title: `Titolo ${k}`,
    options: [{ label: "A", detail: "piccola" }, { label: "B" }],
    unlocks: "S16",
    ...extra,
  }) as DecisionEvent

const answered = (k: string, words: string, minute = 5): DecisionEvent => ({
  type: "risposta",
  k,
  at: at(minute),
  by: "utente",
  choice: "B",
  words,
})

describe("the log on disk", () => {
  test("round-trips an event as one line, dropping empty fields", () => {
    const line = serializeDecisionEvent({ ...(opened("D21") as object), context: "  " } as DecisionEvent)
    expect(line.endsWith("\n")).toBe(true)
    expect(line.slice(0, -1).includes("\n")).toBe(false)
    expect(line).not.toContain("context")
    expect(parseDecisionLog(line).events).toEqual([opened("D21")])
  })

  test("a line break inside the user's words stays inside one line", () => {
    const line = serializeDecisionEvent(answered("D21", "B,\nma senza globale"))
    expect(line.split("\n").length).toBe(2)
    expect((parseDecisionLog(line).events[0] as { words: string }).words).toBe("B,\nma senza globale")
  })

  test("broken lines become problems and the rest still counts", () => {
    const text = [
      JSON.stringify(opened("D1")),
      "{not json",
      "",
      JSON.stringify({ type: "boh", k: "D1", at: at(1), by: "x" }),
      '{"type":"aperta","k":"D2"',
    ].join("\n")
    const parsed = parseDecisionLog(text)
    expect(parsed.events.map((e) => e.k)).toEqual(["D1"])
    expect(parsed.problems).toEqual([
      { line: 2, reason: "JSON non valido" },
      { line: 4, reason: "tipo sconosciuto" },
      { line: 5, reason: "JSON non valido" },
    ])
  })

  test("an answer without the user's words is not an answer", () => {
    expect(toEvent({ type: "risposta", k: "D1", at: at(1), by: "utente", choice: "B" })).toBe(
      "risposta senza le parole dell'utente",
    )
  })

  test("keys, dates and deferrals are checked", () => {
    expect(toEvent({ ...opened("D1"), k: "D 1" })).toBe("chiave mancante o non valida")
    expect(toEvent({ ...opened("D1"), at: "ieri" })).toBe("data mancante o non valida")
    expect(toEvent({ type: "rimandata", k: "D1", at: at(1), by: "utente", until: "più tardi" })).toBe(
      "rimandata senza una data valida",
    )
    expect(toEvent({ ...opened("D1"), options: [{ detail: "senza etichetta" }] })).toBe("opzione senza etichetta")
  })
})

describe("folding events into decisions", () => {
  test("open, answer in the user's words, close", () => {
    const { decisions, rejected } = foldDecisions([
      opened("D21"),
      answered("D21", "la B, ma senza il catalogo globale"),
      { type: "chiusa", k: "D21", at: at(9), by: "Master", evidence: "commit abc123" },
    ])
    expect(rejected).toEqual([])
    expect(decisions[0]).toMatchObject({
      k: "D21",
      status: "chiusa",
      answer: { choice: "B", words: "la B, ma senza il catalogo globale", by: "utente" },
      evidence: "commit abc123",
    })
    expect(decisions[0]!.history.map((e) => e.type)).toEqual(["aperta", "risposta", "chiusa"])
  })

  test("a decision is not closed by being forgotten: close needs an answer or evidence", () => {
    const { decisions, rejected } = foldDecisions([opened("D1"), { type: "chiusa", k: "D1", at: at(2), by: "Master" }])
    expect(decisions[0]!.status).toBe("aperta")
    expect(rejected[0]!.reason).toBe("D1 si chiude solo dopo una risposta o con un'evidenza")

    const withEvidence = foldDecisions([
      opened("D1"),
      { type: "chiusa", k: "D1", at: at(2), by: "Master", evidence: "superata da D4" },
    ])
    expect(withEvidence.decisions[0]!.status).toBe("chiusa")
  })

  test("a deferral runs out on its date without anyone writing", () => {
    const events = [
      opened("D1"),
      { type: "rimandata", k: "D1", at: at(1), by: "utente", until: "2026-09-20" } as DecisionEvent,
    ]
    expect(foldDecisions(events, new Date("2026-09-18T10:00:00Z")).decisions[0]).toMatchObject({
      status: "rimandata",
      deferredUntil: "2026-09-20",
    })
    expect(foldDecisions(events, new Date("2026-09-20T00:00:00Z")).decisions[0]!.status).toBe("aperta")
  })

  test("an expired deferral can be answered", () => {
    const events = [
      opened("D1"),
      { type: "rimandata", k: "D1", at: at(1), by: "utente", until: "2026-09-16" } as DecisionEvent,
      { ...answered("D1", "sì"), at: "2026-09-17T09:00:00Z" } as DecisionEvent,
    ]
    const { decisions, rejected } = foldDecisions(events, new Date("2026-09-17T10:00:00Z"))
    expect(rejected).toEqual([])
    expect(decisions[0]!.status).toBe("risposta")
  })

  test("changing an answer means reopening it; a second answer on top is refused", () => {
    const raced = foldDecisions([opened("D1"), answered("D1", "A"), answered("D1", "B", 6)])
    expect(raced.decisions[0]!.answer!.words).toBe("A")
    expect(raced.rejected[0]!.reason).toBe("D1 ha già una risposta: prima va riaperta")

    const changed = foldDecisions([
      opened("D1"),
      answered("D1", "A"),
      { type: "riaperta", k: "D1", at: at(6), by: "utente" },
      answered("D1", "B", 7),
    ])
    expect(changed.rejected).toEqual([])
    expect(changed.decisions[0]!.answer!.words).toBe("B")
  })

  test("nothing happens to a closed decision, and nothing to one never opened", () => {
    const { decisions, rejected } = foldDecisions([
      answered("D9", "boh"),
      opened("D1"),
      answered("D1", "A"),
      { type: "chiusa", k: "D1", at: at(8), by: "Master" },
      { type: "riaperta", k: "D1", at: at(9), by: "utente" },
      opened("D1"),
    ])
    expect(decisions.map((d) => [d.k, d.status])).toEqual([["D1", "chiusa"]])
    expect(rejected.map((r) => r.reason)).toEqual(["D9 non è mai stata aperta", "D1 è già chiusa", "D1 esiste già"])
    expect(describeProblems([{ line: 3, reason: "JSON non valido" }], rejected)[0]).toBe("riga 3: JSON non valido")
  })

  test("only an open decision can be deferred", () => {
    const { rejected } = foldDecisions([
      opened("D1"),
      answered("D1", "A"),
      { type: "rimandata", k: "D1", at: at(7), by: "utente", until: "2026-10-01" },
    ])
    expect(rejected[0]!.reason).toBe("si rimanda solo una decisione aperta (D1 è con risposta)")
    resetLocaleForTests("en")
    try {
      const english = foldDecisions([
        opened("D1"),
        answered("D1", "A"),
        { type: "rimandata", k: "D1", at: at(7), by: "utente", until: "2026-10-01" },
      ])
      expect(english.rejected[0]!.reason).toBe("only an open decision can be deferred (D1 is answered)")
    } finally {
      resetLocaleForTests("it")
    }
  })
})

describe("buckets and messages", () => {
  test("every decision in one bucket, open ones by order then by time", () => {
    const now = new Date("2026-09-18T00:00:00Z")
    const { decisions } = foldDecisions(
      [
        opened("D1", { at: at(1) }),
        opened("D2", { at: at(2), order: 1 }),
        opened("D3", { at: at(3) }),
        answered("D3", "fatto"),
        opened("D4", { at: at(4) }),
        { type: "rimandata", k: "D4", at: at(5), by: "utente", until: "2026-10-01" } as DecisionEvent,
        opened("D5", { at: at(6), order: 1 }),
      ],
      now,
    )
    const buckets = bucketDecisions(decisions)
    expect(buckets.forYou.map((d) => d.k)).toEqual(["D2", "D5", "D1"])
    expect(buckets.answered.map((d) => d.k)).toEqual(["D3"])
    expect(buckets.later.map((d) => d.k)).toEqual(["D4"])
    expect(buckets.closed).toEqual([])
  })

  test("the message to Master starts with the verb and keeps the user's words", () => {
    const { decisions } = foldDecisions([
      opened("D21", { title: "Pagina Plugin: quale variante?" }),
      {
        type: "risposta",
        k: "D21",
        at: at(5),
        by: "utente",
        choice: "B · Estensioni",
        note: "catalogo\nsolo progetto",
        words: "la B",
      },
    ])
    expect(resolvedMessage(decisions[0]!)).toBe(
      'risolta [k=D21] Pagina Plugin: quale variante? — scelta: B · Estensioni — nota: catalogo solo progetto — parole: "la B" — sblocca S16',
    )
  })

  test("keys are never reused", () => {
    expect(nextDecisionKey([{ k: "D3" }, { k: "D17" }, { k: "S16-x" }])).toBe("D18")
    expect(nextDecisionKey([])).toBe("D1")
  })
})

describe("the store", () => {
  function memoryIo(initial?: string) {
    const files = new Map<string, string>()
    if (initial !== undefined) files.set("/p/.ade/decisions.jsonl", initial)
    const io: DecisionsIo = {
      async readTextFile(path) {
        const text = files.get(path)
        if (text === undefined) throw new Error("No such file or directory (os error 2)")
        return { text, truncated: false }
      },
      async writeTextFile(path, contents) {
        files.set(path, contents)
        return null
      },
    }
    return { io, files }
  }

  test("the path: default inside the project, relative or absolute setting", () => {
    expect(decisionsPath("C:\\work\\app")).toBe("C:\\work\\app\\.ade\\decisions.jsonl")
    expect(decisionsPath("/work/app/", "  ")).toBe("/work/app/.ade/decisions.jsonl")
    expect(decisionsPath("/work/app", "./team/decisions.jsonl")).toBe("/work/app/team/decisions.jsonl")
    expect(decisionsPath("C:\\work\\app", "C:\\Users\\me\\ade-team\\decisions.jsonl")).toBe(
      "C:\\Users\\me\\ade-team\\decisions.jsonl",
    )
  })

  test("a missing register is empty, and the first append creates it", async () => {
    const { io, files } = memoryIo()
    const path = "/p/.ade/decisions.jsonl"
    expect((await loadDecisions(io, path)).state.decisions).toEqual([])
    await appendDecisionEvent(io, path, opened("D1"))
    await appendDecisionEvent(io, path, answered("D1", "va bene la A"))
    const loaded = await loadDecisions(io, path)
    expect(loaded.state.decisions[0]!.status).toBe("risposta")
    expect(files.get(path)!.split("\n").filter(Boolean).length).toBe(2)
  })

  test("an event the register would reject is not written", async () => {
    const { io, files } = memoryIo(serializeDecisionEvent(opened("D1")))
    const path = "/p/.ade/decisions.jsonl"
    await expect(appendDecisionEvent(io, path, { type: "chiusa", k: "D1", at: at(3), by: "Master" })).rejects.toThrow(
      "D1 si chiude solo dopo una risposta o con un'evidenza",
    )
    expect(files.get(path)!.split("\n").filter(Boolean).length).toBe(1)
  })

  test("appending after a half-written last line starts a fresh line", async () => {
    const path = "/p/.ade/decisions.jsonl"
    const { io, files } = memoryIo(`${serializeDecisionEvent(opened("D1"))}{"type":"risp`)
    await appendDecisionEvent(io, path, answered("D1", "ok"))
    const loaded = await loadDecisions(io, path)
    expect(loaded.problems).toEqual([{ line: 2, reason: "JSON non valido" }])
    expect(loaded.state.decisions[0]!.status).toBe("risposta")
    expect(files.get(path)!.endsWith("\n")).toBe(true)
  })

  test("with a real append, a line Master added from the shell after ADE read the file stays", async () => {
    const path = "/p/.ade/decisions.jsonl"
    let disk = serializeDecisionEvent(opened("D1"))
    const io: DecisionsIo = {
      readTextFile: async () => {
        const snapshot = { text: disk, truncated: false }
        // The shell appends right after ADE's read.
        disk += serializeDecisionEvent(opened("D2"))
        return snapshot
      },
      writeTextFile: async (_, contents) => {
        disk = contents
        return null
      },
      appendTextFile: async (_, text) => {
        disk += text
        return null
      },
    }
    await appendDecisionEvent(io, path, answered("D1", "sì"))
    expect(parseDecisionLog(disk).events.map((event) => `${event.type} ${event.k}`)).toEqual([
      "aperta D1",
      "aperta D2",
      "risposta D1",
    ])
  })

  test("a host write failure is reported, a truncated read is refused", async () => {
    const path = "/p/.ade/decisions.jsonl"
    const failing: DecisionsIo = {
      readTextFile: async () => ({ text: "", truncated: false }),
      writeTextFile: async () => "fuori dal progetto: /p/.ade/decisions.jsonl",
    }
    await expect(appendDecisionEvent(failing, path, opened("D1"))).rejects.toThrow("fuori dal progetto")
    const huge: DecisionsIo = { ...failing, readTextFile: async () => ({ text: "x", truncated: true }) }
    await expect(loadDecisions(huge, path)).rejects.toThrow("supera 8 MB")
  })
})

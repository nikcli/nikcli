import { describe, expect, test } from "bun:test"
import type { ParseResult } from "../intent/parse"
import { VOCABULARY, type VoiceIntentSpec } from "../intent/vocabulary"
import { dispatch, resolveTargetPane } from "./dispatch"
import type { PaneSummary, VoiceHost, VoiceStateSnapshot } from "./host"

class MockVoiceHost implements VoiceHost {
  calls: { method: string; args: any[] }[] = []
  panes: PaneSummary[] = [
    {
      id: "pane-1",
      title: "Bastelli Worker",
      status: "working",
      index: 1,
      hasLiveProcess: true,
      isBrowser: false,
      isFile: false,
    },
    {
      id: "pane-2",
      title: "Browser Preview",
      status: "done",
      index: 2,
      hasLiveProcess: false,
      isBrowser: true,
      isFile: false,
    },
  ]

  async runCommand(id: string): Promise<void> {
    this.calls.push({ method: "runCommand", args: [id] })
  }

  listPanes(): PaneSummary[] {
    this.calls.push({ method: "listPanes", args: [] })
    return this.panes
  }

  focusPane(paneId: string): void {
    this.calls.push({ method: "focusPane", args: [paneId] })
  }

  async sendPrompt(paneId: string, text: string): Promise<void> {
    this.calls.push({ method: "sendPrompt", args: [paneId, text] })
  }

  async insertText(paneId: string, text: string): Promise<void> {
    this.calls.push({ method: "insertText", args: [paneId, text] })
  }

  async openFile(path: string): Promise<void> {
    this.calls.push({ method: "openFile", args: [path] })
  }

  async searchProject(query: string): Promise<{ path: string; line?: number }[]> {
    this.calls.push({ method: "searchProject", args: [query] })
    return [{ path: "src/index.ts", line: 10 }]
  }

  setPaneView(paneId: string, view: "transcript" | "diff"): void {
    this.calls.push({ method: "setPaneView", args: [paneId, view] })
  }

  browserNavigate(paneId: string, url: string): void {
    this.calls.push({ method: "browserNavigate", args: [paneId, url] })
  }

  answerPermission(paneId: string, answer: "allow" | "deny"): void {
    this.calls.push({ method: "answerPermission", args: [paneId, answer] })
  }

  setColumns(columns?: number): void {
    this.calls.push({ method: "setColumns", args: [columns] })
  }

  setView(view: "agent" | "code" | "chat" | "bot"): void {
    this.calls.push({ method: "setView", args: [view] })
  }

  scrollTranscript(paneId: string, delta: number): void {
    this.calls.push({ method: "scrollTranscript", args: [paneId, delta] })
  }

  describeState(): VoiceStateSnapshot {
    this.calls.push({ method: "describeState", args: [] })
    return {
      totalSessions: 2,
      workingSessions: 1,
      waitingSessions: 0,
      doneSessions: 1,
      errorSessions: 0,
      currentView: "code",
      spokenSummary: "Ci sono 2 sessioni attive su ADE.",
    }
  }
}

function makeParseResult(spec: VoiceIntentSpec, slots: Record<string, any> = {}): ParseResult {
  return {
    outcome: "matched",
    intent: spec,
    slots,
    confidence: 1.0,
    candidates: [{ intent: spec, confidence: 1.0, matchedPhrase: spec.phrases[0] }],
    rawUtterance: spec.phrases[0],
    normalizedUtterance: spec.phrases[0],
  }
}

describe("dispatch", () => {
  describe("target pane resolution", () => {
    test("resolves pane by 1-based index", () => {
      const host = new MockVoiceHost()
      const resolved = resolveTargetPane({ paneIndex: 2 }, host.panes)
      expect(resolved.pane?.id).toBe("pane-2")
      expect(resolved.pane?.index).toBe(2)
    })

    test("resolves pane by title with fuzzy matching", () => {
      const host = new MockVoiceHost()
      const resolved = resolveTargetPane({ paneTitle: "bastelli" }, host.panes)
      expect(resolved.pane?.id).toBe("pane-1")
      expect(resolved.pane?.title).toBe("Bastelli Worker")
    })

    test("returns spoken error when pane does not exist", () => {
      const host = new MockVoiceHost()
      const resolved = resolveTargetPane({ paneIndex: 99 }, host.panes)
      expect(resolved.pane).toBeUndefined()
      expect(resolved.error).toContain("Pannello numero 99 non trovato")
    })

    /*
     * «Uccidi il processo», detto senza nominare un pannello e senza fuoco,
     * ricadeva su `panes[0]` — con sei sessioni in griglia, quello in alto a
     * sinistra, quasi mai quello a cui si stava pensando. L'agente sbagliato
     * veniva terminato e il suo lavoro perso.
     */
    test("un'azione distruttiva non indovina il pannello", () => {
      const host = new MockVoiceHost()
      const resolved = resolveTargetPane({}, host.panes, undefined, true)
      expect(resolved.pane).toBeUndefined()
      expect(resolved.error).toContain("Non so su quale pannello")
    })

    test("un'azione innocua continua a ripiegare sul primo pannello", () => {
      const host = new MockVoiceHost()
      const resolved = resolveTargetPane({}, host.panes, undefined, false)
      expect(resolved.pane?.id).toBe("pane-1")
      expect(resolved.error).toBeUndefined()
    })

    test("con un solo pannello non c'è ambiguità da risolvere", () => {
      const host = new MockVoiceHost()
      const resolved = resolveTargetPane({}, [host.panes[0]], undefined, true)
      expect(resolved.pane?.id).toBe("pane-1")
      expect(resolved.error).toBeUndefined()
    })

    test("un pannello nominato o a fuoco basta anche per un'azione distruttiva", () => {
      const host = new MockVoiceHost()
      expect(resolveTargetPane({ paneIndex: 2 }, host.panes, undefined, true).pane?.id).toBe("pane-2")
      expect(resolveTargetPane({}, host.panes, "pane-2", true).pane?.id).toBe("pane-2")
    })
  })

  /*
   * Il flag arriva dal vocabolario, così un intento distruttivo aggiunto
   * domani non ricade in silenzio sul ripiego.
   */
  describe("gli intenti distruttivi rifiutano di indovinare", () => {
    test.each(["pane.close", "process.kill", "permission.deny"])(
      "%s chiede quale pannello invece di sceglierne uno",
      async (intent) => {
        const host = new MockVoiceHost()
        const spec = VOCABULARY.find((v) => v.intent === intent)!
        expect(spec.destructive).toBe(true)

        const outcome = await dispatch(makeParseResult(spec), host)

        expect(outcome.success).toBe(false)
        expect(outcome.spoken).toContain("Non so su quale pannello")
        // `listPanes` è una lettura; niente di ciò che cambia lo stato deve
        // essere partito.
        expect(host.calls.filter((c) => c.method !== "listPanes")).toEqual([])
      },
    )

    test("ma li esegue sul pannello a fuoco", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "process.kill")!
      const outcome = await dispatch(makeParseResult(spec), host, { focusedPaneId: "pane-1" })

      expect(outcome.success).toBe(true)
      expect(host.calls.some((c) => c.method === "focusPane" && c.args[0] === "pane-1")).toBe(true)
    })
  })

  test("«tema chiaro» imposta il tema chiaro, «cambia tema» lo inverte", async () => {
    const spec = VOCABULARY.find((v) => v.intent === "theme.toggle")!
    const light = new MockVoiceHost()
    const outcome = await dispatch(makeParseResult(spec, { text: "light" }), light)
    expect(outcome.success).toBe(true)
    expect(light.calls).toContainEqual({ method: "runCommand", args: ["theme.set.light"] })

    const dark = new MockVoiceHost()
    await dispatch(makeParseResult(spec, { text: "dark" }), dark)
    expect(dark.calls).toContainEqual({ method: "runCommand", args: ["theme.set.dark"] })

    const flip = new MockVoiceHost()
    await dispatch(makeParseResult(spec, {}), flip)
    expect(flip.calls).toContainEqual({ method: "runCommand", args: ["theme.toggle"] })
  })

  describe("non dice fatto quando non ha fatto nulla", () => {
    const run = async (intent: string, slots: Record<string, any>, host = new MockVoiceHost()) => {
      const spec = VOCABULARY.find((v) => v.intent === intent)!
      const outcome = await dispatch(makeParseResult(spec, slots), host)
      return { outcome, host }
    }

    test("terminare un pannello senza processo attivo", async () => {
      const { outcome, host } = await run("process.kill", { paneIndex: 2 })
      expect(outcome.success).toBe(false)
      expect(outcome.spoken).toContain("non ha un processo attivo")
      expect(host.calls.some((c) => c.method === "runCommand")).toBe(false)
    })

    test.each([
      ["permission.allow", "answerPermission"],
      ["permission.deny", "answerPermission"],
      ["pane.view.set", "setPaneView"],
      ["browser.navigate", "browserNavigate"],
    ] as const)("%s quando l'host non ha fatto nulla", async (intent, method) => {
      const host = new MockVoiceHost()
      ;(host as any)[method] = () => false
      const { outcome } = await run(intent, { paneIndex: 1, text: "diff", url: "http://localhost:5173" }, host)
      expect(outcome.success).toBe(false)
    })

    test.each(["dialog.confirm", "dialog.cancel", "dictation.finish"])("%s senza nulla in corso", async (intent) => {
      const { outcome } = await run(intent, {})
      expect(outcome.success).toBe(false)
      expect(outcome.spoken).toStartWith("Non c'è")
    })

    test("progetto recente senza nome apre la scelta del progetto", async () => {
      const { outcome, host } = await run("project.recent", {})
      expect(outcome.success).toBe(true)
      expect(host.calls).toContainEqual({ method: "runCommand", args: ["project.open"] })
    })

    test("una ricerca che non può partire è un errore, non zero risultati", async () => {
      const host = new MockVoiceHost()
      host.searchProject = async () => {
        throw new Error("non c'è nessun progetto aperto in cui cercare")
      }
      const { outcome } = await run("project.search", { text: "x" }, host)
      expect(outcome.success).toBe(false)
      expect(outcome.spoken).toContain("nessun progetto aperto")
    })
  })

  describe("host method coverage", () => {
    test("dispatches runCommand for session.new", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "session.new")!
      const outcome = await dispatch(makeParseResult(spec), host)

      expect(outcome.success).toBe(true)
      expect(host.calls.some((c) => c.method === "runCommand" && c.args[0] === "session.new")).toBe(true)
    })

    test("dispatches focusPane", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "pane.focus")!
      const outcome = await dispatch(makeParseResult(spec, { paneIndex: 1 }), host)

      expect(outcome.success).toBe(true)
      expect(host.calls.some((c) => c.method === "focusPane" && c.args[0] === "pane-1")).toBe(true)
    })

    test("dispatches sendPrompt", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "prompt.send")!
      const outcome = await dispatch(makeParseResult(spec, { paneIndex: 1, text: "esegui il build" }), host)

      expect(outcome.success).toBe(true)
      expect(
        host.calls.some((c) => c.method === "sendPrompt" && c.args[0] === "pane-1" && c.args[1] === "esegui il build"),
      ).toBe(true)
    })

    test("dispatches openFile", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "file.open")!
      const outcome = await dispatch(makeParseResult(spec, { path: "src/main.ts" }), host)

      expect(outcome.success).toBe(true)
      expect(host.calls.some((c) => c.method === "openFile" && c.args[0] === "src/main.ts")).toBe(true)
    })

    test("dispatches searchProject", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "project.search")!
      const outcome = await dispatch(makeParseResult(spec, { text: "fuzzyMatch" }), host)

      expect(outcome.success).toBe(true)
      expect(host.calls.some((c) => c.method === "searchProject" && c.args[0] === "fuzzyMatch")).toBe(true)
    })

    test("dispatches browserNavigate", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "browser.navigate")!
      const outcome = await dispatch(makeParseResult(spec, { url: "http://localhost:5173", paneIndex: 2 }), host)

      expect(outcome.success).toBe(true)
      expect(
        host.calls.some(
          (c) => c.method === "browserNavigate" && c.args[0] === "pane-2" && c.args[1] === "http://localhost:5173",
        ),
      ).toBe(true)
    })

    test("dispatches answerPermission allow", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "permission.allow")!
      const outcome = await dispatch(makeParseResult(spec, { paneIndex: 1 }), host)

      expect(outcome.success).toBe(true)
      expect(
        host.calls.some((c) => c.method === "answerPermission" && c.args[0] === "pane-1" && c.args[1] === "allow"),
      ).toBe(true)
    })

    test("dispatches answerPermission deny", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "permission.deny")!
      const outcome = await dispatch(makeParseResult(spec, { paneIndex: 1 }), host)

      expect(outcome.success).toBe(true)
      expect(
        host.calls.some((c) => c.method === "answerPermission" && c.args[0] === "pane-1" && c.args[1] === "deny"),
      ).toBe(true)
    })

    test("dispatches setColumns", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "grid.columns.set")!
      const outcome = await dispatch(makeParseResult(spec, { columns: 3 }), host)

      expect(outcome.success).toBe(true)
      expect(host.calls.some((c) => c.method === "setColumns" && c.args[0] === 3)).toBe(true)
    })

    test("dispatches setView", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "view.set")!
      const outcome = await dispatch(makeParseResult(spec, { text: "bot" }), host)

      expect(outcome.success).toBe(true)
      expect(host.calls.some((c) => c.method === "setView" && c.args[0] === "bot")).toBe(true)
    })

    test("a section the host has hidden is refused and said, not switched to", async () => {
      const host = new MockVoiceHost()
      const hiding = Object.assign(host, { availableViews: () => ["agent", "code"] as const })
      const spec = VOCABULARY.find((v) => v.intent === "view.set")!

      const chat = await dispatch(makeParseResult(spec, { text: "chat" }), hiding)
      expect(chat.success).toBe(false)
      expect(chat.spoken).toBe("La sezione chat non è disponibile per ora.")
      expect(host.calls.some((c) => c.method === "setView")).toBe(false)

      const code = await dispatch(makeParseResult(spec, { text: "code" }), hiding)
      expect(code.success).toBe(true)
      expect(host.calls.some((c) => c.method === "setView" && c.args[0] === "code")).toBe(true)
    })

    test("dispatches scrollTranscript", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "transcript.scroll")!
      const outcome = await dispatch(makeParseResult(spec, { paneIndex: 1, text: "up" }), host)

      expect(outcome.success).toBe(true)
      expect(host.calls.some((c) => c.method === "scrollTranscript" && c.args[0] === "pane-1")).toBe(true)
    })

    test("dispatches describeState", async () => {
      const host = new MockVoiceHost()
      const spec = VOCABULARY.find((v) => v.intent === "state.describe")!
      const outcome = await dispatch(makeParseResult(spec), host)

      expect(outcome.success).toBe(true)
      expect(host.calls.some((c) => c.method === "describeState")).toBe(true)
      expect(outcome.spoken).toContain("Ci sono 2 sessioni")
    })
  })

  describe("100% vocabulary coverage", () => {
    test("every single intent in VOCABULARY dispatches to VoiceHost or returns a spoken dialog reply", async () => {
      const host = new MockVoiceHost()

      for (const spec of VOCABULARY) {
        const dummySlots: Record<string, any> = {}
        if (spec.slots.includes("paneIndex")) dummySlots.paneIndex = 1
        if (spec.slots.includes("text")) dummySlots.text = "test query"
        if (spec.slots.includes("path")) dummySlots.path = "test/path.ts"
        if (spec.slots.includes("url")) dummySlots.url = "http://localhost:3000"
        if (spec.slots.includes("columns")) dummySlots.columns = 2

        const outcome = await dispatch(makeParseResult(spec, dummySlots), host)

        // Outside a confirmation or a dictation these have nothing to act on.
        const nothingPending = ["dialog.confirm", "dialog.cancel", "dictation.finish"].includes(spec.intent)
        expect(outcome.success).toBe(!nothingPending)
        expect(outcome.spoken).toBeDefined()
        expect(outcome.spoken.length).toBeGreaterThan(0)
      }
    })
  })
})

describe("a command that threw", () => {
  test("is said in plain words, never with the raw error", async () => {
    const { plainFailure } = await import("./dispatch")
    expect(plainFailure("TypeError: Cannot read properties of undefined (reading 'id')")).toBe(
      "Non sono riuscito a farlo in ADE: trovi il dettaglio nella console.",
    )
    expect(plainFailure("Failed to fetch")).toBe(
      "Non sono riuscito a farlo. Non ho rete in questo momento: ti sento appena torna.",
    )
    expect(plainFailure(undefined)).not.toContain("undefined")
    expect(plainFailure("ENOENT: no such file, open 'C:/x'")).toBe(
      "Non sono riuscito a farlo in ADE: trovi il dettaglio nella console.",
    )
    expect(plainFailure("non c'è nessun progetto aperto")).toBe(
      "Non sono riuscito a farlo: non c'è nessun progetto aperto",
    )
  })
})

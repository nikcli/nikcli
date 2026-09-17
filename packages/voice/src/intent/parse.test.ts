import { describe, expect, test } from "bun:test"
import type { PaneSummary } from "../bridge/host"
import { parseUtterance } from "./parse"

describe("parseUtterance", () => {
  test("the panels of the + menu each have a phrase, and the old ones keep theirs", () => {
    const cases: [string, string][] = [
      ["apri il video", "video.new"],
      ["apri il modello 3D", "model.new"],
      ["apri il simulatore", "app.new"],
      ["apri le decisioni", "decisions.open"],
      ["apri il browser", "browser.new"],
      ["vai al pannello 2", "pane.focus"],
    ]
    for (const [sentence, intent] of cases) {
      const parsed = parseUtterance(sentence)
      expect([sentence, parsed.outcome, parsed.intent?.intent]).toEqual([sentence, "matched", intent])
    }
  })

  describe("synonyms and variants", () => {
    test("matches 'nuova sessione' and synonyms", () => {
      const res1 = parseUtterance("nuova sessione")
      expect(res1.outcome).toBe("matched")
      expect(res1.intent?.intent).toBe("session.new")

      const res2 = parseUtterance("avvia sessione")
      expect(res2.outcome).toBe("matched")
      expect(res2.intent?.intent).toBe("session.new")

      const res3 = parseUtterance("crea nuova sessione")
      expect(res3.outcome).toBe("matched")
      expect(res3.intent?.intent).toBe("session.new")
    })

    test("matches 'browser' with imperative and infinitive forms", () => {
      const res1 = parseUtterance("apri il browser")
      expect(res1.outcome).toBe("matched")
      expect(res1.intent?.intent).toBe("browser.new")

      const res2 = parseUtterance("aprire il browser")
      expect(res2.outcome).toBe("matched")
      expect(res2.intent?.intent).toBe("browser.new")

      const res3 = parseUtterance("browser")
      expect(res3.outcome).toBe("matched")
      expect(res3.intent?.intent).toBe("browser.new")
    })
  })

  describe("speech recognition distortions (fuzzy match)", () => {
    test("tolerates slight typos in spoken commands", () => {
      // Missing letter 'u' in 'chiudi'
      const res = parseUtterance("chidi pannello 2")
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("pane.close")
      expect(res.slots.paneIndex).toBe(2)
    })

    test("tolerates conversational prefix with fillers", () => {
      const res = parseUtterance("Ehm, allora per favore apri la tavolozza dei comandi")
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("palette.open")
    })
  })

  describe("slot extraction", () => {
    test("«tema chiaro» and «tema scuro» name the theme they want", () => {
      expect(parseUtterance("tema chiaro").slots.text).toBe("light")
      expect(parseUtterance("modalità scura").slots.text).toBe("dark")
      expect(parseUtterance("cambia tema").slots.text).toBeUndefined()
    })

    test("«cerca file X» searches for X instead of losing it to a file path", () => {
      const search = parseUtterance("cerca file parser")
      expect(search.intent?.intent).toBe("project.search")
      expect(search.slots.text).toBe("parser")
      expect(search.slots.path).toBeUndefined()

      const withArticle = parseUtterance("cerca il file parser")
      expect(withArticle.intent?.intent).toBe("project.search")
      expect(withArticle.slots.text).toBe("parser")
      expect(withArticle.slots.path).toBeUndefined()

      // Opening a file still takes its path.
      expect(parseUtterance("apri file src/bridge/host.ts").slots.path).toBe("src/bridge/host.ts")
    })

    test("extracts paneIndex from written and numeric numbers", () => {
      const res1 = parseUtterance("chiudi il pannello 3")
      expect(res1.slots.paneIndex).toBe(3)

      const res2 = parseUtterance("passa al pannello due")
      expect(res2.slots.paneIndex).toBe(2)
    })

    test("extracts paneTitle from context panes", () => {
      const samplePanes: PaneSummary[] = [
        {
          id: "pane-1",
          title: "Bastelli",
          status: "working",
          index: 1,
          hasLiveProcess: true,
          isBrowser: false,
          isFile: false,
        },
        {
          id: "pane-2",
          title: "Test Runner",
          status: "idle" as any,
          index: 2,
          hasLiveProcess: false,
          isBrowser: false,
          isFile: false,
        },
      ]

      const res = parseUtterance("vai su Bastelli", { panes: samplePanes })
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("pane.focus")
      expect(res.slots.paneTitle).toBe("Bastelli")
      expect(res.slots.paneIndex).toBe(1)
    })

    test("extracts columns slot", () => {
      const res = parseUtterance("imposta 3 colonne")
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("grid.columns.set")
      expect(res.slots.columns).toBe(3)
    })

    test("extracts url slot", () => {
      const res = parseUtterance("vai all'indirizzo http://localhost:3000")
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("browser.navigate")
      expect(res.slots.url).toBe("http://localhost:3000")
    })

    test("extracts path slot for file open", () => {
      const res = parseUtterance("apri file src/bridge/host.ts")
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("file.open")
      expect(res.slots.path).toBe("src/bridge/host.ts")
    })

    test("extracts prompt text slot", () => {
      const res = parseUtterance("invia prompt fai il refactor di auth")
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("prompt.send")
      expect(res.slots.text).toBe("fai il refactor di auth")
    })
  })

  describe("contextual permissions", () => {
    test("resolves 'conferma' to permission.allow when pendingPermission is true", () => {
      const res = parseUtterance("conferma", { pendingPermission: true, pendingPermissionPaneId: "p-42" })
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("permission.allow")
      expect(res.slots.paneId).toBe("p-42")
    })

    test("resolves 'nega' to permission.deny when pendingPermission is true", () => {
      const res = parseUtterance("nega", { pendingPermission: true, pendingPermissionPaneId: "p-42" })
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("permission.deny")
      expect(res.slots.paneId).toBe("p-42")
    })

    test("resolves 'conferma' to dialog.confirm when no permission is pending", () => {
      const res = parseUtterance("conferma", { pendingPermission: false })
      expect(res.outcome).toBe("matched")
      expect(res.intent?.intent).toBe("dialog.confirm")
    })
  })

  describe("unknown and ambiguous utterances", () => {
    test("returns unknown on gibberish", () => {
      const res = parseUtterance("paracadute spaziale astronomico xyz")
      expect(res.outcome).toBe("unknown")
    })

    test("returns unknown on empty input", () => {
      const res = parseUtterance("")
      expect(res.outcome).toBe("unknown")
    })
  })
})

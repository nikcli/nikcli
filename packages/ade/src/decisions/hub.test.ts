import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createDecisionsHub } from "./hub"
import type { DecisionEvent } from "./log"
import { createDecisionsRegister } from "./register"
import type { Decision } from "./state"
import type { DecisionsIo } from "./store"

const opened = (k: string) =>
  `${JSON.stringify({ type: "aperta", k, at: "2026-09-15T10:00:00.000Z", by: "Master", title: `T ${k}`, options: [{ label: "A" }, { label: "B" }] })}\n`

function memory(initial: string) {
  const files = new Map([["/p/.ade/decisions.jsonl", initial]])
  const io: DecisionsIo = {
    readTextFile: async (path) => ({ text: files.get(path) ?? "", truncated: false }),
    writeTextFile: async (path, contents) => {
      files.set(path, contents)
      return null
    },
    appendTextFile: async (path, text) => {
      files.set(path, (files.get(path) ?? "") + text)
      return null
    },
  }
  return { io, files }
}

describe("the register and the hub", () => {
  test("an answer is written from the draft, the draft is cleared and the message is queued", async () => {
    const { io, files } = memory(opened("D1"))
    const answered: DecisionEvent[] = []
    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({ path: () => "/p/.ade/decisions.jsonl", io: async () => io })
      const hub = createDecisionsHub({
        register,
        recipient: () => ({ state: "non scelta" }),
        sessions: () => [],
        choose: () => {},
        delivery: () => ({ state: "in coda" }),
        onAnswered: (_, event) => void answered.push(event),
      })
      await register.refresh()
      const decision = register.state()!.decisions[0] as Decision

      expect(await hub.answer(decision)).toBe(false)
      expect(hub.problem("D1")).toBe("scegli un'opzione o scrivi la risposta")

      hub.setDraft("D1", { picked: 1, note: "subito" })
      expect(hub.problem("D1")).toBeUndefined()
      expect(await hub.answer(decision)).toBe(true)
      expect(hub.draft("D1")).toEqual({ note: "" })
      expect(register.state()!.decisions[0]!.status).toBe("risposta")
      expect(answered.map((event) => (event as { words: string }).words)).toEqual(["B — subito"])
      expect(files.get("/p/.ade/decisions.jsonl")!.trim().split("\n")).toHaveLength(2)

      // A second answer on top is refused by the register and shown on the card.
      hub.setDraft("D1", { picked: 0, note: "" })
      expect(await hub.answer(decision)).toBe(false)
      expect(hub.problem("D1")).toBe("D1 ha già una risposta: prima va riaperta")
      dispose()
    })
  })

  test("a read that finishes after the project changed is dropped", async () => {
    const { io } = memory(opened("D1"))
    let path = "/p/.ade/decisions.jsonl"
    const slow: DecisionsIo = {
      ...io,
      readTextFile: async (file, max) => {
        path = "/q/.ade/decisions.jsonl"
        return io.readTextFile(file, max)
      },
    }
    await createRoot(async (dispose) => {
      const register = createDecisionsRegister({ path: () => path, io: async () => slow })
      await register.refresh()
      expect(register.loaded()).toBeUndefined()
      dispose()
    })
  })
})

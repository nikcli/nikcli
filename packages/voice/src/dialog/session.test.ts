import { describe, expect, test } from "bun:test"
import {
  createInitialDialogState,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  transition,
} from "./session"

describe("dialog state machine", () => {
  describe("wake and sleep cycles", () => {
    test("wakes from sleep on wake event", () => {
      const s0 = createInitialDialogState("asleep")
      const { state: s1, effects } = transition(s0, { type: "wake" }, 1000)

      expect(s1.status).toBe("idle")
      expect(effects.some((e) => e.type === "speak" && e.text.includes("sveglio"))).toBe(true)
    })

    test("wakes from sleep on spoken wake utterance", () => {
      const s0 = createInitialDialogState("asleep")
      const { state: s1, effects } = transition(s0, { type: "utterance", text: "svegliati" }, 1000)

      expect(s1.status).toBe("idle")
      expect(effects.some((e) => e.type === "speak")).toBe(true)
    })

    test("ignores normal commands while asleep", () => {
      const s0 = createInitialDialogState("asleep")
      const { state: s1, effects } = transition(
        s0,
        { type: "utterance", text: "nuova sessione" },
        1000
      )

      expect(s1.status).toBe("asleep")
      expect(effects.length).toBe(0)
    })

    test("goes to sleep on sleep utterance", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(s0, { type: "utterance", text: "vai a dormire" }, 1000)

      expect(s1.status).toBe("asleep")
    })
  })

  describe("destructive actions confirmation flow", () => {
    test("destructive intent 'uccidi processo' requires confirmation and does not execute directly", () => {
      const s0 = createInitialDialogState("idle")
      const now = 10_000
      const { state: s1, effects } = transition(
        s0,
        { type: "utterance", text: "uccidi processo" },
        now
      )

      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction).toBeDefined()
      expect(s1.pendingAction?.intent.intent).toBe("process.kill")
      expect(s1.timeoutAt).toBe(now + DEFAULT_CONFIRMATION_TIMEOUT_MS)

      // Must start timer
      expect(effects.some((e) => e.type === "start_timer")).toBe(true)
      // Must NOT execute directly
      expect(effects.some((e) => e.type === "execute_intent")).toBe(false)
      // Must warn user
      // Must ask about this action by name, as a question — not restate the
      // readback, which is a statement and reads as broken Italian in a prompt.
      expect(
        effects.some(
          (e) => e.type === "speak" && e.text.includes("Fermo il processo") && e.text.includes("?")
        )
      ).toBe(true)
    })

    test("confirming a destructive action with 'si' executes the intent", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "utterance", text: "chiudi pannello 2" },
        10_000
      )

      expect(s1.status).toBe("confirming")

      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "utterance", text: "si" },
        12_000
      )

      expect(s2.status).toBe("executing")
      expect(s2.pendingAction).toBeUndefined()
      expect(e2.some((e) => e.type === "cancel_timer")).toBe(true)
      const execEffect = e2.find((e) => e.type === "execute_intent")
      expect(execEffect).toBeDefined()
      if (execEffect && execEffect.type === "execute_intent") {
        expect(execEffect.intent.intent).toBe("pane.close")
        expect(execEffect.slots.paneIndex).toBe(2)
      }
    })

    test("cancelling a destructive action with 'annulla' returns to idle without executing", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "utterance", text: "uccidi processo" },
        10_000
      )

      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "utterance", text: "annulla" },
        12_000
      )

      expect(s2.status).toBe("idle")
      expect(s2.pendingAction).toBeUndefined()
      expect(e2.some((e) => e.type === "cancel_timer")).toBe(true)
      expect(e2.some((e) => e.type === "execute_intent")).toBe(false)
    })

    test("timeout during confirmation automatically aborts to idle", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "utterance", text: "chiudi pannello" },
        10_000
      )

      const timeoutTime = 10_000 + DEFAULT_CONFIRMATION_TIMEOUT_MS + 1
      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "timeout" },
        timeoutTime
      )

      expect(s2.status).toBe("idle")
      expect(s2.pendingAction).toBeUndefined()
      expect(e2.some((e) => e.type === "execute_intent")).toBe(false)
      expect(e2.some((e) => e.type === "speak" && e.text.includes("lascio stare"))).toBe(true)
    })
  })

  describe("dictation mode", () => {
    test("accumulates text without interpreting as commands until finish phrase", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1, effects: e1 } = transition(
        s0,
        { type: "utterance", text: "inizia dettatura pannello 1" },
        1000
      )

      expect(s1.status).toBe("dictating")
      expect(s1.dictation).toBeDefined()
      expect(s1.dictation?.paneId).toBe("1")
      expect(e1.some((e) => e.type === "speak")).toBe(true)

      // Speak words that would normally be commands
      const { state: s2 } = transition(
        s1,
        { type: "utterance", text: "crea un test e chiudi il pannello" },
        2000
      )
      expect(s2.status).toBe("dictating")
      expect(s2.dictation?.chunks).toEqual(["crea un test e chiudi il pannello"])

      const { state: s3 } = transition(
        s2,
        { type: "utterance", text: "poi aggiungi la funzione di login" },
        3000
      )
      expect(s3.dictation?.chunks).toEqual([
        "crea un test e chiudi il pannello",
        "poi aggiungi la funzione di login",
      ])

      // Finish dictation
      const { state: s4, effects: e4 } = transition(
        s3,
        { type: "utterance", text: "fine dettatura" },
        4000
      )

      expect(s4.status).toBe("idle")
      expect(s4.dictation).toBeUndefined()
      const promptEffect = e4.find((e) => e.type === "send_prompt")
      expect(promptEffect).toBeDefined()
      if (promptEffect && promptEffect.type === "send_prompt") {
        expect(promptEffect.paneId).toBe("1")
        expect(promptEffect.text).toBe(
          "crea un test e chiudi il pannello poi aggiungi la funzione di login"
        )
      }
    })
  })

  describe("pending permission precedence", () => {
    test("permission request immediately forces confirming state", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1, effects: e1 } = transition(
        s0,
        { type: "permission_requested", paneId: "agent-1", what: "rm -rf tmp" },
        5000
      )

      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction?.isPermission).toBe(true)
      expect(s1.pendingAction?.paneId).toBe("agent-1")
      expect(e1.some((e) => e.type === "speak" && e.text.includes("rm -rf tmp"))).toBe(true)

      // User says 'consenti'
      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "utterance", text: "consenti" },
        6000
      )

      expect(s2.status).toBe("idle")
      const ansEffect = e2.find((e) => e.type === "answer_permission")
      expect(ansEffect).toBeDefined()
      if (ansEffect && ansEffect.type === "answer_permission") {
        expect(ansEffect.paneId).toBe("agent-1")
        expect(ansEffect.answer).toBe("allow")
      }
    })

    test("denying permission sends deny answer", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "permission_requested", paneId: "agent-1", what: "curl http://malicious.test" },
        5000
      )

      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "utterance", text: "rifiuta" },
        6000
      )

      expect(s2.status).toBe("idle")
      const ansEffect = e2.find((e) => e.type === "answer_permission")
      expect(ansEffect).toBeDefined()
      if (ansEffect && ansEffect.type === "answer_permission") {
        expect(ansEffect.paneId).toBe("agent-1")
        expect(ansEffect.answer).toBe("deny")
      }
    })
  })

  describe("repeat last spoken", () => {
    test("repeats the last message spoken by the system", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(s0, { type: "utterance", text: "apri browser" }, 1000)
      expect(s1.lastSpokenText).toBeDefined()

      // Execution completes
      const { state: s1Done } = transition(s1, { type: "command_success" }, 1500)

      const { effects: e2 } = transition(s1Done, { type: "utterance", text: "ripeti" }, 2000)
      const repeatEffect = e2.find((e) => e.type === "speak")
      expect(repeatEffect?.text).toBe(s1.lastSpokenText!)
    })
  })
})

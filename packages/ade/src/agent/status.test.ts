import { describe, expect, test } from "bun:test"
import { presenceLabel, presenceOf } from "./status"

describe("presenceOf", () => {
  test("a closed microphone is never described as listening", () => {
    // The dialogue state survives a stop, so reading it alone makes the panel
    // claim it is listening at a microphone that is shut.
    expect(presenceOf({ running: false, status: "listening" })).toBe("off")
    expect(presenceOf({ running: false, status: "executing" })).toBe("off")
  })

  test("reports the dialogue state while running", () => {
    expect(presenceOf({ running: true, status: "confirming" })).toBe("confirming")
    expect(presenceOf({ running: true, status: "asleep" })).toBe("asleep")
  })

  test("an unknown state reads as idle rather than crashing the panel", () => {
    expect(presenceOf({ running: true, status: "qualcosa-di-nuovo" })).toBe("idle")
  })
})

describe("presenceLabel", () => {
  test("every presence has a label and a tone", () => {
    for (const presence of ["off", "asleep", "idle", "listening", "confirming", "dictating", "executing"] as const) {
      const label = presenceLabel(presence)
      expect(label.text.length).toBeGreaterThan(0)
      expect(["idle", "working", "waiting", "done", "error"]).toContain(label.tone)
    }
  })

  test("waiting for a confirmation is not shown as an error", () => {
    // It is a question, not a failure: colouring it red teaches people to
    // dread a prompt that exists to protect them.
    expect(presenceLabel("confirming").tone).toBe("waiting")
  })
})

import { describe, expect, it } from "bun:test"
import { cleanScreenSequence } from "./registry"

/*
 * A restarted pane: the new process is told its cursor is at 1;1 (`pty.rs`),
 * so the old run has to be out of the way before it draws.
 */
describe("cleanScreenSequence", () => {
  it("scrolls every visible row out, then goes home", () => {
    const sequence = cleanScreenSequence(30, true)
    expect(sequence.match(/\r\n/g)?.length).toBe(30)
    expect(sequence.endsWith("[H")).toBe(true)
    // Erasing would lose the last run; only newlines and a cursor move.
    expect(sequence).not.toContain("[2J")
    expect(sequence).not.toContain("[3J")
  })

  it("leaves a terminal nothing has written to as it is", () => {
    expect(cleanScreenSequence(30, false)).toBe("")
  })

  it("still moves a screen that has not been measured yet", () => {
    expect(cleanScreenSequence(0, true)).toBe("\r\n[H")
  })
})

import { describe, expect, test } from "bun:test"
import { MAX_PENDING_CHARS, createLineAccumulator } from "./line-stream"

const ESC = "\x1b"

describe("createLineAccumulator", () => {
  test("splits complete lines and holds the remainder", () => {
    const acc = createLineAccumulator()
    expect(acc.push("prima\nseconda\nter")).toEqual(["prima", "seconda"])
    expect(acc.push("za\n")).toEqual(["terza"])
  })

  test("strips escape sequences from what it emits", () => {
    const acc = createLineAccumulator()
    expect(acc.push(`${ESC}[32mfatto${ESC}[0m\n`)).toEqual(["fatto"])
  })

  /*
   * The bug this file exists for. Windows pty output is CRLF, an 8 KB read
   * lands between the two often enough to matter, and the old code stripped
   * each chunk on arrival: a trailing `\r` then looked like a carriage return
   * with no newline — a redraw — and the rule for those deletes everything in
   * front of it. The whole line disappeared from `onLine`, while the xterm
   * pane showed it as normal, so the loss was invisible and nondeterministic.
   */
  test("a CRLF split across two chunks does not eat the line", () => {
    const acc = createLineAccumulator()
    expect(acc.push("riga importante\r")).toEqual([])
    expect(acc.push("\nriga dopo\r\n")).toEqual(["riga importante", "riga dopo"])
  })

  test("a real redraw still collapses to the last version", () => {
    const acc = createLineAccumulator()
    expect(acc.push("10%\r55%\r100%\n")).toEqual(["100%"])
  })

  /*
   * Stripping per chunk also broke any escape sequence that straddled a read,
   * leaving both halves in the transcript as literal text. Held raw until a
   * newline, the sequence is whole by the time anything looks at it.
   */
  test("an escape sequence split across chunks is still removed", () => {
    const acc = createLineAccumulator()
    expect(acc.push(`${ESC}[3`)).toEqual([])
    expect(acc.push("2mverde\n")).toEqual(["verde"])
  })

  /*
   * A ratatui agent redraws its whole screen with cursor moves and never
   * emits a newline. Unbounded, the buffer grew for the length of the
   * session, was re-split on every chunk — quadratic — and `onLine` never
   * fired once: no permission detection and no token counting for exactly
   * the agents that need them most.
   */
  test("output that never ends a line is emitted anyway, once", () => {
    const acc = createLineAccumulator(100)
    expect(acc.push("x".repeat(50))).toEqual([])

    const emitted = acc.push("y".repeat(60))
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toHaveLength(110)

    // And the buffer is empty afterwards, so it does not grow without bound.
    expect(acc.push("z")).toEqual([])
    expect(acc.flush()).toEqual(["z"])
  })

  /*
   * The overflow cut is the one place left where a sequence can be split in
   * half, because it falls wherever the cap happens to land rather than on a
   * line boundary. Half of `ESC[38;2;128;128;128m` survives the strip as
   * `;128m`, which is how a colour code came to be read as something the
   * agent had said.
   */
  test("the overflow cut does not fall inside an escape sequence", () => {
    const acc = createLineAccumulator(100)
    const emitted = acc.push("x".repeat(99) + `${ESC}[38;2;128`)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toBe("x".repeat(99))

    // The unfinished sequence was held back, and completes normally.
    expect(acc.push(";128;128mrosso\n")).toEqual(["rosso"])
  })

  test("a lone trailing ESC is held rather than emitted", () => {
    const acc = createLineAccumulator(10)
    expect(acc.push("x".repeat(10) + ESC)).toEqual(["x".repeat(10)])
    expect(acc.push("[0mfatto\n")).toEqual(["fatto"])
  })

  test("an unterminated OSC is not mistaken for a finished two-byte escape", () => {
    const acc = createLineAccumulator(10)
    expect(acc.push("x".repeat(10) + `${ESC}]0;tit`)).toEqual(["x".repeat(10)])
    expect(acc.push(`olo${ESC}\\pronto\n`)).toEqual(["pronto"])
  })

  test("a finished sequence at the very end is not held back", () => {
    const acc = createLineAccumulator(10)
    // Nothing is pending, so the cut stays where the cap put it.
    expect(acc.push("x".repeat(10) + `${ESC}[0m`)).toEqual(["x".repeat(10)])
  })

  test("the default cap is the documented one", () => {
    const acc = createLineAccumulator()
    expect(acc.push("x".repeat(MAX_PENDING_CHARS))).toEqual([])
    expect(acc.push("y")).toHaveLength(1)
  })

  test("flush returns the last partial line, which is usually why it ended", () => {
    const acc = createLineAccumulator()
    acc.push("errore fatale: ")
    expect(acc.flush()).toEqual(["errore fatale: "])
    expect(acc.flush()).toEqual([])
  })

  test("flush says nothing about trailing whitespace alone", () => {
    const acc = createLineAccumulator()
    acc.push("   ")
    expect(acc.flush()).toEqual([])
  })

  test("an empty line between two others is preserved", () => {
    const acc = createLineAccumulator()
    expect(acc.push("a\n\nb\n")).toEqual(["a", "", "b"])
  })
})

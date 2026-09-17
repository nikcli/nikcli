import { describe, expect, test } from "bun:test"
import { cleanTranscript, cleanTranscriptLine, MAX_TRANSCRIPT_LINE } from "./transcript-line"

describe("cleanTranscriptLine", () => {
  test("leaves a line the agent actually wrote alone", () => {
    expect(cleanTranscriptLine("Letto src/parser.ts")).toBe("Letto src/parser.ts")
    expect(cleanTranscriptLine("C:/repo> bun test")).toBe("C:/repo> bun test")
  })

  /*
   * The line that made a restored nikcli session unreadable: a spinner
   * redrawn in place, whose cursor moves `stripAnsi` removed correctly,
   * leaving several hundred braille frames run together as one "line".
   */
  test("a run of spinner frames is not something the agent said", () => {
    expect(cleanTranscriptLine("⠇⠏⠋⠙⠹⠸⠼⠴⠦⠧".repeat(40))).toBeUndefined()
    expect(cleanTranscriptLine("⠋")).toBeUndefined()
  })

  test("a row of a box, or a rule, is a frame and not a sentence", () => {
    expect(cleanTranscriptLine("─".repeat(90))).toBeUndefined()
    expect(cleanTranscriptLine("┃  ┃    ┃")).toBeUndefined()
    expect(cleanTranscriptLine("█║╗╚███████║█╗█╗█╚█║═████╗")).toBeUndefined()
  })

  test("a border around words keeps the words", () => {
    expect(cleanTranscriptLine("│ Build completato │")).toBe("│ Build completato │")
  })

  test("a blank or whitespace-only line carries nothing", () => {
    expect(cleanTranscriptLine("")).toBeUndefined()
    expect(cleanTranscriptLine("        ")).toBeUndefined()
  })

  /*
   * Frames are painted to the full width of the terminal, so nearly every
   * captured line ended in tens of spaces. That padding is most of what the
   * saved state weighed.
   */
  test("the padding a frame is drawn with is not kept", () => {
    expect(cleanTranscriptLine(`pronto${" ".repeat(80)}`)).toBe("pronto")
  })

  test("a flattened frame is cut rather than stored whole", () => {
    const long = `inizio ${"x".repeat(5000)}`
    const cleaned = cleanTranscriptLine(long)
    expect(cleaned).toHaveLength(MAX_TRANSCRIPT_LINE)
    expect(cleaned).toStartWith("inizio ")
    expect(cleaned).toEndWith("…")
  })

  test("a line exactly at the limit is not cut", () => {
    const exact = "a".repeat(MAX_TRANSCRIPT_LINE)
    expect(cleanTranscriptLine(exact)).toBe(exact)
  })

  /*
   * What is left of a sequence the 8 KB overflow cut in half, or of one no
   * rule covers. It is invisible in the terminal and a stray glyph here.
   */
  test("leftover control characters are removed", () => {
    expect(cleanTranscriptLine("pron\u0007to\u0000")).toBe("pronto")
  })

  test("a tab survives, because it is layout the agent chose", () => {
    expect(cleanTranscriptLine("nome\tvalore")).toBe("nome\tvalore")
  })
})

describe("cleanTranscript", () => {
  const line = (text: string) => ({ kind: "step" as const, text })

  test("drops the frames and keeps the words, in order", () => {
    expect(cleanTranscript([line("avvio"), line("─".repeat(40)), line("⠋⠙⠹⠸"), line("fatto")])).toEqual([
      line("avvio"),
      line("fatto"),
    ])
  })

  test("a frame redrawn ten times is one line", () => {
    expect(cleanTranscript(Array.from({ length: 10 }, () => line("In esecuzione")))).toEqual([line("In esecuzione")])
  })

  /*
   * Consecutive only. A command the user genuinely ran twice, with output
   * between the two, is two facts about the session and not a redraw.
   */
  test("the same command run twice with output between is kept twice", () => {
    expect(cleanTranscript([line("bun test"), line("3 pass"), line("bun test")])).toEqual([
      line("bun test"),
      line("3 pass"),
      line("bun test"),
    ])
  })

  test("the other fields of a line survive the clean", () => {
    const [only] = cleanTranscript([{ kind: "shell" as const, text: "ls   ", repeat: 3 }])
    expect(only).toEqual({ kind: "shell", text: "ls", repeat: 3 })
  })

  test("a transcript of nothing but frames comes back empty", () => {
    expect(cleanTranscript([line("⠋⠙"), line("━".repeat(20)), line("   ")])).toEqual([])
  })
})

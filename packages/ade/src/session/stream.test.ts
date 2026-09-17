import { describe, expect, test } from "bun:test"
import {
  stripAnsi,
  parseAnsi,
  classifyLine,
  appendLine,
  emptyBuffer,
  type LineBuffer,
} from "./stream"

describe("stripAnsi", () => {
  test("removes colour codes", () => {
    expect(stripAnsi("\x1b[31mrosso\x1b[0m")).toBe("rosso")
  })

  test("removes bold and reset", () => {
    expect(stripAnsi("\x1b[1mgrassetto\x1b[22m")).toBe("grassetto")
    expect(stripAnsi("\x1b[1mtest\x1b[0m")).toBe("test")
  })

  test("removes cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2Ahello\x1b[K")).toBe("hello")
  })

  test("removes OSC sequences (terminal title)", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text")
    expect(stripAnsi("\x1b]0;title\x1b\\text")).toBe("text")
  })

  test("passes through plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world")
  })

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("")
  })

  test("handles incomplete ANSI sequences at end of line", () => {
    // An ESC followed by [ but no terminator — common in partial flushes
    const result = stripAnsi("text\x1b[32")
    // The incomplete sequence is stripped or left as harmless residue
    expect(result).toContain("text")
  })

  test("strips multiple sequences in one line", () => {
    expect(stripAnsi("\x1b[1m\x1b[31merror\x1b[0m: bad")).toBe("error: bad")
  })

  /*
   * crossterm opens every ratatui session with `ESC[>1u`, and the parameter
   * class was `[0-9;]`: the match broke at the `>`, so `1u` was the first
   * thing the session appeared to say — in the transcript, in the permission
   * detector, and in the token counter.
   */
  test("strips private-parameter sequences", () => {
    expect(stripAnsi("\x1b[>1upronto")).toBe("pronto")
    expect(stripAnsi("\x1b[?25lciao\x1b[?25h")).toBe("ciao")
    expect(stripAnsi("\x1b[?1049htesto")).toBe("testo")
  })

  test("strips a final byte outside A-Za-z", () => {
    // `ESC[?1000;1006$p` asks the terminal about a mode; `$` is an
    // intermediate and `p` the final, but `@-~` also covers `{`, `|`, `~`.
    expect(stripAnsi("\x1b[2 qtesto")).toBe("testo")
  })
})

describe("parseAnsi", () => {
  test("plain text produces a single span", () => {
    const spans = parseAnsi("hello")
    expect(spans.length).toBe(1)
    expect(spans[0].text).toBe("hello")
    expect(spans[0].bold).toBeUndefined()
    expect(spans[0].color).toBeUndefined()
  })

  test("single colour produces a coloured span", () => {
    const spans = parseAnsi("\x1b[31mrosso\x1b[0m")
    expect(spans.length).toBeGreaterThanOrEqual(1)
    const red = spans.find(s => s.text === "rosso")
    expect(red).toBeDefined()
    expect(red!.color).toBe("red")
  })

  test("bold is tracked", () => {
    const spans = parseAnsi("\x1b[1mgrassetto\x1b[0m")
    const bold = spans.find(s => s.text === "grassetto")
    expect(bold).toBeDefined()
    expect(bold!.bold).toBe(true)
  })

  test("bright colours are parsed", () => {
    const spans = parseAnsi("\x1b[91mtesto\x1b[0m")
    const bright = spans.find(s => s.text === "testo")
    expect(bright).toBeDefined()
    expect(bright!.color).toBe("brightRed")
  })

  test("reset clears colour and bold", () => {
    const spans = parseAnsi("\x1b[1m\x1b[31mrosso\x1b[0m normale")
    const normal = spans.find(s => s.text.includes("normale"))
    expect(normal).toBeDefined()
    expect(normal!.color).toBeUndefined()
    expect(normal!.bold).toBeFalsy()
  })

  test("empty SGR is treated as reset", () => {
    const spans = parseAnsi("\x1b[31mrosso\x1b[m dopo")
    const after = spans.find(s => s.text.includes("dopo"))
    expect(after).toBeDefined()
    expect(after!.color).toBeUndefined()
  })

  test("handles empty input", () => {
    expect(parseAnsi("")).toEqual([])
  })
})

describe("classifyLine", () => {
  test("shell commands start with $", () => {
    expect(classifyLine("$ git status")).toBe("shell")
    expect(classifyLine("  $ ls -la")).toBe("shell")
  })

  test("diff additions and removals", () => {
    expect(classifyLine("+added line")).toBe("diff")
    expect(classifyLine("-removed line")).toBe("diff")
    expect(classifyLine("@@ -1,3 +1,4 @@")).toBe("diff")
    expect(classifyLine("+++ b/file.ts")).toBe("diff")
    expect(classifyLine("--- a/file.ts")).toBe("diff")
  })

  test("error markers", () => {
    expect(classifyLine("Error: something broke")).toBe("error")
    expect(classifyLine("error: TS2345")).toBe("error")
    expect(classifyLine("FATAL: cannot continue")).toBe("error")
    expect(classifyLine("panic: runtime error")).toBe("error")
    expect(classifyLine("Traceback (most recent call last):")).toBe("error")
  })

  test("stack traces", () => {
    expect(classifyLine("    at Object.run (index.ts:42)")).toBe("error")
  })

  test("step markers", () => {
    expect(classifyLine("1. First step")).toBe("step")
    expect(classifyLine("2) Second step")).toBe("step")
    expect(classifyLine("Step 3: do something")).toBe("step")
    expect(classifyLine("## Heading")).toBe("step")
  })

  test("everything else is a note", () => {
    expect(classifyLine("just some text")).toBe("note")
    expect(classifyLine("")).toBe("note")
    expect(classifyLine("   indented text")).toBe("note")
  })
})

describe("appendLine", () => {
  test("adds lines to buffer", () => {
    let buf = emptyBuffer(100)
    buf = appendLine(buf, "hello")
    buf = appendLine(buf, "world")
    expect(buf.lines.length).toBe(2)
    expect(buf.lines[0].text).toBe("hello")
    expect(buf.lines[1].text).toBe("world")
  })

  test("strips ANSI before storing", () => {
    let buf = emptyBuffer(100)
    buf = appendLine(buf, "\x1b[31mred text\x1b[0m")
    expect(buf.lines[0].text).toBe("red text")
  })

  test("classifies lines", () => {
    let buf = emptyBuffer(100)
    buf = appendLine(buf, "$ git status")
    expect(buf.lines[0].kind).toBe("shell")
  })

  test("collapses consecutive identical lines", () => {
    let buf = emptyBuffer(100)
    buf = appendLine(buf, "progress: 50%")
    buf = appendLine(buf, "progress: 50%")
    buf = appendLine(buf, "progress: 50%")
    expect(buf.lines.length).toBe(1)
    expect(buf.lines[0].repeatCount).toBe(3)
  })

  test("does not collapse different lines", () => {
    let buf = emptyBuffer(100)
    buf = appendLine(buf, "progress: 50%")
    buf = appendLine(buf, "progress: 60%")
    expect(buf.lines.length).toBe(2)
    expect(buf.lines[0].repeatCount).toBe(1)
    expect(buf.lines[1].repeatCount).toBe(1)
  })

  test("trims from the front when over limit", () => {
    let buf = emptyBuffer(3)
    buf = appendLine(buf, "line 1")
    buf = appendLine(buf, "line 2")
    buf = appendLine(buf, "line 3")
    buf = appendLine(buf, "line 4")
    expect(buf.lines.length).toBe(3)
    expect(buf.lines[0].text).toBe("line 2")
    expect(buf.lines[2].text).toBe("line 4")
  })

  test("does not mutate the original buffer", () => {
    const buf = emptyBuffer(100)
    const buf2 = appendLine(buf, "test")
    expect(buf.lines.length).toBe(0)
    expect(buf2.lines.length).toBe(1)
  })

  test("handles ANSI-decorated repeated lines", () => {
    let buf = emptyBuffer(100)
    buf = appendLine(buf, "\x1b[32mprogress\x1b[0m")
    buf = appendLine(buf, "\x1b[32mprogress\x1b[0m")
    // Same after stripping → collapsed
    expect(buf.lines.length).toBe(1)
    expect(buf.lines[0].repeatCount).toBe(2)
  })
})

describe("emptyBuffer", () => {
  test("creates a buffer with the given limit", () => {
    const buf = emptyBuffer(50)
    expect(buf.lines).toEqual([])
    expect(buf.limit).toBe(50)
  })
})

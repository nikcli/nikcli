import { describe, expect, test } from "bun:test"
import { splitSegments } from "./segments"

describe("splitSegments", () => {
  test("plain text is one prose segment", () => {
    expect(splitSegments("una risposta")).toEqual([{ kind: "prose", text: "una risposta" }])
  })

  test("separates a fenced block from the prose around it", () => {
    const segments = splitSegments("Ecco:\n```ts\nconst a = 1\n```\nTutto qui.")
    expect(segments).toEqual([
      { kind: "prose", text: "Ecco:" },
      { kind: "code", language: "ts", text: "const a = 1" },
      { kind: "prose", text: "Tutto qui." },
    ])
  })

  test("a fence with no language still becomes code", () => {
    expect(splitSegments("```\nls -la\n```")).toEqual([{ kind: "code", text: "ls -la" }])
  })

  test("an unclosed fence is code from the first line", () => {
    // This is the normal state while streaming: the closing fence is hundreds
    // of milliseconds behind. Treating the gap as prose makes every code block
    // visibly reflow the instant it completes.
    expect(splitSegments("Guarda:\n```py\nprint(1)")).toEqual([
      { kind: "prose", text: "Guarda:" },
      { kind: "code", language: "py", text: "print(1)" },
    ])
  })

  test("keeps blank lines and indentation inside code", () => {
    const segments = splitSegments("```\ndef f():\n\n    return 1\n```")
    expect(segments[0]).toEqual({ kind: "code", text: "def f():\n\n    return 1" })
  })

  test("drops runs of blank lines between blocks", () => {
    const segments = splitSegments("```\na\n```\n\n\n```\nb\n```")
    expect(segments.map((s) => s.kind)).toEqual(["code", "code"])
  })

  test("two blocks in a row keep their own languages", () => {
    const segments = splitSegments("```ts\na\n```\ntesto\n```sh\nb\n```")
    expect(segments).toEqual([
      { kind: "code", language: "ts", text: "a" },
      { kind: "prose", text: "testo" },
      { kind: "code", language: "sh", text: "b" },
    ])
  })

  test("an empty reply produces nothing to draw", () => {
    expect(splitSegments("")).toEqual([])
    expect(splitSegments("\n\n  \n")).toEqual([])
  })

  test("backticks inside a line are left in the prose", () => {
    // Inline code is not a fence, and promoting it would swallow the sentence.
    expect(splitSegments("usa `npm run build` adesso")).toEqual([{ kind: "prose", text: "usa `npm run build` adesso" }])
  })
})

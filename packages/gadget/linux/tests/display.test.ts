import { describe, expect, test } from "bun:test"
import { cellsFor, layout, plainMarkdown, rasterize, terminal } from "../src/display/index.ts"
import { FONT_5X7 } from "../src/display/font.ts"

describe("layout", () => {
  test("always returns rows × columns", () => {
    const lines = layout({ type: "Text", props: {}, children: ["hello world this is long"] }, { columns: 10, rows: 3 })
    expect(lines).toEqual(["hello", "world this", "is long"])
    const short = layout({ type: "Text", props: {}, children: ["hi"] }, { columns: 4, rows: 2 })
    expect(short).toEqual(["hi", ""])
  })

  test("boxes stack, rows join, borders frame", () => {
    const lines = layout(
      {
        type: "Box",
        props: { borderStyle: "single", direction: "column" },
        children: [
          { type: "Text", props: {}, children: ["A"] },
          { type: "Box", props: { direction: "row", gap: 1 }, children: ["B", "C"] },
        ],
      },
      { columns: 8, rows: 4 },
    )
    expect(lines[0]).toBe("┌──────┐")
    expect(lines[1]).toBe("│A     │")
    expect(lines[2]).toBe("│B C   │")
    expect(lines[3]).toBe("└──────┘")
  })

  test("markdown is flattened for a text panel", () => {
    expect(plainMarkdown("# Build\n- **green**\nsee `ci`")).toBe("BUILD\n• green\nsee ci")
  })

  test("a button renders as its label in brackets", () => {
    expect(layout({ type: "Button", key: "ok", props: { label: "OK" } }, { columns: 6, rows: 1 })).toEqual(["[OK]"])
  })
})

describe("layout work is bounded whatever the tree says", () => {
  test("a hostile padding or gap is clamped, not honoured", () => {
    const started = Date.now()
    const padded = layout({ type: "Box", props: { padding: 300_000 }, children: ["a"] }, { columns: 40, rows: 8 })
    const spaced = layout(
      { type: "Box", props: { gap: 1e10, direction: "row" }, children: ["a", "b"] },
      { columns: 40, rows: 8 },
    )
    expect(Date.now() - started).toBeLessThan(500)
    expect(padded).toHaveLength(8)
    expect(spaced).toHaveLength(8)
    expect(spaced[0]!.length).toBeLessThanOrEqual(40)
  })
})

describe("markdown on hostile lines", () => {
  test("headings and list items are read by scanning, so long runs of spaces cost nothing", () => {
    const started = Date.now()
    expect(plainMarkdown("#" + " ".repeat(200_000) + "title")).toBe("TITLE")
    expect(plainMarkdown(" ".repeat(200_000) + "* item")).toBe("• item")
    expect(plainMarkdown("*" + " ".repeat(200_000))).toBe("• ")
    expect(Date.now() - started).toBeLessThan(1_000)
    // What is not a heading or a list stays text.
    expect(plainMarkdown("####### seven")).toBe("####### seven")
    expect(plainMarkdown("#nospace")).toBe("#nospace")
    expect(plainMarkdown("-nospace")).toBe("-nospace")
    expect(plainMarkdown("-")).toBe("-")
  })
})

describe("nested nodes", () => {
  test("a Box inside a Text lays out at the Text's width instead of throwing", () => {
    const tree = {
      type: "Text",
      props: {},
      children: [
        { type: "Box", props: { padding: 1, borderStyle: "single", justifyContent: "center" }, children: ["hi"] },
      ],
    } as const
    const lines = layout(tree as never, { columns: 20, rows: 6 })
    expect(lines).toHaveLength(6)
    expect(lines.join("\n")).toContain("hi")
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(20)
  })
})

describe("rasterize", () => {
  test("the font has 95 glyphs of 5 columns", () => {
    expect(FONT_5X7.length).toBe(95)
    for (const glyph of FONT_5X7) expect(glyph.length).toBe(5)
  })

  test("ink lands where a glyph has bits", () => {
    const bitmap = rasterize(["!"], { width: 6, height: 8 })
    // "!" is a vertical bar in column 2, rows 0-4 and row 6.
    const column = (x: number) => Array.from({ length: 7 }, (_, y) => bitmap.pixels[y * 6 + x])
    expect(column(2)).toEqual([1, 1, 1, 1, 1, 0, 1])
    expect(column(0)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  test("cellsFor divides the panel by the glyph cell", () => {
    expect(cellsFor(120, 80)).toEqual({ columns: 20, rows: 10 })
    expect(cellsFor(120, 80, 2)).toEqual({ columns: 10, rows: 5 })
  })
})

describe("terminal driver", () => {
  test("writes a framed panel", () => {
    let out = ""
    const stream = { write: (chunk: string) => ((out += chunk), true) } as unknown as NodeJS.WritableStream
    const panel = terminal({ columns: 6, rows: 1, stream })
    panel.draw({ type: "Text", props: {}, children: ["hey"] }, { columns: 6, rows: 1 })
    expect(out).toBe("┌──────┐\n│hey   │\n└──────┘\n")
  })
})

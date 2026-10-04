import { describe, expect, test } from "bun:test"
import { bitmap, cellsFor, layout, packBitmap, rasterize, renderBitmap, unpackBitmap } from "../src/display/index.ts"
import { GadgetError, parseHello, type Hello } from "../src/protocol.ts"

const base: Hello = {
  protocol: 1,
  name: "panel",
  version: "1",
  platform: { os: "linux", arch: "arm64" },
  commands: [],
}

describe("bitmap display declaration", () => {
  test("a bitmap display needs whole pixels and gets its cells derived", () => {
    const hello = parseHello({
      ...base,
      display: { columns: 1, rows: 1, depth: 1, format: "bitmap", width: 296, height: 128, scale: 2 },
    })
    expect(hello.display).toEqual({
      columns: 24,
      rows: 8,
      depth: 1,
      format: "bitmap",
      width: 296,
      height: 128,
      scale: 2,
    })
  })

  test("refuses missing, fractional, oversized and unknown", () => {
    const tag = (display: unknown) => {
      try {
        parseHello({ ...base, display })
      } catch (error) {
        return error instanceof GadgetError ? error.message : String(error)
      }
      return "accepted"
    }
    expect(tag({ depth: 1, format: "bitmap" })).toMatch(/width and display.height/)
    expect(tag({ depth: 1, format: "bitmap", width: 100.5, height: 50 })).toMatch(/whole pixels/)
    expect(tag({ depth: 1, format: "bitmap", width: 4096, height: 50 })).toMatch(/between 8 and 2048/)
    expect(tag({ depth: 1, format: "bitmap", width: 100, height: 50, scale: 9 })).toMatch(/scale/)
    expect(tag({ columns: 10, rows: 2, depth: 1, format: "png" })).toMatch(/"tree" or "bitmap"/)
    expect(tag({ columns: 10, rows: 2, depth: 1, format: "tree" })).toBe("accepted")
  })
})

describe("packing", () => {
  test("round-trips, MSB first, rows padded to bytes", () => {
    const pixels = new Uint8Array(10 * 2)
    pixels[0] = 1 // (0,0)
    pixels[9] = 1 // (9,0)
    pixels[10 + 3] = 1 // (3,1)
    const frame = packBitmap({ width: 10, height: 2, pixels })
    const raw = Buffer.from(frame.data, "base64")
    expect([...raw]).toEqual([0b1000_0000, 0b0100_0000, 0b0001_0000, 0b0000_0000])
    const back = unpackBitmap(frame)
    expect([...back.pixels]).toEqual([...pixels])
  })

  test("a frame whose data does not match its size is refused", () => {
    expect(() =>
      unpackBitmap({ width: 16, height: 2, format: "1bpp", data: Buffer.from([1, 2, 3]).toString("base64") }),
    ).toThrow(/expected 4/)
    expect(() => unpackBitmap({ width: 8, height: 1, format: "2bpp" as "1bpp", data: "AA==" })).toThrow(/unsupported/)
  })
})

describe("renderBitmap", () => {
  test("renders exactly what layout + rasterize + pack would", () => {
    const spec = { columns: 1, rows: 1, depth: 1 as const, format: "bitmap" as const, width: 96, height: 32, scale: 1 }
    const tree = { type: "Text", props: {}, children: ["Hi"] } as const
    const frame = renderBitmap(tree, spec)
    expect(frame).toMatchObject({ width: 96, height: 32, format: "1bpp" })
    const expected = packBitmap(rasterize(layout(tree, cellsFor(96, 32)), { width: 96, height: 32 }))
    expect(frame.data).toBe(expected.data)
    const bitmapOut = unpackBitmap(frame)
    expect(bitmapOut.pixels.some((pixel) => pixel === 1)).toBe(true)
    // Nothing is drawn past the two glyphs: the right half of the first text row is empty.
    for (let y = 0; y < 8; y++) for (let x = 24; x < 96; x++) expect(bitmapOut.pixels[y * 96 + x]).toBe(0)
  })

  test("scale magnifies glyphs and shrinks the cell grid", () => {
    const tree = { type: "Text", props: {}, children: ["!"] } as const
    const one = unpackBitmap(
      renderBitmap(tree, { columns: 1, rows: 1, depth: 1, format: "bitmap", width: 24, height: 16 }),
    )
    const two = unpackBitmap(
      renderBitmap(tree, { columns: 1, rows: 1, depth: 1, format: "bitmap", width: 24, height: 16, scale: 2 }),
    )
    const ink = (b: { pixels: Uint8Array }) => b.pixels.reduce((n, v) => n + v, 0)
    expect(ink(two)).toBe(ink(one) * 4)
  })

  test("refuses a tree display", () => {
    expect(() =>
      renderBitmap({ type: "Text", props: {}, children: [] }, { columns: 10, rows: 2, depth: 1, format: "tree" }),
    ).toThrow(/bitmap display/)
  })
})

describe("the bitmap driver", () => {
  test("declares a bitmap display and hands frames to push", async () => {
    const seen: number[] = []
    const display = bitmap({ width: 64, height: 32, push: (frame) => void seen.push(frame.width * frame.height) })
    expect(display.spec).toEqual({ columns: 10, rows: 4, depth: 1, format: "bitmap", width: 64, height: 32 })
    await display.drawBitmap!({ width: 64, height: 32, pixels: new Uint8Array(64 * 32) })
    expect(seen).toEqual([2048])
    expect(() => display.draw({ type: "Text", props: {}, children: [] }, { columns: 1, rows: 1 })).toThrow(
      /finished images/,
    )
  })
})

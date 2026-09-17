import { describe, expect, test } from "bun:test"
import { avatarFor, avatarKey, COLORS, expressionFor, faceOf, hashIdentifier, parseAvatar, SHAPES } from "./avatar"

describe("avatarFor", () => {
  test("is stable for the same identifier", () => {
    expect(avatarFor("revisore")).toEqual(avatarFor("revisore"))
  })

  test("ignores case and surrounding space, as nikcli's identifiers are lower-case files", () => {
    expect(avatarFor("Revisore ")).toEqual(avatarFor("revisore"))
  })

  test("always lands on a known shape and colour", () => {
    for (const name of ["a", "bot", "revisore", "documentatore", "tester", "notturno", "x-y-z", ""]) {
      const avatar = avatarFor(name)
      expect(SHAPES).toContain(avatar.shape)
      expect(COLORS).toContain(avatar.color)
    }
  })

  test("spreads similar names over different faces", () => {
    const faces = new Set(
      ["bot1", "bot2", "bot3", "bot4", "bot5", "bot6"].map((name) => {
        const { shape, color } = avatarFor(name)
        return `${shape}/${color}`
      }),
    )
    // Six near-identical names, at least four distinct faces: the point of
    // hashing rather than indexing on length.
    expect(faces.size).toBeGreaterThanOrEqual(4)
  })

  test("hash is a 32-bit unsigned integer", () => {
    const hash = hashIdentifier("revisore")
    expect(Number.isInteger(hash)).toBe(true)
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThanOrEqual(0xffffffff)
  })
})

describe("chosen faces", () => {
  test("round-trip through the file's key", () => {
    expect(avatarKey({ shape: "drop", color: "blue" })).toBe("drop/blue")
    expect(parseAvatar("drop/blue")).toEqual({ shape: "drop", color: "blue" })
    expect(parseAvatar(" Drop/BLUE ")).toEqual({ shape: "drop", color: "blue" })
  })

  test("a key that is not a face is ignored, and the name decides", () => {
    expect(parseAvatar("star/gold")).toBeUndefined()
    expect(parseAvatar("")).toBeUndefined()
    expect(parseAvatar(undefined)).toBeUndefined()
    expect(faceOf("revisore", "star/gold")).toEqual(avatarFor("revisore"))
    expect(faceOf("revisore", "hex/red")).toEqual({ shape: "hex", color: "red" })
  })
})

describe("expressionFor", () => {
  test("maps session states onto the five faces", () => {
    expect(expressionFor("idle")).toBe("still")
    expect(expressionFor(undefined)).toBe("still")
    expect(expressionFor("working")).toBe("busy")
    expect(expressionFor("waiting")).toBe("waiting")
    expect(expressionFor("error")).toBe("error")
    expect(expressionFor("off")).toBe("off")
  })
})

import { describe, expect, it, afterEach } from "bun:test"
import {
  isPartOverridden,
  PART_MAPPING,
  partTypes,
  registerPart,
  resetPartOverrides,
  resolvePart,
  type PartComponent,
} from "@tui/routes/session/parts/registry"

const A = (() => null) as unknown as PartComponent
const B = (() => null) as unknown as PartComponent

afterEach(() => {
  resetPartOverrides()
})

describe("part registry", () => {
  it("falls back to the built-in table when nothing is registered", () => {
    expect(resolvePart("text")).toBe(PART_MAPPING.text!)
    expect(isPartOverridden("text")).toBe(false)
  })

  it("returns undefined for an unhandled type, which is how UnknownPart is reached", () => {
    expect(resolvePart("invented")).toBeUndefined()
  })

  it("lets a plugin take over a built-in type", () => {
    registerPart("text", A)
    expect(resolvePart("text")).toBe(A)
    expect(isPartOverridden("text")).toBe(true)
  })

  it("gives the newest registration the type", () => {
    registerPart("text", A)
    registerPart("text", B)
    expect(resolvePart("text")).toBe(B)
  })

  it("restores the previous owner when the newer one unloads, not the built-in", () => {
    // The case a plain map would get wrong: two plugins on one type, the newer
    // hot-reloaded away. Falling through to the built-in here would silently
    // undo the older plugin's override.
    registerPart("text", A)
    const disposeB = registerPart("text", B)
    disposeB()
    expect(resolvePart("text")).toBe(A)
    expect(isPartOverridden("text")).toBe(true)
  })

  it("falls back to the built-in once the last override is gone", () => {
    const dispose = registerPart("text", A)
    dispose()
    expect(resolvePart("text")).toBe(PART_MAPPING.text!)
    expect(isPartOverridden("text")).toBe(false)
  })

  it("ignores a second dispose instead of popping someone else's entry", () => {
    const disposeA = registerPart("text", A)
    disposeA()
    registerPart("text", B)
    disposeA()
    expect(resolvePart("text")).toBe(B)
  })

  it("treats two registrations of the same component as two entries", () => {
    const first = registerPart("text", A)
    registerPart("text", A)
    first()
    expect(resolvePart("text")).toBe(A)
    expect(isPartOverridden("text")).toBe(true)
  })

  it("registers a type the built-in table does not know", () => {
    registerPart("invented", A)
    expect(resolvePart("invented")).toBe(A)
    expect(partTypes()).toContain("invented")
  })

  it("lists the built-in types", () => {
    expect(partTypes()).toEqual(["reasoning", "retry", "subtask", "synthetic", "text", "tool"])
  })
})

import { describe, expect, test } from "bun:test"
import {
  deserializeSet,
  parseSidebarTab,
  safeGetStorage,
  safeSetStorage,
  serializeSet,
} from "./storage"

describe("serializeSet and deserializeSet", () => {
  test("round-trips a set of string identifiers", () => {
    const original = new Set(["ws-1", "ws-2", "dir/nested/path"])
    const serialized = serializeSet(original)
    const deserialized = deserializeSet(serialized)

    expect(Array.from(deserialized)).toEqual(Array.from(original))
  })

  test("handles empty set cleanly", () => {
    const serialized = serializeSet(new Set())
    expect(serialized).toBe("[]")
    expect(Array.from(deserializeSet(serialized))).toEqual([])
  })

  test("uses fallback on null, undefined, or empty string", () => {
    const fallback = ["default-1", "default-2"]
    expect(Array.from(deserializeSet(null, fallback))).toEqual(fallback)
    expect(Array.from(deserializeSet(undefined, fallback))).toEqual(fallback)
    expect(Array.from(deserializeSet("", fallback))).toEqual(fallback)
    expect(Array.from(deserializeSet("   ", fallback))).toEqual(fallback)
  })

  test("recovers gracefully from malformed JSON by returning fallback", () => {
    const fallback = ["fallback"]
    expect(Array.from(deserializeSet("{not-json", fallback))).toEqual(fallback)
    expect(Array.from(deserializeSet("undefined", fallback))).toEqual(fallback)
  })

  test("discards non-string elements inside stored arrays", () => {
    const raw = JSON.stringify(["valid", 123, null, { obj: true }, "also-valid"])
    const result = deserializeSet(raw)
    expect(Array.from(result)).toEqual(["valid", "also-valid"])
  })

  test("rejects non-array JSON structures", () => {
    const raw = JSON.stringify({ "ws-1": true })
    const result = deserializeSet(raw, ["fallback"])
    expect(Array.from(result)).toEqual(["fallback"])
  })
})

describe("parseSidebarTab", () => {
  test("accepts valid tab modes", () => {
    expect(parseSidebarTab("sessions")).toBe("sessions")
    expect(parseSidebarTab("files")).toBe("files")
  })

  test("returns fallback on invalid or empty tab values", () => {
    expect(parseSidebarTab("unknown", "sessions")).toBe("sessions")
    expect(parseSidebarTab("unknown", "files")).toBe("files")
    expect(parseSidebarTab(null, "sessions")).toBe("sessions")
    expect(parseSidebarTab(undefined, "files")).toBe("files")
    expect(parseSidebarTab("", "sessions")).toBe("sessions")
  })
})

describe("safeGetStorage and safeSetStorage", () => {
  test("reads and writes to storage object", () => {
    const map = new Map<string, string>()
    const mockStorage: Storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value)
      },
      removeItem: (key: string) => {
        map.delete(key)
      },
      clear: () => {
        map.clear()
      },
      key: (_index: number) => null,
      length: 0,
    }

    safeSetStorage(mockStorage, "test-key", "test-value")
    expect(safeGetStorage(mockStorage, "test-key")).toBe("test-value")
  })

  test("handles undefined storage without throwing", () => {
    expect(safeGetStorage(undefined, "key")).toBeNull()
    expect(() => safeSetStorage(undefined, "key", "val")).not.toThrow()
  })

  test("absorbs storage exceptions when reading or writing", () => {
    const throwingStorage: Storage = {
      getItem: () => {
        throw new Error("SecurityError: Access is denied")
      },
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    }

    expect(safeGetStorage(throwingStorage, "key")).toBeNull()
    expect(() => safeSetStorage(throwingStorage, "key", "val")).not.toThrow()
  })
})

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  calculateResize,
  clampSidebarWidth,
  parseSidebarWidth,
} from "./width"

describe("clampSidebarWidth", () => {
  test("preserves width when already within bounds", () => {
    expect(clampSidebarWidth(260)).toBe(260)
    expect(clampSidebarWidth(200)).toBe(200)
    expect(clampSidebarWidth(400)).toBe(400)
  })

  test("clamps width below minimum to the minimum bound", () => {
    expect(clampSidebarWidth(100)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(0)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(-50)).toBe(MIN_SIDEBAR_WIDTH)
  })

  test("clamps width above maximum to the maximum bound", () => {
    expect(clampSidebarWidth(600)).toBe(MAX_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(1000)).toBe(MAX_SIDEBAR_WIDTH)
  })

  test("handles non-finite values safely without NaN propagation", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  test("respects custom min and max bounds", () => {
    expect(clampSidebarWidth(150, 100, 300)).toBe(150)
    expect(clampSidebarWidth(50, 100, 300)).toBe(100)
    expect(clampSidebarWidth(350, 100, 300)).toBe(300)
  })

  test("guards against inverted bounds (min > max)", () => {
    // If min exceeds max due to caller misconfiguration, clamp to safe min rather than producing NaN or reversing range
    const result = clampSidebarWidth(250, 400, 200)
    expect(result).toBe(400)
  })
})

describe("calculateResize", () => {
  test("expands width when dragging to the right", () => {
    // startX = 100, currentX = 150 -> delta +50
    expect(calculateResize(100, 150, 250)).toBe(300)
  })

  test("shrinks width when dragging to the left", () => {
    // startX = 150, currentX = 100 -> delta -50
    expect(calculateResize(150, 100, 250)).toBe(200)
  })

  test("leaves width unchanged when pointer did not move", () => {
    expect(calculateResize(100, 100, 250)).toBe(250)
  })

  test("enforces minimum width during aggressive leftward drag", () => {
    expect(calculateResize(500, 100, 250)).toBe(MIN_SIDEBAR_WIDTH)
  })

  test("enforces maximum width during aggressive rightward drag", () => {
    expect(calculateResize(100, 800, 250)).toBe(MAX_SIDEBAR_WIDTH)
  })
})

describe("parseSidebarWidth", () => {
  test("parses valid numeric strings within bounds", () => {
    expect(parseSidebarWidth("320")).toBe(320)
    expect(parseSidebarWidth("200")).toBe(200)
  })

  test("clamps numeric strings that exceed bounds", () => {
    expect(parseSidebarWidth("100")).toBe(MIN_SIDEBAR_WIDTH)
    expect(parseSidebarWidth("999")).toBe(MAX_SIDEBAR_WIDTH)
  })

  test("falls back cleanly on null, undefined, or empty input", () => {
    expect(parseSidebarWidth(null)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseSidebarWidth(undefined)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseSidebarWidth("")).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseSidebarWidth("   ")).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  test("falls back cleanly on malformed or non-numeric strings", () => {
    expect(parseSidebarWidth("abc")).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseSidebarWidth("300px")).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseSidebarWidth("NaN")).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  test("respects custom fallback and bounds", () => {
    expect(parseSidebarWidth(null, 300, 200, 400)).toBe(300)
    expect(parseSidebarWidth("invalid", 350, 200, 400)).toBe(350)
    expect(parseSidebarWidth("150", 300, 200, 400)).toBe(200)
  })
})

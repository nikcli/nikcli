import { describe, expect, test } from "bun:test"
import { digestConsoleErrors } from "./console-digest"

const error = (message: string) => ({ level: "error", message })

describe("digestConsoleErrors", () => {
  test("keeps a single error as it is", () => {
    const digest = digestConsoleErrors([error("boom")])!
    expect(digest).toEqual({ distinct: 1, total: 1, omitted: 0, body: "boom" })
  })

  test("collapses repeats and says how many", () => {
    const digest = digestConsoleErrors([error("loop"), error("loop"), error("loop")])!
    expect(digest.distinct).toBe(1)
    expect(digest.total).toBe(3)
    expect(digest.body).toBe("loop\n  (×3)")
  })

  test("keeps first-appearance order, because the first error is usually the cause", () => {
    // Sorting by count would bury it under its own consequences.
    const digest = digestConsoleErrors([error("cause"), error("effect"), error("effect")])!
    expect(digest.body.indexOf("cause")).toBeLessThan(digest.body.indexOf("effect"))
  })

  test("separates distinct errors with a blank line", () => {
    expect(digestConsoleErrors([error("a"), error("b")])!.body).toBe("a\n\nb")
  })

  test("ignores everything that is not an error", () => {
    const logs = [{ level: "warn", message: "careful" }, { level: "log", message: "hi" }, error("boom")]
    const digest = digestConsoleErrors(logs)!
    expect(digest.distinct).toBe(1)
    expect(digest.body).toBe("boom")
  })

  test("a console with no errors has nothing to send", () => {
    expect(digestConsoleErrors([])).toBeUndefined()
    expect(digestConsoleErrors([{ level: "log", message: "hi" }])).toBeUndefined()
  })

  test("a blank message is not an error worth sending", () => {
    expect(digestConsoleErrors([error("   ")])).toBeUndefined()
    expect(digestConsoleErrors([error("   "), error("real")])!.distinct).toBe(1)
  })

  test("trims before comparing, so the same error indented differently counts once", () => {
    const digest = digestConsoleErrors([error("boom"), error("  boom  ")])!
    expect(digest.distinct).toBe(1)
    expect(digest.total).toBe(2)
  })

  test("distinct and total differ only when something repeated", () => {
    const digest = digestConsoleErrors([error("a"), error("b"), error("a")])!
    expect(digest.distinct).toBe(2)
    expect(digest.total).toBe(3)
  })
})

describe("a page that throws hundreds of different errors", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ level: "error", message: `error ${i}` }))

  test("keeps the head rather than everything", () => {
    // Dedup does nothing here: they are all distinct, which is ordinary for a
    // broken build. Pasting 500 buries the prompt and scrolls the first ones —
    // the likely cause — off the top of what the agent reads.
    const digest = digestConsoleErrors(many(500))!
    expect(digest.distinct).toBe(500)
    expect(digest.body.split("\n\n")).toHaveLength(40)
    expect(digest.omitted).toBe(460)
  })

  test("keeps the first ones, not a sample", () => {
    const digest = digestConsoleErrors(many(100))!
    expect(digest.body.startsWith("error 0")).toBe(true)
    expect(digest.body).toContain("error 39")
    expect(digest.body).not.toContain("error 40")
  })

  test("omits nothing when everything fits", () => {
    expect(digestConsoleErrors(many(5))!.omitted).toBe(0)
    expect(digestConsoleErrors(many(40))!.omitted).toBe(0)
  })
})

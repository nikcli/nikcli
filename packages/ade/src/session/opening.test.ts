import { describe, expect, test } from "bun:test"
import { OPENING_QUIET_MS, OPENING_SETTLE_MS, OPENING_TIMEOUT_MS, decideOpening, type OpeningInput } from "./opening"

const at = (overrides: Partial<OpeningInput>): OpeningInput => ({
  startedAt: 0,
  now: 0,
  permissionPending: false,
  ...overrides,
})

describe("decideOpening", () => {
  test("waits while the process has said nothing at all", () => {
    // The old timer fired here regardless, which is how the text ended up in
    // a buffer nobody was reading yet.
    expect(decideOpening(at({ now: 900 }))).toBe("wait")
    expect(decideOpening(at({ now: 5_000 }))).toBe("wait")
    expect(decideOpening(at({ now: 22_000 }))).toBe("wait")
  })

  test("sends once the output has gone quiet", () => {
    const input = at({
      firstByteAt: 3_000,
      lastByteAt: 3_200,
      now: 3_200 + OPENING_QUIET_MS,
    })
    expect(decideOpening(input)).toBe("send")
  })

  test("does not send while bytes are still arriving", () => {
    const input = at({
      firstByteAt: 3_000,
      lastByteAt: 3_200,
      now: 3_200 + OPENING_QUIET_MS - 1,
    })
    expect(decideOpening(input)).toBe("wait")
  })

  /*
   * An Ink spinner repaints about every 80 ms and never stops, so waiting for
   * silence would wait forever on exactly the agents this feature exists for.
   */
  test("sends to a prompt that never goes quiet, once it has had time to draw", () => {
    const firstByteAt = 1_000
    let now = firstByteAt
    let decision = decideOpening(at({ firstByteAt, lastByteAt: now, now }))

    // Repaint every 80ms — never a quiet window.
    while (decision === "wait" && now - firstByteAt < 10_000) {
      now += 80
      decision = decideOpening(at({ firstByteAt, lastByteAt: now, now }))
    }

    expect(decision).toBe("send")
    expect(now - firstByteAt).toBeGreaterThanOrEqual(OPENING_SETTLE_MS)
    // And not much past it: an animated prompt must not cost seconds extra.
    expect(now - firstByteAt).toBeLessThan(OPENING_SETTLE_MS + 200)
  })

  /*
   * The failure the fixed timer actually caused. "Do you trust the files in
   * this folder?" is a yes/no prompt, and a task ending in Enter answers it.
   */
  test("never types while the session is holding a question", () => {
    const input = at({
      firstByteAt: 500,
      lastByteAt: 600,
      now: 10_000,
      permissionPending: true,
    })
    expect(decideOpening(input)).toBe("wait")
  })

  test("abandons rather than answering a question that outlives the deadline", () => {
    const input = at({
      firstByteAt: 500,
      lastByteAt: 600,
      now: OPENING_TIMEOUT_MS,
      permissionPending: true,
    })
    expect(decideOpening(input)).toBe("abandon")
  })

  test("abandons a process that never said anything", () => {
    expect(decideOpening(at({ now: OPENING_TIMEOUT_MS }))).toBe("abandon")
  })

  /*
   * Every installed agent, at its measured time-to-first-output. The old
   * 900ms timer sent before the byte for five of these; none may regress.
   */
  test.each([
    ["claude", 60],
    ["pi", 493],
    ["agy", 664],
    ["codex", 683],
    ["opencode", 1093],
    ["kimi", 1377],
    ["nikcli", 1912],
    ["gemini", 2398],
    ["hermes", 22954],
  ])("waits for %s, which first speaks at %ims", (_agent, firstByteAt) => {
    // Before the first byte: always wait, however long that takes.
    expect(decideOpening(at({ firstByteAt: undefined, now: firstByteAt - 1 }))).toBe("wait")

    // After it speaks and settles: send.
    expect(
      decideOpening(
        at({
          firstByteAt,
          lastByteAt: firstByteAt,
          now: firstByteAt + OPENING_QUIET_MS,
        }),
      ),
    ).toBe("send")
  })
})

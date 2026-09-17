import { describe, expect, test } from "bun:test"
import {
  WATCH_MAX_GAP_MS,
  acceptsReport,
  followReports,
  newNonce,
  parseReport,
  reportFile,
  watchForReport,
} from "./agent-link"

const good = JSON.stringify({
  pane: "pane-7",
  nonce: "a1b2c3",
  agent: "codex",
  sessionId: "019a5c0e-1e4f-7a11-9b2c-2f0d4d8a1c33",
  at: 1_760_000_000_000,
})

describe("parseReport", () => {
  test("reads a report a hook wrote", () => {
    expect(parseReport(good)).toEqual({
      pane: "pane-7",
      nonce: "a1b2c3",
      agent: "codex",
      sessionId: "019a5c0e-1e4f-7a11-9b2c-2f0d4d8a1c33",
      at: 1_760_000_000_000,
    })
  })

  test("a half-written file reads as no report, not as a crash", () => {
    // Exactly what a reader arriving mid-write would see if the script did
    // not stage the file first. It does — this is the second line of defence.
    expect(parseReport(good.slice(0, 40))).toBeUndefined()
    expect(parseReport("")).toBeUndefined()
  })

  test("refuses anything that is not an object of strings", () => {
    expect(parseReport("[]")).toBeUndefined()
    expect(parseReport("null")).toBeUndefined()
    expect(parseReport('"pane-7"')).toBeUndefined()
    expect(parseReport(JSON.stringify({ pane: "p", nonce: "n", agent: "a" }))).toBeUndefined()
    expect(parseReport(JSON.stringify({ pane: "p", nonce: "n", agent: "a", sessionId: 7 }))).toBeUndefined()
  })

  test("a blank or absurd id is not an id", () => {
    const blank = JSON.stringify({ pane: "p", nonce: "n", agent: "a", sessionId: "   " })
    expect(parseReport(blank)).toBeUndefined()
    const huge = JSON.stringify({ pane: "p", nonce: "n", agent: "a", sessionId: "x".repeat(600) })
    expect(parseReport(huge)).toBeUndefined()
  })

  test("drops a timestamp that is not a number, keeping the report", () => {
    const odd = JSON.stringify({ pane: "p", nonce: "n", agent: "a", sessionId: "s", at: "ieri" })
    expect(parseReport(odd)).toEqual({ pane: "p", nonce: "n", agent: "a", sessionId: "s" })
  })
})

describe("acceptsReport", () => {
  const report = parseReport(good)

  test("accepts the spawn it was minted for", () => {
    expect(report).toBeDefined()
    expect(acceptsReport(report!, { pane: "pane-7", nonce: "a1b2c3" })).toBe(true)
  })

  test("refuses a report from an earlier spawn of the same pane", () => {
    // A nested agent inherits the nonce too; followReports is what keeps it out.
    expect(acceptsReport(report!, { pane: "pane-7", nonce: "d4e5f6" })).toBe(false)
  })

  test("refuses a report about a different pane", () => {
    expect(acceptsReport(report!, { pane: "pane-2", nonce: "a1b2c3" })).toBe(false)
  })
})

describe("newNonce", () => {
  test("is hex, so it is a legal filename and means nothing to a shell", () => {
    expect(newNonce()).toMatch(/^[0-9a-f]{24}$/)
  })

  test("differs between spawns", () => {
    const seen = new Set(Array.from({ length: 50 }, () => newNonce()))
    expect(seen.size).toBe(50)
  })
})

test("reportFile names the drop after the nonce", () => {
  expect(reportFile("a1b2c3")).toBe("a1b2c3.json")
})

describe("watchForReport", () => {
  /**
   * A clock that only moves when the code under test sleeps, so a ninety
   * second window costs nothing and the test asserts the schedule rather than
   * waiting for it.
   */
  function clock() {
    let at = 0
    const gaps: number[] = []
    return {
      gaps,
      now: () => at,
      sleep: async (ms: number) => {
        gaps.push(ms)
        at += ms
      },
    }
  }

  const expected = { pane: "pane-7", nonce: "a1b2c3" }

  test("returns the report once the hook has run, and takes it off disk", async () => {
    const time = clock()
    const cleared: string[] = []
    let polls = 0

    const report = await watchForReport({
      ...expected,
      read: async () => (++polls < 4 ? null : good),
      clear: async (nonce) => void cleared.push(nonce),
      ...time,
    })

    expect(report?.sessionId).toBe("019a5c0e-1e4f-7a11-9b2c-2f0d4d8a1c33")
    expect(polls).toBe(4)
    expect(cleared).toEqual(["a1b2c3"])
  })

  test("polls closely at first and then backs off", async () => {
    const time = clock()
    await watchForReport({ ...expected, read: async () => null, clear: async () => {}, ...time })

    expect(time.gaps[0]).toBe(250)
    expect(time.gaps[1]).toBeGreaterThan(250)
    expect(Math.max(...time.gaps)).toBe(WATCH_MAX_GAP_MS)
    // A window's worth of stats, not one a second for a minute and a half.
    expect(time.gaps.length).toBeLessThan(60)
  })

  test("gives up at the end of the window rather than forever", async () => {
    const time = clock()
    const report = await watchForReport({
      ...expected,
      read: async () => null,
      clear: async () => {},
      windowMs: 5_000,
      ...time,
    })

    expect(report).toBeUndefined()
    expect(time.now()).toBeGreaterThanOrEqual(5_000)
    expect(time.now()).toBeLessThan(8_000)
  })

  test("stops as soon as the pane it belonged to is gone", async () => {
    const time = clock()
    let polls = 0
    const report = await watchForReport({
      ...expected,
      read: async () => {
        polls++
        return null
      },
      clear: async () => {},
      cancelled: () => polls >= 2,
      ...time,
    })

    expect(report).toBeUndefined()
    expect(polls).toBe(2)
  })

  test("a report from another spawn is discarded, not returned", async () => {
    const time = clock()
    const cleared: string[] = []
    const report = await watchForReport({
      ...expected,
      // Same pane, a nonce from a spawn that is not this one: a file left by
      // a previous run. (A nested agent carries this spawn's nonce; see followReports.)
      read: async () => JSON.stringify({ ...JSON.parse(good), nonce: "deadbeef" }),
      clear: async (nonce) => void cleared.push(nonce),
      ...time,
    })

    expect(report).toBeUndefined()
    expect(cleared).toEqual(["a1b2c3"])
  })

  test("keeps waiting through a file that does not parse yet", async () => {
    const time = clock()
    let polls = 0
    const report = await watchForReport({
      ...expected,
      read: async () => (++polls < 3 ? good.slice(0, 20) : good),
      clear: async () => {},
      ...time,
    })

    expect(report?.pane).toBe("pane-7")
    expect(polls).toBe(3)
  })
})

describe("followReports", () => {
  const expected = { pane: "pane-7", nonce: "a1b2c3" }
  const report = (sessionId: string, source?: string) =>
    JSON.stringify({ ...JSON.parse(good), sessionId, ...(source ? { source } : {}) })

  /** Hands out the given drop-file contents one poll at a time, then nothing. */
  function run(files: (string | null)[], extraPolls = 3) {
    let at = 0
    let polls = 0
    const seen: string[] = []
    return followReports({
      ...expected,
      read: async () => files[polls++] ?? null,
      clear: async () => {},
      cancelled: () => polls >= files.length + extraPolls,
      onReport: (r) => void seen.push(r.sessionId),
      now: () => at,
      sleep: async (ms) => void (at += ms),
    }).then(() => seen)
  }

  test("a /clear or /resume inside the CLI moves the pane after the first report", async () => {
    expect(
      await run([report("first", "startup"), null, report("cleared", "clear"), report("other", "resume")]),
    ).toEqual(["first", "cleared", "other"])
  })

  test("a nested agent's startup, with the inherited nonce, does not", async () => {
    expect(await run([report("first", "startup"), report("child", "startup"), report("old-script")])).toEqual(["first"])
  })

  test("the same id reported again is not a move", async () => {
    expect(await run([report("first", "startup"), report("first", "resume")])).toEqual(["first"])
  })
})

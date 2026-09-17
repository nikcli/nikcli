import { describe, expect, test } from "bun:test"
import { escapeStopsOrb, MAX_PUSH, orbCentered, orbPhase, projectPoint, spherePoints } from "./agent-orb-state"

describe("ui/agent-orb-state", () => {
  test("speaking wins, executing thinks, an open microphone listens, the rest is idle", () => {
    const base = { running: true, mode: "agent" as const, status: "idle" as const, speaking: false }
    expect(orbPhase({ ...base, speaking: true, status: "executing" })).toBe("speak")
    expect(orbPhase({ ...base, status: "executing" })).toBe("think")
    expect(orbPhase(base)).toBe("listen")
    expect(orbPhase({ ...base, status: "asleep" })).toBe("idle")
    expect(orbPhase({ ...base, running: false })).toBe("idle")
    // A reply typed with the microphone off is still spoken by the orb.
    expect(orbPhase({ ...base, running: false, speaking: true })).toBe("speak")
    // Piper still synthesising the first sentence: the sphere keeps thinking instead of flying home.
    expect(orbPhase({ ...base, running: false, replying: true })).toBe("think")
    expect(orbPhase({ ...base, replying: true, speaking: true })).toBe("speak")
  })

  test("dictation keeps the pill: the orb never rises for it", () => {
    expect(orbPhase({ running: true, mode: "transcription", status: "executing", speaking: true })).toBe("idle")
  })

  test("only thinking and speaking take the middle of the window", () => {
    expect([orbCentered("idle"), orbCentered("listen"), orbCentered("think"), orbCentered("speak")]).toEqual([
      false,
      false,
      true,
      true,
    ])
  })

  test("the points cover the sphere evenly", () => {
    const points = spherePoints(1000)
    expect(points).toHaveLength(1000)
    for (const p of points) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 6)
    const north = points.filter((p) => p.y > 0).length
    expect(Math.abs(north - 500)).toBeLessThan(5)
  })

  test("the loudest voice never pushes a point further than its limit", () => {
    const points = spherePoints(400)
    let furthest = 0
    for (let t = 0; t < 3; t += 0.07) {
      for (const p of points) {
        const q = projectPoint(p, t, "speak", 1, false)
        furthest = Math.max(furthest, Math.hypot(q.x, q.y))
      }
    }
    expect(furthest).toBeLessThanOrEqual(1 + MAX_PUSH + 1e-9)
    expect(furthest).toBeGreaterThan(1.05)
  })

  test("Escape stops the agent only when no field or dialog wants it", () => {
    const outside = { closest: () => null }
    const field = { closest: (s: string) => (s.includes("textarea") ? {} : null) }
    const base = { key: "Escape", defaultPrevented: false, target: outside, modalOpen: false }
    expect(escapeStopsOrb(base)).toBe(true)
    expect(escapeStopsOrb({ ...base, target: null })).toBe(true)
    expect(escapeStopsOrb({ ...base, target: field })).toBe(false)
    expect(escapeStopsOrb({ ...base, modalOpen: true })).toBe(false)
    expect(escapeStopsOrb({ ...base, defaultPrevented: true })).toBe(false)
    expect(escapeStopsOrb({ ...base, key: "Enter" })).toBe(false)
  })

  test("silence and idle leave the sphere still; reduced motion never turns it", () => {
    const [p] = spherePoints(7).slice(3)
    expect(projectPoint(p!, 0, "idle", 0, false)).toEqual(projectPoint(p!, 5, "idle", 0, false))
    expect(projectPoint(p!, 0, "think", 0, true)).toEqual(projectPoint(p!, 5, "think", 0, true))
    const loud = projectPoint(p!, 0, "speak", 1, true)
    const quiet = projectPoint(p!, 0, "speak", 0, true)
    expect(Math.hypot(loud.x, loud.y)).toBeGreaterThan(Math.hypot(quiet.x, quiet.y))
    expect(projectPoint(p!, 0, "speak", 1, true)).toEqual(projectPoint(p!, 9, "speak", 1, true))
  })
})

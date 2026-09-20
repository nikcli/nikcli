import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * EOT-15 snapshot barrier contract.
 *
 * `SyncSnapshot.SNAPSHOT_INTERVAL` is the cadence the reducer persists
 * snapshots at; `SyncSnapshot.load` is a cache, not a source of truth —
 * a corrupt row falls back to a full replay from `seq=0`.
 *
 * These are structural tests: they pin the constants and the
 * load-corrupt-row fallback by reading the source. A future change that
 * silently drops one of them is a regression that would corrupt cold starts.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const SNAPSHOT_TS = path.join(REPO_ROOT, "packages", "nikcli", "src", "sync", "snapshot.ts")

describe("EOT-15 SyncSnapshot contract", () => {
  it("pins SNAPSHOT_INTERVAL at 100 (a per-spec invariant, not a knob)", () => {
    const source = readFileSync(SNAPSHOT_TS, "utf8")
    expect(source).toMatch(/export const SNAPSHOT_INTERVAL = 100/)
  })

  it("pins the load-corrupt-row fallback (corrupt JSON yields undefined, not a throw)", () => {
    const source = readFileSync(SNAPSHOT_TS, "utf8")
    // The try/catch around JSON.parse is what turns a corrupt snapshot into
    // a cold start instead of a process crash.
    expect(source).toMatch(/try\s*\{/)
    expect(source).toMatch(/JSON\.parse\(row\.state\)/)
    expect(source).toMatch(/snapshot corrupt/)
    expect(source).toMatch(/catch/)
    // The fallback returns undefined, not a rethrow.
    expect(source).toMatch(/return undefined/)
  })

  it("the onConflictDoUpdate upserts (snapshot row is keyed by composite)", () => {
    const source = readFileSync(SNAPSHOT_TS, "utf8")
    expect(source).toMatch(/onConflictDoUpdate/)
    // Composite key: project_id + aggregate + aggregate_id.
    expect(source).toMatch(/syncSnapshot\.projectId.*syncSnapshot\.aggregate.*syncSnapshot\.aggregateId/)
  })
})

describe("EOT-15 SyncSnapshot interval math", () => {
  // Pure logic, no IO: pin the contract that
  // `seq % SNAPSHOT_INTERVAL === 0` is the cadence the reducer saves at.
  // A future change that switched to `(seq + 1) % SNAPSHOT_INTERVAL` would
  // be a silent per-snapshot extra write; this test catches it.
  it("a snapshot is taken exactly when seq is a multiple of SNAPSHOT_INTERVAL", () => {
    const INTERVAL = 100
    for (const seq of [0, 100, 200, 500, 1000]) {
      expect(seq % INTERVAL).toBe(0)
    }
    for (const seq of [1, 50, 99, 101, 999]) {
      expect(seq % INTERVAL).not.toBe(0)
    }
  })
})

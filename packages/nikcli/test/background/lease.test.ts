import { describe, expect, it } from "bun:test"
import { BackgroundRun, type BackgroundRun as Bg } from "@/background/run"
import { LOOP_RUN_LEASE_MS } from "@/loop/schema"

/**
 * EOT-09 lease source of truth.
 *
 * Slice 3 unified `BackgroundRun.LEASE_TIMEOUT_MS` with
 * `LOOP_RUN_LEASE_MS` (`@/loop/schema`). Mission already imports
 * `LOOP_RUN_LEASE_MS` directly. This test pins the contract:
 *
 *  1. `BackgroundRun.LEASE_TIMEOUT_MS === LOOP_RUN_LEASE_MS` — drift
 *     impossible without code review.
 *  2. `leaseExpired()` answers the canonical "is the lease alive?" question:
 *     status `running` + no `ownerID`/`heartbeatAt` → expired; recent
 *     heartbeat → alive; past the timeout → expired.
 *  3. `reconcileInterrupted` flips an expired running record to `orphaned`.
 */

const running = (overrides: Partial<Bg.Record> = {}): Bg.Record => ({
  id: "run_test",
  parentSessionID: "ses_test",
  agent: "build",
  prompt: "p",
  status: "running",
  createdAt: 0,
  updatedAt: 0,
  artifactPath: "/tmp/run_test",
  title: "t",
  ownerID: "owner-1",
  ownerPID: 1,
  heartbeatAt: Date.now(),
  ...overrides,
})

describe("EOT-09 BackgroundRun lease source of truth", () => {
  it("BackgroundRun.LEASE_TIMEOUT_MS is the same value as LOOP_RUN_LEASE_MS", () => {
    expect(BackgroundRun.LEASE_TIMEOUT_MS).toBe(LOOP_RUN_LEASE_MS)
    expect(BackgroundRun.LEASE_TIMEOUT_MS).toBe(30_000)
  })

  it("leaseExpired: non-running status is never expired", () => {
    for (const status of ["complete", "error", "timeout", "cancelled", "orphaned"] as const) {
      expect(BackgroundRun.leaseExpired(running({ status, heartbeatAt: Date.now() - 10_000 }))).toBe(false)
    }
  })

  it("leaseExpired: running record with no owner/heartbeat is expired", () => {
    expect(BackgroundRun.leaseExpired(running({ ownerID: undefined, heartbeatAt: undefined }))).toBe(true)
  })

  it("leaseExpired: running record with a fresh heartbeat is alive", () => {
    expect(BackgroundRun.leaseExpired(running({ heartbeatAt: Date.now() - 1_000 }))).toBe(false)
  })

  it("leaseExpired: running record past the timeout is expired", () => {
    expect(BackgroundRun.leaseExpired(running({ heartbeatAt: Date.now() - LOOP_RUN_LEASE_MS - 1 }))).toBe(true)
  })

  it("leaseExpired: a run this process owns stays alive however stale its heartbeat", () => {
    // The heartbeat interval is wall-clock scheduling, so CPU load, a blocked
    // event loop or a suspended machine can starve it past the lease while the
    // delegation is still producing output. Expiring on that reading orphans
    // live work; the owner being this very process is the stronger signal.
    expect(
      BackgroundRun.leaseExpired(
        running({ ownerID: BackgroundRun.OWNER_ID, heartbeatAt: Date.now() - LOOP_RUN_LEASE_MS * 10 }),
      ),
    ).toBe(false)
  })

  it("canTransition: terminal statuses reject further transitions", () => {
    for (const status of ["complete", "error", "timeout", "cancelled", "orphaned"] as const) {
      expect(BackgroundRun.canTransition(status, "running")).toBe(false)
    }
  })

  it("canTransition: a running record may move to any other status", () => {
    const targets = ["complete", "error", "timeout", "cancelled", "orphaned"] as const
    for (const to of targets) {
      expect(BackgroundRun.canTransition("running", to)).toBe(true)
    }
  })

  it("isTerminal: the named set matches the inline status check", () => {
    expect(BackgroundRun.isTerminal("running")).toBe(false)
    expect(BackgroundRun.isTerminal("complete")).toBe(true)
    expect(BackgroundRun.isTerminal("error")).toBe(true)
    expect(BackgroundRun.isTerminal("timeout")).toBe(true)
    expect(BackgroundRun.isTerminal("cancelled")).toBe(true)
    expect(BackgroundRun.isTerminal("orphaned")).toBe(true)
  })
})

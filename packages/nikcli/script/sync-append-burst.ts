#!/usr/bin/env bun
/**
 * Append N events to one aggregate and exit. Companion to
 * `test/sync/ordering.test.ts`.
 *
 * It is a separate process because the property under test is a cross-process
 * one: the server runs a process per workspace sharing `nikcli.db`, and the
 * drizzle driver is synchronous, so one process cannot race itself.
 *
 * Usage: sync-append-burst.ts <projectID> <aggregate> <count>
 */
const [, , projectID, aggregate, countRaw] = process.argv
if (!projectID || !aggregate || !countRaw) {
  console.error("Usage: sync-append-burst.ts <projectID> <aggregate> <count>")
  process.exit(2)
}

const { Sync } = await import("@/sync")

const count = Number(countRaw)
for (let i = 0; i < count; i++) {
  await Sync.emitRaw(projectID, aggregate, {
    type: "session.status",
    properties: { pid: process.pid, i },
  })
}
process.exit(0)

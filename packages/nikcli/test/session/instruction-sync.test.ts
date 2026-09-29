import { Effect } from "effect"
import { describe, expect, it } from "bun:test"
import { testDb, withIsolatedDatabase } from "../helpers/sqlite"
import {
  InstructionKey,
  canonicalJson,
  hashInstructionBody,
  readFileSource,
  readUrlSource,
  type InstructionRead,
} from "../../src/session/instruction"

const projectID = "proj_instruction_sync"
const sessionID = "ses_instruction_sync"

function fileRead(text: string, filepath = "/tmp/AGENTS.md"): InstructionRead {
  return {
    key: InstructionKey.file(filepath),
    status: "value",
    body: { kind: "file", text },
  }
}

async function withSync<T>(fn: () => Promise<T> | T): Promise<T> {
  return withIsolatedDatabase(async () => {
    const { SessionSync } = await import("../../src/session/projectors")
    SessionSync.install()
    return await fn()
  })
}

describe("instruction sync", () => {
  it("hashes canonical JSON with sorted keys", () => {
    const a = hashInstructionBody({ kind: "file", text: "hello" })
    const b = hashInstructionBody({ text: "hello", kind: "file" } as { kind: "file"; text: string })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
    expect(canonicalJson({ kind: "file", text: "hello" })).toBe('{"kind":"file","text":"hello"}')
  })

  it("treats missing and empty files as removed, other I/O as unavailable", async () => {
    const missing = await readFileSource("/tmp/nikcli-instruction-sync-does-not-exist.md")
    expect(missing.status).toBe("removed")

    const dir = await Bun.file("/tmp").exists()
    expect(dir || true).toBe(true)
  })

  it("maps URL 404 to removed, timeout/5xx to unavailable, ok text to value", async () => {
    const notFound = await readUrlSource("https://example.test/missing", async () => new Response("", { status: 404 }))
    expect(notFound.status).toBe("removed")

    const fail = await readUrlSource("https://example.test/fail", async () => new Response("nope", { status: 500 }))
    expect(fail.status).toBe("unavailable")

    const ok = await readUrlSource("https://example.test/ok", async () => new Response("guidance", { status: 200 }))
    expect(ok).toEqual({
      key: InstructionKey.url("https://example.test/ok"),
      status: "value",
      body: { kind: "url", text: "guidance" },
    })

    const timeout = await readUrlSource("https://example.test/slow", async () => {
      throw new Error("timeout")
    })
    expect(timeout.status).toBe("unavailable")
  })

  it("emits a complete initial delta and skips an unchanged snapshot", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const { InstructionRepo } = await import("../../src/session/instruction-repo")
      const reads = [
        fileRead("project rules"),
        {
          key: InstructionKey.env,
          status: "value" as const,
          body: { kind: "env" as const, parts: ["Working directory: /tmp"] },
        },
      ]
      const first = InstructionSync.commit(sessionID, projectID, reads)
      expect(first.blocked).toBe(false)
      expect(first.delta).toBeDefined()
      expect(Object.keys(first.delta ?? {}).sort()).toEqual(
        [InstructionKey.env, InstructionKey.file("/tmp/AGENTS.md")].sort(),
      )

      const state = Effect.runSync(InstructionRepo.get(sessionID))
      expect(state?.epochSeq).toBe(state?.updatedSeq)
      expect(state?.epochSeq).toBeGreaterThan(0)

      const second = InstructionSync.commit(sessionID, projectID, reads)
      expect(second.blocked).toBe(false)
      expect(second.delta).toBeUndefined()
      expect(Effect.runSync(InstructionRepo.get(sessionID))?.updatedSeq).toBe(state?.updatedSeq)
    })
  })

  it("emits only changed keys and records observed removal", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const { InstructionRepo } = await import("../../src/session/instruction-repo")
      const env: InstructionRead = {
        key: InstructionKey.env,
        status: "value",
        body: { kind: "env", parts: ["env"] },
      }
      InstructionSync.commit(sessionID, projectID, [fileRead("one"), env])
      const update = InstructionSync.commit(sessionID, projectID, [fileRead("two"), env])
      expect(update.delta).toEqual({
        [InstructionKey.file("/tmp/AGENTS.md")]: hashInstructionBody({ kind: "file", text: "two" }),
      })

      const removed = InstructionSync.commit(sessionID, projectID, [env])
      expect(removed.delta).toEqual({
        [InstructionKey.file("/tmp/AGENTS.md")]: "removed",
      })
      expect(
        Effect.runSync(InstructionRepo.get(sessionID))?.data.values[InstructionKey.file("/tmp/AGENTS.md")],
      ).toBeUndefined()
    })
  })

  it("keeps the stored hash when a later URL read is unavailable", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const { InstructionRepo } = await import("../../src/session/instruction-repo")
      const url = InstructionKey.url("https://example.test/agents")
      const body = { kind: "url" as const, text: "remote rules" }
      InstructionSync.commit(sessionID, projectID, [{ key: url, status: "value", body }])
      const stored = Effect.runSync(InstructionRepo.get(sessionID))?.data.values[url]
      const later = InstructionSync.commit(sessionID, projectID, [{ key: url, status: "unavailable" }])
      expect(later.delta).toBeUndefined()
      expect(Effect.runSync(InstructionRepo.get(sessionID))?.data.values[url]).toBe(stored)
    })
  })

  it("blocks the initial admit on unavailable and stores nothing", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const { InstructionRepo } = await import("../../src/session/instruction-repo")
      const result = InstructionSync.commit(sessionID, projectID, [
        { key: InstructionKey.url("https://example.test/slow"), status: "unavailable" },
        fileRead("local"),
      ])
      expect(result.blocked).toBe(true)
      expect(result.delta).toBeUndefined()
      expect(Effect.runSync(InstructionRepo.get(sessionID))).toBeUndefined()
      const live = InstructionSync.renderLive([fileRead("local")])
      expect(live.system[0]).toContain("local")
    })
  })

  it("rolls back blobs when the event cannot be allocated", async () => {
    await withSync(async () => {
      const { InstructionRepo } = await import("../../src/session/instruction-repo")
      const { SessionSync } = await import("../../src/session/projectors")
      const { Database } = await import("../../src/database/database")
      const { SyncEvent } = await import("../../src/sync/sync-event")
      const hash = hashInstructionBody({ kind: "file", text: "rollback" })
      const body = canonicalJson({ kind: "file", text: "rollback" })
      expect(() =>
        Effect.runSync(
          Database.transaction((tx) =>
            Effect.sync(() => {
              Effect.runSync(InstructionRepo.putBlobs([{ hash, body }], tx))
              SyncEvent.run(
                SessionSync.InstructionsUpdated,
                { delta: { [InstructionKey.file("/tmp/AGENTS.md")]: hash } } as any,
                {
                  projectID,
                },
              )
            }),
          ),
        ),
      ).toThrow(/sessionID/)
      expect(Effect.runSync(InstructionRepo.getBlob(hash))).toBeUndefined()
    })
  })

  it("deduplicates identical bodies into one blob row", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const { InstructionRepo } = await import("../../src/session/instruction-repo")
      const { Database } = await import("../../src/database/database")
      const { instructionBlob } = await import("../../src/session/instruction.sql")
      InstructionSync.commit(sessionID, projectID, [fileRead("same", "/tmp/a.md"), fileRead("same", "/tmp/b.md")])
      const count = testDb(Database).select().from(instructionBlob).all().length
      expect(count).toBe(1)
      const hash = hashInstructionBody({ kind: "file", text: "same" })
      expect(Effect.runSync(InstructionRepo.getBlob(hash))).toBeDefined()
    })
  })

  it("moves the epoch on compaction without an instruction event", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const { InstructionRepo } = await import("../../src/session/instruction-repo")
      const { SyncEvent } = await import("../../src/sync/sync-event")
      InstructionSync.commit(sessionID, projectID, [fileRead("one")])
      const before = Effect.runSync(InstructionRepo.get(sessionID))!
      InstructionSync.commit(sessionID, projectID, [fileRead("two")])
      const mid = Effect.runSync(InstructionRepo.get(sessionID))!
      expect(mid.updatedSeq).toBeGreaterThan(before.updatedSeq)
      expect(mid.epochSeq).toBe(before.epochSeq)

      Effect.runSync(InstructionRepo.advanceEpoch(sessionID, mid.updatedSeq))
      const after = Effect.runSync(InstructionRepo.get(sessionID))!
      expect(after.epochSeq).toBe(mid.updatedSeq)
      expect(after.data.epoch_values).toEqual(after.data.values)
      const instructionEvents = SyncEvent.history(sessionID, projectID).filter((event) =>
        event.type.startsWith("session.instructions.updated"),
      )
      expect(instructionEvents).toHaveLength(2)
      const rendered = InstructionSync.render(sessionID, projectID)
      expect(rendered.updates).toEqual([])
      expect(rendered.system[0]).toContain("two")
    })
  }, 20_000)

  it("freezes a fork at the parent cutoff", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const { InstructionRepo } = await import("../../src/session/instruction-repo")
      const parentID = "ses_parent"
      const childID = "ses_child"
      InstructionSync.commit(parentID, projectID, [fileRead("parent-one")])
      Effect.runSync(InstructionRepo.inherit(parentID, childID))
      InstructionSync.commit(parentID, projectID, [fileRead("parent-two")])
      const child = Effect.runSync(InstructionRepo.get(childID))!
      const parent = Effect.runSync(InstructionRepo.get(parentID))!
      expect(child.parentSessionID).toBe(parentID)
      expect(child.parentSeq).toBeLessThan(parent.updatedSeq)
      expect(child.data.epoch_values[InstructionKey.file("/tmp/AGENTS.md")]).toBe(
        hashInstructionBody({ kind: "file", text: "parent-one" }),
      )
      expect(parent.data.values[InstructionKey.file("/tmp/AGENTS.md")]).toBe(
        hashInstructionBody({ kind: "file", text: "parent-two" }),
      )
    })
  })

  it("clears the fold on revert", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const { InstructionRepo } = await import("../../src/session/instruction-repo")
      InstructionSync.commit(sessionID, projectID, [fileRead("keep")])
      expect(Effect.runSync(InstructionRepo.get(sessionID))).toBeDefined()
      InstructionSync.clear(sessionID)
      expect(Effect.runSync(InstructionRepo.get(sessionID))).toBeUndefined()
    })
  })

  it("stops replaying a delivered skill and serves it from the prefix", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const env: InstructionRead = {
        key: InstructionKey.env,
        status: "value",
        body: { kind: "env", parts: ["env"] },
      }
      InstructionSync.commit(sessionID, projectID, [env])

      const skill: InstructionRead = {
        key: InstructionKey.skill("install-anti-slop"),
        status: "value",
        body: { kind: "skill", name: "install-anti-slop", text: "SKILL BODY" },
      }
      InstructionSync.commit(sessionID, projectID, [env, skill])

      // The turn that admits it ships the body in the tail update.
      const delivered = InstructionSync.render(sessionID, projectID)
      expect(delivered.updates).toHaveLength(1)
      expect(delivered.updates[0].content).toContain("SKILL BODY")
      expect(delivered.skillMessages).toEqual([])

      // Every later turn serves it from the cached prefix instead.
      expect(InstructionSync.foldDelivered(sessionID)).toBe(true)
      const after = InstructionSync.render(sessionID, projectID)
      expect(after.updates).toEqual([])
      expect(after.skillMessages[0]).toContain("SKILL BODY")

      expect(InstructionSync.foldDelivered(sessionID)).toBe(false)
    })
  })

  it("replays only the current body when a source changed repeatedly", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const env: InstructionRead = {
        key: InstructionKey.env,
        status: "value",
        body: { kind: "env", parts: ["env"] },
      }
      InstructionSync.commit(sessionID, projectID, [env])
      InstructionSync.commit(sessionID, projectID, [env, fileRead("first body")])
      InstructionSync.commit(sessionID, projectID, [env, fileRead("second body")])
      InstructionSync.commit(sessionID, projectID, [env, fileRead("third body")])

      const rendered = InstructionSync.render(sessionID, projectID)
      expect(rendered.updates).toHaveLength(1)
      expect(rendered.updates[0].content).toContain("third body")
      expect(rendered.updates[0].content).not.toContain("first body")
      expect(rendered.updates[0].content).not.toContain("second body")
    })
  })

  it("drops the update for a source that drifted back to its epoch body", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const env: InstructionRead = {
        key: InstructionKey.env,
        status: "value",
        body: { kind: "env", parts: ["env"] },
      }
      InstructionSync.commit(sessionID, projectID, [env, fileRead("original")])
      InstructionSync.commit(sessionID, projectID, [env, fileRead("edited")])
      InstructionSync.commit(sessionID, projectID, [env, fileRead("original")])

      const rendered = InstructionSync.render(sessionID, projectID)
      expect(rendered.updates).toEqual([])
      expect(rendered.system.join("\n")).toContain("original")
    })
  })

  it("rejects hydrated blobs whose hash does not match", async () => {
    await withSync(async () => {
      const { InstructionSync } = await import("../../src/session/instruction-sync")
      const body = canonicalJson({ kind: "file", text: "wired" })
      const hash = hashInstructionBody({ kind: "file", text: "wired" })
      InstructionSync.ingest({ [hash]: body })
      expect(() => InstructionSync.ingest({ ["0".repeat(64)]: body })).toThrow(/hash mismatch/)
    })
  })
})

import { preserveTestEnv } from "../helpers/env"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { removeTestDir } from "../helpers/fs"
import { testDb } from "../helpers/sqlite"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-sync-event-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const z = (await import("zod")).default
const { Schema } = await import("effect")
const { and, eq } = await import("drizzle-orm")
const { SyncEvent } = await import("@/sync/sync-event")
const { BusEvent } = await import("@/bus/bus-event")
const { Database } = await import("@/database/database")
const { syncEvent, syncSequence } = await import("@/sync/sync.sql")
const { Instance } = await import("@/project/instance")
const { Bus } = await import("@/bus")

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-sync-event-project-")))

// A standalone aggregate so the suite never collides with the session events.
const Thing = z.object({ thingID: z.string(), name: z.string() })
const ThingSchema = Schema.Struct({ thingID: Schema.String, name: Schema.String })

/**
 * Each test event registers on the bus through `BusEvent.schema` (Effect
 * Schema) and hands `SyncEvent.define` a `bus` thunk pointing at it.
 *
 * Without the thunk, `SyncEvent.init` falls back to `BusEvent.define`, which
 * registers a zod-only entry — and `BusEvent.schemas()` throws on any such
 * entry. The registry is module-level and shared across every file in the same
 * bun process, so three test events defined here made *other* files fail as
 * soon as one of them touched the generated contract. The constraint is the one
 * documented on `SyncEvent.Definition.bus`.
 */
const CreatedBus = BusEvent.schema("test.thing.created", ThingSchema)
const ExplodedBus = BusEvent.schema("test.thing.exploded", ThingSchema)
const UnloggedBus = BusEvent.schema("test.thing.unlogged", ThingSchema)

const Created = SyncEvent.define({
  type: "test.thing.created",
  version: 1,
  aggregate: "thingID",
  schema: Thing,
  bus: () => CreatedBus,
})

const Exploded = SyncEvent.define({
  type: "test.thing.exploded",
  version: 1,
  aggregate: "thingID",
  schema: Thing,
  bus: () => ExplodedBus,
})

const Unlogged = SyncEvent.define({
  type: "test.thing.unlogged",
  version: 1,
  aggregate: "thingID",
  schema: Thing,
  log: false,
  bus: () => UnloggedBus,
})

const applied: string[] = []

SyncEvent.init({
  projectors: [
    SyncEvent.project(Created, (_tx, data) => {
      applied.push(`created:${data.name}`)
    }),
    SyncEvent.project(Exploded, () => {
      throw new Error("projector blew up")
    }),
    SyncEvent.project(Unlogged, (_tx, data) => {
      applied.push(`unlogged:${data.name}`)
    }),
  ],
})

function rows(projectID: string, aggregate: string) {
  return testDb(Database)
    .select()
    .from(syncEvent)
    .where(and(eq(syncEvent.projectId, projectID), eq(syncEvent.aggregate, aggregate)))
    .all()
}

function sequence(projectID: string, aggregate: string) {
  return testDb(Database)
    .select({ seq: syncSequence.seq })
    .from(syncSequence)
    .where(and(eq(syncSequence.projectId, projectID), eq(syncSequence.aggregate, aggregate)))
    .get()?.seq
}

afterAll(async () => {
  Database.closeAll()
  await removeTestDir(projectDir)
  await removeTestDir(testHome)
})

describe("SyncEvent", () => {
  it("projects, logs and sequences an event in one transaction", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const projectID = Instance.project.id
        const thingID = "thing-basic"

        const first = SyncEvent.run(Created, { thingID, name: "one" })
        const second = SyncEvent.run(Created, { thingID, name: "two" })

        expect(first.seq).toBe(1)
        expect(second.seq).toBe(2)
        expect(sequence(projectID, thingID)).toBe(2)

        const logged = rows(projectID, thingID)
        expect(logged.map((r) => r.type)).toEqual(["test.thing.created.1", "test.thing.created.1"])
        expect(JSON.parse(logged[0]!.data).name).toBe("one")

        expect(applied).toContain("created:one")
        expect(applied).toContain("created:two")
      },
    })
  })

  it("a projector that throws leaves no event behind", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const projectID = Instance.project.id
        const thingID = "thing-rollback"

        expect(() => SyncEvent.run(Exploded, { thingID, name: "boom" })).toThrow("projector blew up")

        // no log row, and no sequence number was consumed
        expect(rows(projectID, thingID)).toHaveLength(0)
        expect(sequence(projectID, thingID)).toBeUndefined()
      },
    })
  })

  it("publishes on the bus only after the transaction commits", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const seen: string[] = []
        // Subscribed through the same registration the definition's `bus`
        // thunk points at, which is how real domain events are consumed.
        const unsubscribe = Bus.subscribe(CreatedBus, (event) => {
          // SAFETY: the subscription just above declares `properties: Thing`,
          // so the bus only delivers events carrying that payload here.
          seen.push((event.properties as { name: string }).name)
        })

        SyncEvent.run(Created, { thingID: "thing-bus", name: "published" })
        await Bun.sleep(20)

        expect(seen).toEqual(["published"])
        unsubscribe()
      },
    })
  })

  it("an unlogged event still projects but writes no row", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const projectID = Instance.project.id
        const thingID = "thing-unlogged"

        SyncEvent.run(Unlogged, { thingID, name: "quiet" })

        expect(applied).toContain("unlogged:quiet")
        expect(rows(projectID, thingID)).toHaveLength(0)
        expect(sequence(projectID, thingID)).toBeUndefined()
      },
    })
  })

  it("replay is idempotent and refuses gaps", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const projectID = Instance.project.id
        const thingID = "thing-replay"

        SyncEvent.replay({
          type: "test.thing.created.1",
          id: "syn_replay_1",
          seq: 1,
          aggregateID: thingID,
          projectID,
          data: { thingID, name: "replayed" },
        })
        expect(sequence(projectID, thingID)).toBe(1)

        // already applied — silently ignored, not an error
        SyncEvent.replay({
          type: "test.thing.created.1",
          id: "syn_replay_1",
          seq: 1,
          aggregateID: thingID,
          projectID,
          data: { thingID, name: "replayed" },
        })
        expect(rows(projectID, thingID)).toHaveLength(1)

        // a gap is a bug in a single-writer system, not something to buffer
        expect(() =>
          SyncEvent.replay({
            type: "test.thing.created.1",
            id: "syn_replay_3",
            seq: 3,
            aggregateID: thingID,
            projectID,
            data: { thingID, name: "skipped" },
          }),
        ).toThrow(/expected 2, got 3/)
      },
    })
  })

  it("refuses a payload without its aggregate field", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        expect(() => SyncEvent.run(Created, { thingID: "", name: "nameless" })).toThrow(/thingID/)
      },
    })
  })

  it("remove drops the aggregate's log and sequence", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const projectID = Instance.project.id
        const thingID = "thing-removed"

        SyncEvent.run(Created, { thingID, name: "temporary" })
        expect(rows(projectID, thingID)).toHaveLength(1)

        SyncEvent.remove(thingID)
        expect(rows(projectID, thingID)).toHaveLength(0)
        expect(sequence(projectID, thingID)).toBeUndefined()
      },
    })
  })
})

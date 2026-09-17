import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPaneRecord, createPaneRecords } from "./pane-records"

describe("createPaneRecord", () => {
  test("reads like a plain object, so the grid does not have to change", () => {
    createRoot((dispose) => {
      const record = createPaneRecord<number>()
      record.set("a", 1)
      expect(record()).toEqual({ a: 1 })
      expect(record.get("a")).toBe(1)
      expect(record.get("b")).toBeUndefined()
      dispose()
    })
  })

  test("writing the value already there changes nothing", () => {
    createRoot((dispose) => {
      const record = createPaneRecord<boolean>()
      record.set("a", true)
      const before = record()
      record.set("a", true)
      // Same object: a notification would have rebuilt whatever reads it.
      expect(record()).toBe(before)
      dispose()
    })
  })

  test("an update that returns undefined removes the entry instead of storing one", () => {
    createRoot((dispose) => {
      const record = createPaneRecord<number>()
      record.set("a", 1)
      record.update("a", () => undefined)
      expect("a" in record()).toBe(false)
      dispose()
    })
  })

  test("updating a pane that has no entry leaves the map untouched", () => {
    createRoot((dispose) => {
      const record = createPaneRecord<number>()
      const before = record()
      record.update("ghost", (current) => current)
      expect(record()).toBe(before)
      dispose()
    })
  })

  test("forgetting a pane that was never there is not an error", () => {
    createRoot((dispose) => {
      const record = createPaneRecord<number>()
      record.forget("ghost")
      expect(record()).toEqual({})
      dispose()
    })
  })
})

describe("createPaneRecords", () => {
  test("forgetting a pane clears it out of every record", () => {
    createRoot((dispose) => {
      const records = createPaneRecords()

      records.reports.set("p1", { tokens: 1000 })
      records.buffers.set("p1", {
        path: "/x",
        saved: "a",
        draft: "b",
        dirty: true,
        truncated: false,
      })
      records.bufferLoading.set("p1", true)
      records.permissions.set("p1", { what: "scrivere", kind: "write", answers: [] })

      // A second pane, to prove the forgetting is targeted.
      records.bufferLoading.set("p2", true)

      records.forget("p1")

      expect(records.reports()).toEqual({})
      expect(records.buffers()).toEqual({})
      expect(records.permissions()).toEqual({})
      expect(records.bufferLoading()).toEqual({ p2: true })

      dispose()
    })
  })

  test("every record declared is a record that gets forgotten", () => {
    createRoot((dispose) => {
      const records = createPaneRecords()
      /*
       * The defect this guards against: `forgetPane` used to name each map by
       * hand, so adding an eighth one left it leaking entries for closed
       * panes with nothing to notice it. Anything callable on the bundle is a
       * record, and after `forget` none of them may still hold the pane.
       */
      const every = Object.entries(records).filter(([name]) => name !== "forget")
      expect(every.length).toBe(7)

      for (const [, record] of every) {
        ;(record as ReturnType<typeof createPaneRecord>).set("p1", true as never)
      }
      records.forget("p1")
      for (const [name, record] of every) {
        expect([name, (record as ReturnType<typeof createPaneRecord>)()]).toEqual([name, {}])
      }

      dispose()
    })
  })
})

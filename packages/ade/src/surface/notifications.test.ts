import { describe, expect, test } from "bun:test"
import {
  addNotice,
  bellTone,
  COALESCE_MS,
  dismissNotice,
  markAllRead,
  MAX_NOTICES,
  unreadCount,
  type Notice,
} from "./notifications"

const at = 1_000_000

describe("addNotice", () => {
  test("the newest is first, and arrives unread", () => {
    const list = addNotice(addNotice([], { kind: "info", text: "prima", at }), {
      kind: "info",
      text: "seconda",
      at: at + 1,
    })
    expect(list.map((n) => n.text)).toEqual(["seconda", "prima"])
    expect(list[0]!.read).toBe(false)
  })

  /*
   * An agent that fails to write a file fails to write it four times. Four
   * rows say nothing the first one did not, and they push everything else
   * out of the window that keeps the list readable.
   */
  test("the same notice repeated at once is one row", () => {
    let list: Notice[] = []
    for (let i = 0; i < 5; i++) list = addNotice(list, { kind: "error", text: "EPERM", at: at + i })
    expect(list).toHaveLength(1)
    expect(list[0]!.at).toBe(at + 4)
  })

  test("the same notice much later is a new event", () => {
    const first = addNotice([], { kind: "error", text: "EPERM", at })
    const later = addNotice(first, { kind: "error", text: "EPERM", at: at + COALESCE_MS + 1 })
    expect(later).toHaveLength(2)
  })

  test("the same text from another session is another notice", () => {
    const first = addNotice([], { kind: "error", text: "fallito", paneId: "a", at })
    const second = addNotice(first, { kind: "error", text: "fallito", paneId: "b", at: at + 1 })
    expect(second).toHaveLength(2)
  })

  test("only the newest coalesces, so a repeat after something else is kept", () => {
    let list = addNotice([], { kind: "error", text: "EPERM", at })
    list = addNotice(list, { kind: "info", text: "altro", at: at + 1 })
    list = addNotice(list, { kind: "error", text: "EPERM", at: at + 2 })
    expect(list).toHaveLength(3)
  })

  /*
   * A notice folded into one the user has already read must not light the
   * bell again: a bell that relights for something dismissed teaches people
   * to ignore the bell.
   */
  test("folding into a read notice does not make it unread", () => {
    const read = markAllRead(addNotice([], { kind: "error", text: "EPERM", at }))
    const folded = addNotice(read, { kind: "error", text: "EPERM", at: at + 1 })
    expect(folded[0]!.read).toBe(true)
    expect(unreadCount(folded)).toBe(0)
  })

  test("the list is capped, oldest first", () => {
    let list: Notice[] = []
    for (let i = 0; i < MAX_NOTICES + 10; i++) {
      list = addNotice(list, { kind: "info", text: `n${i}`, at: at + i * COALESCE_MS })
    }
    expect(list).toHaveLength(MAX_NOTICES)
    expect(list[0]!.text).toBe(`n${MAX_NOTICES + 9}`)
  })

  test("every notice has an id of its own", () => {
    let list: Notice[] = []
    for (let i = 0; i < 20; i++) {
      list = addNotice(list, { kind: "info", text: `n${i}`, at: at + i * COALESCE_MS })
    }
    expect(new Set(list.map((n) => n.id)).size).toBe(list.length)
  })
})

describe("unreadCount and markAllRead", () => {
  const three = ["a", "b", "c"].reduce<Notice[]>(
    (list, text, i) => addNotice(list, { kind: "info", text, at: at + i * COALESCE_MS }),
    [],
  )

  test("counts what has not been seen", () => {
    expect(unreadCount(three)).toBe(3)
    expect(unreadCount([])).toBe(0)
  })

  test("opening the list reads all of it", () => {
    expect(unreadCount(markAllRead(three))).toBe(0)
  })

  test("reading twice changes nothing and keeps the notices", () => {
    const once = markAllRead(three)
    expect(markAllRead(once)).toEqual(once)
    expect(markAllRead(once)).toHaveLength(3)
  })
})

describe("dismissNotice", () => {
  test("removes exactly the one named", () => {
    const list = addNotice(addNotice([], { kind: "info", text: "a", at }), {
      kind: "info",
      text: "b",
      at: at + COALESCE_MS,
    })
    const after = dismissNotice(list, list[0]!.id)
    expect(after.map((n) => n.text)).toEqual(["a"])
  })

  test("an id that is not there leaves the list alone", () => {
    const list = addNotice([], { kind: "info", text: "a", at })
    expect(dismissNotice(list, "assente")).toEqual(list)
  })
})

describe("bellTone", () => {
  test("nothing unread is quiet", () => {
    expect(bellTone([])).toBe("quiet")
    expect(bellTone(markAllRead(addNotice([], { kind: "error", text: "x", at })))).toBe("quiet")
  })

  test("an unread notice shows, without shouting", () => {
    expect(bellTone(addNotice([], { kind: "done", text: "sessione finita", at }))).toBe("unread")
  })

  /*
   * Only a failure shouts. A bell that alerts for a finished session alerts
   * all day, and then it is not a signal.
   */
  test("an unread failure alerts", () => {
    let list = addNotice([], { kind: "done", text: "finita", at })
    list = addNotice(list, { kind: "error", text: "non salvato", at: at + COALESCE_MS })
    expect(bellTone(list)).toBe("alert")
  })
})

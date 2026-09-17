import { describe, expect, test } from "bun:test"
import { RENAME_EVENT, commitRename, requestRename } from "./rename"

describe("commitRename", () => {
  test("stores a changed name, trimmed", () => {
    expect(commitRename("  Refactor auth  ", "Sessione 1")).toBe("Refactor auth")
  })

  test("keeps the old name when the edit is empty", () => {
    expect(commitRename("", "Sessione 1")).toBeUndefined()
    expect(commitRename("   ", "Sessione 1")).toBeUndefined()
  })

  test("is a no-op when nothing changed", () => {
    expect(commitRename("Sessione 1", "Sessione 1")).toBeUndefined()
    // A trailing space is not a rename.
    expect(commitRename("Sessione 1 ", "Sessione 1")).toBeUndefined()
  })
})

describe("requestRename", () => {
  test("reaches the pane with that id and nothing else", () => {
    const root = document.createElement("div")
    const a = document.createElement("article")
    a.setAttribute("data-pane-id", "p1")
    const b = document.createElement("article")
    b.setAttribute("data-pane-id", "p2")
    root.append(a, b)

    const heard: string[] = []
    a.addEventListener(RENAME_EVENT, () => heard.push("p1"))
    b.addEventListener(RENAME_EVENT, () => heard.push("p2"))

    expect(requestRename("p2", root)).toBe(true)
    expect(heard).toEqual(["p2"])
  })

  test("says so when there is no such pane", () => {
    const root = document.createElement("div")
    expect(requestRename("missing", root)).toBe(false)
    expect(requestRename(undefined, root)).toBe(false)
  })

  test("survives an id that is not a valid selector on its own", () => {
    const root = document.createElement("div")
    const pane = document.createElement("article")
    pane.setAttribute("data-pane-id", 'q"[x]')
    root.append(pane)
    let heard = 0
    pane.addEventListener(RENAME_EVENT, () => heard++)

    expect(requestRename('q"[x]', root)).toBe(true)
    expect(heard).toBe(1)
  })
})

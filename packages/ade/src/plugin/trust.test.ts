import { describe, expect, test } from "bun:test"
import {
  MAX_LABEL,
  assertIdentifier,
  isValidIdentifier,
  parseCommandId,
  pluginPaneId,
  qualifiedCommandId,
  safeKeywords,
  safeLabel,
  safePaneData,
} from "./trust"

describe("identifiers", () => {
  test("accepts what a plugin would reasonably call things", () => {
    for (const value of ["overview", "my-plugin", "my.plugin", "a_b", "x1", "A"]) {
      expect(isValidIdentifier(value)).toBe(true)
    }
  })

  /*
   * Every one of these is a way into the DOM. `"` and `'` break out of the
   * attribute selector the palette already uses; `<` and `&` matter the day
   * something interpolates an id into markup rather than a text node; `:` is
   * the host's own separator and would let a plugin forge a qualified key.
   */
  test("refuses anything that could escape an attribute or forge a key", () => {
    for (const value of ["", " ", 'a"b', "a'b", "a<b", "a&b", "a b", "a/b", "a:b", "-leading", ".leading", "café"]) {
      expect(isValidIdentifier(value)).toBe(false)
    }
  })

  test("64 characters is the edge, 65 is over it", () => {
    expect(isValidIdentifier("a".repeat(64))).toBe(true)
    expect(isValidIdentifier("a".repeat(65))).toBe(false)
  })

  test("the rejection names the plugin and what was being registered", () => {
    expect(() => assertIdentifier("my.plugin", "a command", "bad id")).toThrow(/my\.plugin/)
    expect(() => assertIdentifier("my.plugin", "a command", "bad id")).toThrow(/a command/)
  })
})

describe("labels", () => {
  test("a missing or unusable title falls back to the identifier", () => {
    expect(safeLabel(undefined, "overview")).toBe("overview")
    expect(safeLabel("   ", "overview")).toBe("overview")
    expect(safeLabel(42, "overview")).toBe("overview")
  })

  test("newlines and control characters collapse instead of being refused", () => {
    expect(safeLabel("Mostra\ni\tplugin", "x")).toBe("Mostra i plugin")
    expect(safeLabel("a\u0000b", "x")).toBe("a b")
  })

  /*
   * A title is a text node, so it cannot inject anything — but the palette row
   * is a fixed-width flex child, and an unbounded string pushes the shortcut
   * column off the dialog for every other command in the list.
   */
  test("a very long title is clamped", () => {
    const clamped = safeLabel("x".repeat(500), "fallback")
    expect(clamped.length).toBe(MAX_LABEL)
    expect(clamped.endsWith("…")).toBe(true)
  })

  test("keywords keep only the usable strings, and undefined when none are", () => {
    expect(safeKeywords(["uno", "  due  ", 3, "", null])).toEqual(["uno", "due"])
    expect(safeKeywords([])).toBeUndefined()
    expect(safeKeywords("uno")).toBeUndefined()
    expect(safeKeywords([" ", ""])).toBeUndefined()
  })
})

describe("pane data", () => {
  test("a plain object comes through, anything else does not", () => {
    expect(safePaneData({ tab: "general" })).toEqual({ tab: "general" })
    expect(safePaneData({})).toBeUndefined()
    expect(safePaneData(["a"])).toBeUndefined()
    expect(safePaneData(null)).toBeUndefined()
    expect(safePaneData("x")).toBeUndefined()
  })

  /*
   * The getter must not survive into the workbench: it would then run during
   * ADE's render, inside ADE's reactive scope, which is a different thing
   * from handing over a value.
   */
  test("a getter is read once and copied, not carried through", () => {
    let reads = 0
    const hostile = {
      get tab() {
        reads++
        return "general"
      },
    }
    const copied = safePaneData(hostile)
    expect(reads).toBe(1)
    expect(copied).toEqual({ tab: "general" })
    void copied!.tab
    expect(reads).toBe(1)
  })
})

describe("command namespacing", () => {
  test("a plugin command round-trips", () => {
    const id = qualifiedCommandId("my.plugin", "overview")
    expect(id).toBe("plugin:my.plugin:overview")
    expect(parseCommandId(id)).toEqual({ pluginId: "my.plugin", commandId: "overview" })
  })

  /*
   * The whole point of the namespace: ADE's own ids can never parse as a
   * plugin command, so the dispatch branch in `runCommand` cannot shadow one.
   */
  test("ADE's own command ids are not plugin commands", () => {
    for (const id of ["pane.close", "project.open", "palette.open", "session.new", "project.recent.C:/x"]) {
      expect(parseCommandId(id)).toBeUndefined()
    }
  })

  test("a forged id with the right prefix but a bad segment is refused", () => {
    expect(parseCommandId("plugin:my plugin:overview")).toBeUndefined()
    expect(parseCommandId("plugin:my.plugin:over view")).toBeUndefined()
    expect(parseCommandId("plugin:my.plugin")).toBeUndefined()
    expect(parseCommandId("plugin:a:b:c")).toBeUndefined()
    expect(parseCommandId("notplugin:a:b")).toBeUndefined()
  })
})

describe("pane ids", () => {
  test("two tiles of the same pane are two different ids", () => {
    expect(pluginPaneId("p", "overview", 1)).not.toBe(pluginPaneId("p", "overview", 2))
  })
})

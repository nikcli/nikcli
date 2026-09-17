import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleForTests } from "../i18n"
import { defaultPaneTitle } from "./pane-title"

afterEach(() => resetLocaleForTests("it"))

describe("defaultPaneTitle", () => {
  test("names a new pane in Italian under Italian", () => {
    expect(defaultPaneTitle("agent", 1, "Claude Code")).toBe("Sessione 1 — Claude Code")
    expect(defaultPaneTitle("reviewer", 2, "Codex")).toBe("Revisione 2 — Codex")
    expect(defaultPaneTitle("shell", 3, "Terminal")).toBe("Terminale 3 — Terminal")
  })

  test("names a new pane in English under English", () => {
    resetLocaleForTests("en")
    expect(defaultPaneTitle("agent", 1, "Claude Code")).toBe("Session 1 — Claude Code")
    expect(defaultPaneTitle("reviewer", 2, "Codex")).toBe("Review 2 — Codex")
    expect(defaultPaneTitle("shell", 3, "Terminal")).toBe("Terminal 3 — Terminal")
  })
})

import { describe, expect, test, beforeEach } from "bun:test"
import { findFocusTarget, focusPane, holdsFocus } from "./focus-input"

/**
 * A pane as the grid actually builds one, minus everything irrelevant.
 *
 * The slot names are the ones in `pane.tsx`: the composer's textarea carries
 * `data-slot="pane-input"` and is `disabled` whenever the session has no
 * process listening, which is exactly the case these tests care about.
 */
function pane(options: { terminal?: boolean; composer?: boolean | "disabled" } = {}): HTMLElement {
  const root = document.createElement("article")
  root.setAttribute("data-component", "session-pane")

  if (options.terminal) {
    const terminal = document.createElement("div")
    terminal.setAttribute("data-slot", "pane-terminal")
    // xterm renders into a textarea inside its wrapper; that is what takes keys.
    terminal.appendChild(document.createElement("textarea"))
    root.appendChild(terminal)
  }

  if (options.composer) {
    const prompt = document.createElement("div")
    prompt.setAttribute("data-slot", "pane-prompt")
    const field = document.createElement("textarea")
    field.setAttribute("data-slot", "pane-input")
    if (options.composer === "disabled") field.disabled = true
    prompt.appendChild(field)
    root.appendChild(prompt)
  }

  document.body.appendChild(root)
  return root
}

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("findFocusTarget", () => {
  test("prefers the terminal's textarea over the composer's", () => {
    const root = pane({ terminal: true, composer: true })
    const target = findFocusTarget(root)
    expect(target?.tagName).toBe("TEXTAREA")
    expect(target?.closest('[data-slot="pane-terminal"]')).not.toBeNull()
  })

  test("falls back to the composer when there is no terminal", () => {
    const root = pane({ composer: true })
    expect(findFocusTarget(root)?.getAttribute("data-slot")).toBe("pane-input")
  })

  test("a pane with nothing to type into has no target", () => {
    expect(findFocusTarget(pane())).toBeUndefined()
  })

  /*
   * A finished session disables its composer, and `focus()` on a disabled
   * control does nothing — silently. Returning it would make `focusPane`
   * report success while the caret is still on `<body>`, which is what a
   * file dropped onto a finished session actually does.
   */
  test("a disabled composer is not a place to put the caret", () => {
    expect(findFocusTarget(pane({ composer: "disabled" }))).toBeUndefined()
  })

  test("a live terminal wins over a disabled composer beside it", () => {
    const root = pane({ terminal: true, composer: "disabled" })
    expect(findFocusTarget(root)?.closest('[data-slot="pane-terminal"]')).not.toBeNull()
  })
})

describe("focusPane", () => {
  test("puts the caret in the terminal", () => {
    const root = pane({ terminal: true, composer: true })
    expect(focusPane(root)).toBe(true)
    expect(document.activeElement?.closest('[data-slot="pane-terminal"]')).not.toBeNull()
  })

  test("takes the caret back from outside the pane", () => {
    // This is the drop case: dragging a screenshot leaves focus on the tray
    // button, and without this the user has to click into the session before
    // they can type.
    const tray = document.createElement("button")
    document.body.appendChild(tray)
    const root = pane({ terminal: true })

    tray.focus()
    expect(document.activeElement).toBe(tray)

    expect(focusPane(root)).toBe(true)
    expect(document.activeElement).not.toBe(tray)
  })

  test("says so when there is nothing to focus, instead of throwing", () => {
    expect(focusPane(pane())).toBe(false)
    expect(focusPane(undefined)).toBe(false)
    expect(focusPane(null)).toBe(false)
  })

  test("a finished session reports the caret it could not take", () => {
    expect(focusPane(pane({ composer: "disabled" }))).toBe(false)
  })
})

describe("holdsFocus", () => {
  test("true for the caret anywhere inside", () => {
    const root = pane({ terminal: true })
    const inner = root.querySelector("textarea")!
    expect(holdsFocus(root, inner)).toBe(true)
    expect(holdsFocus(root, root)).toBe(true)
  })

  test("false for the tray, the bar, or nothing at all", () => {
    const root = pane({ terminal: true })
    const outside = document.createElement("button")
    document.body.appendChild(outside)
    expect(holdsFocus(root, outside)).toBe(false)
    expect(holdsFocus(root, null)).toBe(false)
    expect(holdsFocus(null, outside)).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { isDragHandle } from "./drag-handle"

/** The header as `pane.tsx` draws it, with the browser toolbar next to it. */
function header(): HTMLElement {
  const root = document.createElement("div")
  root.innerHTML = `
    <article data-component="session-pane">
      <header data-slot="pane-header">
        <span data-slot="pane-identity"><span data-slot="pane-glyph">•</span></span>
        <h2 data-slot="pane-title">Voice</h2>
        <span class="chip a-state" tabindex="0"><span class="lbl">Al lavoro</span><span class="a-det">Edit · pane.css</span></span>
        <span class="a-q"><b class="qv">57%</b></span>
        <span class="acts"><button data-slot="pane-action" aria-label="Chiudi">x</button></span>
      </header>
      <div data-slot="pane-body"><textarea></textarea></div>
    </article>
    <section data-component="browser-pane">
      <header data-slot="browser-header">
        <span data-slot="pane-grip"><svg></svg></span>
        <input data-slot="browser-url-input" />
      </header>
    </section>`
  document.body.replaceChildren(root)
  return root
}

const pick = (selector: string) => document.querySelector(selector)

describe("isDragHandle", () => {
  test("the header, the title and the state chip are all handles", () => {
    header()
    expect(isDragHandle(pick('[data-slot="pane-header"]'))).toBe(true)
    expect(isDragHandle(pick('[data-slot="pane-title"]'))).toBe(true)
    // The chip is the middle of the header: as a <button> it took that whole
    // strip out of the handle, which is the bug this test exists for.
    expect(isDragHandle(pick(".a-state"))).toBe(true)
    expect(isDragHandle(pick(".a-det"))).toBe(true)
    expect(isDragHandle(pick(".a-q"))).toBe(true)
  })

  test("a control inside the header is not", () => {
    header()
    expect(isDragHandle(pick('[data-slot="pane-action"]'))).toBe(false)
  })

  test("the browser's toolbar and grip are handles, its address field is not", () => {
    header()
    expect(isDragHandle(pick('[data-slot="browser-header"]'))).toBe(true)
    expect(isDragHandle(pick('[data-slot="pane-grip"]'))).toBe(true)
    expect(isDragHandle(pick('[data-slot="browser-url-input"]'))).toBe(false)
  })

  test("the pane's body is not a handle, and neither is nothing at all", () => {
    header()
    expect(isDragHandle(pick('[data-slot="pane-body"]'))).toBe(false)
    expect(isDragHandle(pick("textarea"))).toBe(false)
    expect(isDragHandle(null)).toBe(false)
  })
})

import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { INSPECTOR_BRIDGE_SCRIPT } from "./protocol"

/*
 * The inspector bridge, run in happy-dom the way the frame script runs it:
 * with a `window` of its own whose `parent` is this test. One bridge for the
 * file, since it listens on the shared document.
 */
const posted: any[] = []
const listeners: ((event: { data: unknown }) => void)[] = []
const tell = (data: unknown) => listeners.forEach((listener) => listener({ data }))
/** Events the test calls user input; the frame script's listener lets only real input through. */
const userInput = new WeakSet<Event>()
const last = (type: string) => [...posted].reverse().find((message) => message.type === type)

beforeAll(() => {
  const shim = {
    __NIKCLI_INSPECTOR_ACTIVE__: false,
    __ADE_LISTEN__: (target: EventTarget, type: string, handler: (event: Event) => void, options?: boolean) =>
      target.addEventListener(type, (event) => userInput.has(event) && handler(event), options),
    parent: { postMessage: (message: unknown) => posted.push(message) },
    getComputedStyle: (element: Element) => window.getComputedStyle(element),
    addEventListener: (type: string, handler: any) => {
      if (type === "message") listeners.push(handler)
    },
  }
  const quiet = { ...console }
  new Function("window", INSPECTOR_BRIDGE_SCRIPT)(shim)
  // The bridge forwards the console; the test's own output stays the test's.
  Object.assign(console, quiet)
})

beforeEach(() => {
  posted.length = 0
  tell({ type: "visual-editor:clear-selection" })
})

function page(html: string) {
  document.body.innerHTML = html
}

/** A click in edit mode on `selector`, as the bridge sees one. */
function click(selector: string, altKey = false, real = true) {
  const target = document.querySelector(selector)!
  const original = document.elementFromPoint
  document.elementFromPoint = () => target
  try {
    tell({ type: "visual-editor:set-mode", mode: "edit" })
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, altKey })
    if (real) userInput.add(event)
    document.dispatchEvent(event)
  } finally {
    document.elementFromPoint = original
    tell({ type: "visual-editor:set-mode", mode: "browse" })
  }
  return last("visual-editor:element-selected")?.element
}

describe("input", () => {
  test("a click the page makes up selects nothing", () => {
    page(`<button id="buy">Buy</button>`)
    expect(click("#buy", false, false)).toBeUndefined()
    expect(click("#buy")?.selector).toBe("#buy")
  })
})

describe("sections", () => {
  test("named by class, id, role and tag, with the heading they carry", () => {
    page(`
      <header role="banner"><nav id="main-nav"><a id="home">Home</a></nav></header>
      <div class="HeroSection"><h1>Build faster</h1><a id="start" class="btn">Start</a></div>
      <section id="pricing"><h2>Plans</h2><button id="buy">Buy</button></section>
      <footer><p id="legal">© 2026</p></footer>
    `)
    expect(click("#home").section).toEqual({ name: "nav", label: "nav", selector: "#main-nav" })
    expect(click("#start").section).toEqual({ name: "hero", label: "hero «Build faster»", selector: "body > div.HeroSection" })
    expect(click("#buy").section?.label).toBe("pricing «Plans»")
    expect(click("#legal").section?.name).toBe("footer")
  })

  test("the closest named part wins over a vague one around it", () => {
    page(`<main><section><h2>Why</h2><div class="card"><span id="x">42</span></div></section></main>`)
    expect(click("#x").section?.name).toBe("card")
    page(`<main><section><h2>Why</h2><span id="y">42</span></section></main>`)
    expect(click("#y").section?.label).toBe("section «Why»")
    page(`<main><span id="z">42</span></main>`)
    expect(click("#z").section?.name).toBe("main")
    page(`<div><span id="w">42</span></div>`)
    expect(click("#w").section).toBeUndefined()
  })

  test("a data-section attribute is taken as the name", () => {
    page(`<div data-section="Chi siamo!"><p id="p">Testo</p></div>`)
    expect(click("#p").section?.name).toBe("chi siamo")
  })

  test("Alt+click and select-section pick the whole section", () => {
    page(`<footer class="site-footer"><h3>Contatti</h3><a id="mail">scrivi</a></footer>`)
    const whole = click("#mail", true)
    expect(whole.tagName).toBe("footer")
    expect(whole.ownSection).toBe("footer «Contatti»")

    posted.length = 0
    tell({ type: "visual-editor:select-section", selector: "#mail" })
    expect(last("visual-editor:element-selected")?.element.ownSection).toBe("footer «Contatti»")
  })

  test("the page's own text is not a section name it can inject", () => {
    page(`<div class="hero"><h1>a\nb\rc</h1><i id="i">x</i></div>`)
    expect(click("#i").section?.label).toBe("hero «a b c»")
  })
})

describe("edits in place", () => {
  test("a style change reports what it replaced", () => {
    page(`<p id="p" style="color: rgb(0, 0, 0)">Ciao</p>`)
    tell({ type: "visual-editor:apply-style", selector: "#p", property: "color", value: "rgb(0, 128, 0)" })
    expect(last("visual-editor:edit-applied")).toEqual({
      type: "visual-editor:edit-applied",
      selector: "#p",
      property: "color",
      before: "rgb(0, 0, 0)",
      after: "rgb(0, 128, 0)",
    })
  })

  test("text is replaced only in a text-only element", () => {
    page(`<p id="p">Ciao</p><div id="d">Uno <b>due</b></div>`)
    expect(click("#p").textOnly).toBe(true)
    expect(click("#d").textOnly).toBe(false)
    posted.length = 0
    tell({ type: "visual-editor:apply-text", selector: "#p", text: "Salve" })
    tell({ type: "visual-editor:apply-text", selector: "#d", text: "rotto" })
    expect(document.querySelector("#p")!.textContent).toBe("Salve")
    expect(document.querySelector("#d")!.innerHTML).toBe("Uno <b>due</b>")
    expect(posted.filter((message) => message.type === "visual-editor:edit-applied")).toEqual([
      { type: "visual-editor:edit-applied", selector: "#p", property: "text", before: "Ciao", after: "Salve" },
    ])
  })

  test("a bad selector is ignored", () => {
    expect(() => tell({ type: "visual-editor:apply-text", selector: "##", text: "x" })).not.toThrow()
    expect(() => tell({ type: "visual-editor:select-section", selector: "::" })).not.toThrow()
  })
})

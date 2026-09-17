import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FRAME_ENVELOPE, FrameGate, frameGuard, frameScript, newFrameSecret, openEnvelope } from "./frame-script"

const KEY = "invoke-key-that-must-not-leak"

/** Headers that remember every value they were given, like a page wrapping `set`. */
function spyHeaders() {
  const seen: unknown[] = []
  class SpyHeaders extends Headers {
    override set(name: string, value: string) {
      seen.push(value)
      return super.set(name, value)
    }
    override append(name: string, value: string) {
      seen.push(value)
      return super.append(name, value)
    }
  }
  return { SpyHeaders, seen }
}

/**
 * A message event shaped like a browser's: `data` and `source` are getters on
 * the prototype (happy-dom keeps them as fields), which is what a page could
 * replace and what the guard takes early.
 */
class BrowserMessageEvent extends Event {
  #data: unknown
  #source: unknown
  constructor(type: string, init: { data?: unknown; source?: unknown }) {
    super(type)
    this.#data = init.data
    this.#source = init.source
  }
  get data() {
    return this.#data
  }
  get source() {
    return this.#source
  }
}

/** One end of a channel, delivering at once, like a port the page cannot reach. */
class FakePort extends EventTarget {
  peer: FakePort | undefined
  closed = false
  onmessage: ((event: unknown) => void) | null = null
  static pair(): [FakePort, FakePort] {
    const a = new FakePort()
    const b = new FakePort()
    a.peer = b
    b.peer = a
    return [a, b]
  }
  postMessage(data: unknown) {
    const peer = this.peer
    if (this.closed || !peer || peer.closed) return
    // The DOM's dispatch also calls `onmessage`.
    peer.dispatchEvent(new BrowserMessageEvent("message", { data }))
  }
  start() {}
  close() {
    this.closed = true
  }
}

class FakeChannel {
  port1: FakePort
  port2: FakePort
  constructor() {
    ;[this.port1, this.port2] = FakePort.pair()
  }
}

/** An EventTarget whose window listeners `document.open()` can wipe. */
const added = new WeakMap<object, [string, any, any][]>()
class WipeableTarget extends EventTarget {
  override addEventListener(type: string, listener: any, options?: any) {
    added.set(this, [...(added.get(this) ?? []), [type, listener, options]])
    super.addEventListener(type, listener, options)
  }
  wipe() {
    for (const [type, listener, options] of added.get(this) ?? []) super.removeEventListener(type, listener, options)
    added.delete(this)
  }
}

function makeWindow(input: { name?: string; nested?: boolean; top?: boolean; href?: string }) {
  const win = new WipeableTarget() as any
  const topPosted: any[] = []
  const transfers: any[] = []
  const toParent = (message: unknown, _origin?: string, transfer?: unknown[]) => {
    topPosted.push(message)
    transfers.push(transfer)
  }
  const top = input.top ? win : { postMessage: toParent }
  const { SpyHeaders, seen } = spyHeaders()
  const webview = { postMessage: () => topPosted.push("webview") }
  Object.assign(win, {
    top,
    parent: input.nested ? { postMessage: toParent } : top,
    name: input.name ?? "",
    Headers: SpyHeaders,
    MessageEvent: BrowserMessageEvent,
    Event,
    EventTarget: WipeableTarget,
    MessageChannel: FakeChannel,
    MessagePort: FakePort,
    getComputedStyle: () => ({}),
    chrome: { webview },
    location: new URL(input.href ?? "http://localhost:5173/"),
  })
  const fromParent = (data: unknown) => win.dispatchEvent(new BrowserMessageEvent("message", { data, source: win.parent }))
  const fromPage = (data: unknown) => win.dispatchEvent(new BrowserMessageEvent("message", { data, source: win }))
  return { win, topPosted, transfers, seen, webview, fromParent, fromPage, wipeListeners: () => win.wipe() }
}

/** What Tauri's client does before it sends an invoke. */
function tauriRequest(win: any) {
  const headers = new win.Headers({})
  headers.set("Content-Type", "application/json")
  headers.set("Tauri-Callback", "1")
  headers.set("Tauri-Error", "2")
  headers.set("Tauri-Invoke-Key", KEY)
  return headers
}

describe("the generated script", () => {
  const file = readFileSync(join(import.meta.dir, "..", "..", "src-tauri", "scripts", "browser-frame.js"), "utf8")

  test("is up to date (bun scripts/gen-frame-script.ts)", () => {
    expect(file).toBe(frameScript())
  })

  test("parses, and can be put inside a <script> of the mirror", () => {
    expect(() => new Function("window", file)).not.toThrow()
    expect(file.toLowerCase()).not.toContain("</script")
  })
})

describe("frameGuard: ADE's own document", () => {
  test("changes nothing", () => {
    const { win, seen } = makeWindow({ top: true })
    const before = win.Headers
    let started = false
    frameGuard(win, () => (started = true))
    expect(win.Headers).toBe(before)
    expect(() => tauriRequest(win)).not.toThrow()
    expect(seen).toContain(KEY)
    expect(started).toBe(false)
  })
})

describe("frameGuard: any frame", () => {
  test("Tauri's client fails before the key is set, and no page wrapper sees it", () => {
    const { win, seen } = makeWindow({})
    frameGuard(win, () => {})
    expect(() => tauriRequest(win)).toThrow("not available in a frame")
    expect(seen).not.toContain(KEY)
    expect(() => new win.Headers().append("tauri-invoke-key", KEY)).toThrow()
    expect(seen).not.toContain(KEY)
  })

  test("a page's own headers still work", () => {
    const { win } = makeWindow({})
    frameGuard(win, () => {})
    const headers = new win.Headers({ accept: "text/html" })
    headers.set("X-Requested-With", "fetch")
    headers.append("Authorization", "Bearer page-token")
    expect(headers.get("x-requested-with")).toBe("fetch")
    expect(headers instanceof Headers).toBe(true)
  })

  test("the guard cannot be taken back", () => {
    const { win } = makeWindow({})
    frameGuard(win, () => {})
    const guarded = win.Headers
    expect(() => {
      "use strict"
      win.Headers = Headers
    }).toThrow()
    expect(win.Headers).toBe(guarded)
    expect(() => Object.defineProperty(win, "Headers", { value: Headers })).toThrow()
    expect(Object.isFrozen(guarded.prototype)).toBe(true)
  })

  test("the webview's postMessage goes nowhere", () => {
    const { win, topPosted, webview } = makeWindow({})
    frameGuard(win, () => {})
    expect(win.chrome.webview).not.toBe(webview)
    win.chrome.webview.postMessage("ipc")
    expect(topPosted).not.toContain("webview")
  })

  test("runs once per document", () => {
    const { win } = makeWindow({})
    frameGuard(win, () => {})
    const guarded = win.Headers
    frameGuard(win, () => {})
    expect(win.Headers).toBe(guarded)
  })

  test("a frame that is not a pane gets no bridge", () => {
    for (const input of [
      { name: "" },
      { name: "something" },
      { name: "ade-browser", nested: true },
      // The webview's page for "connection refused" or a refused frame,
      // and the frame's first empty document, before the page loads.
      { name: "ade-browser", href: "chrome-error://chromewebdata/" },
      { name: "ade-browser", href: "about:blank" },
    ]) {
      const { win, topPosted } = makeWindow(input)
      let started = false
      frameGuard(win, () => (started = true))
      expect(topPosted).toEqual([])
      expect(started).toBe(false)
    }
  })
})

describe("frameGuard: a browser pane's frame", () => {
  const secret = "0123456789abcdef0123"

  /** The frame's document: the script ran, and asked with a port. */
  function paneFrame(href?: string) {
    const frame = makeWindow({ name: "ade-browser", href })
    let shim: any
    let starts = 0
    frameGuard(frame.win, (given) => {
      starts++
      shim = given
    })
    const ask = frame.topPosted[0]
    const port: FakePort | undefined = frame.transfers[0]?.[0]
    const heard: unknown[] = []
    if (port) port.onmessage = (event: any) => heard.push(event.data)
    return { ...frame, ask, port, heard, shim: () => shim, starts: () => starts }
  }

  test("pages, blobs and the mirror ask, with a port, and get the bridge from it", () => {
    for (const href of ["https://example.com/", "blob:null/8d1c", "about:srcdoc"]) {
      const frame = paneFrame(href)
      expect(frame.ask).toEqual({ type: "ade-browser:ask" })
      expect(frame.port).toBeInstanceOf(FakePort)
      frame.port!.postMessage({ type: "ade-browser:hello", secret })
      expect(frame.starts()).toBe(1)
    }
  })

  test("a hello on the window starts nothing, and the page sees it as any message", () => {
    const frame = paneFrame()
    const pageSaw: unknown[] = []
    frame.win.addEventListener("message", (event: any) => pageSaw.push(event.data))
    frame.fromParent({ type: "ade-browser:hello", secret })
    expect(frame.starts()).toBe(0)
    expect(pageSaw).toHaveLength(1)
  })

  test("the bridge speaks only on the port, in envelopes, and what it said early is not lost", () => {
    const frame = makeWindow({ name: "ade-browser" })
    let shim: any
    frameGuard(frame.win, (given) => {
      shim = given
      given.parent.postMessage({ type: "visual-editor:ready" }, "*")
    })
    const port: FakePort = frame.transfers[0][0]
    const heard: unknown[] = []
    port.onmessage = (event: any) => heard.push(event.data)
    port.postMessage({ type: "ade-browser:hello", secret })
    expect(heard).toEqual([{ type: FRAME_ENVELOPE, secret, message: { type: "visual-editor:ready" } }])
    shim.parent.postMessage({ type: "visual-editor:dom-changed" })
    expect(heard.at(-1)).toEqual({ type: FRAME_ENVELOPE, secret, message: { type: "visual-editor:dom-changed" } })
    // Nothing of it on the window.
    expect(frame.topPosted).toEqual([{ type: "ade-browser:ask" }])
    expect(shim.__NIKCLI_INSPECTOR_ACTIVE__).toBe(false)
    // The page's own copy of the bridge stays out.
    expect(frame.win.__NIKCLI_INSPECTOR_ACTIVE__).toBe(true)
  })

  test("the first secret stays", () => {
    const frame = paneFrame()
    frame.port!.postMessage({ type: "ade-browser:hello", secret })
    frame.port!.postMessage({ type: "ade-browser:hello", secret: "another-secret-00000000" })
    expect(frame.starts()).toBe(1)
    frame.shim().parent.postMessage({ type: "visual-editor:dom-changed" })
    expect(frame.heard.at(-1)).toMatchObject({ secret })
  })

  test("answers a ping, before and after the page wipes the window's listeners", () => {
    const frame = paneFrame()
    frame.port!.postMessage({ type: "ade-browser:ping" })
    frame.wipeListeners()
    frame.port!.postMessage({ type: "ade-browser:ping" })
    expect(frame.heard).toEqual([{ type: "ade-browser:pong" }, { type: "ade-browser:pong" }])
  })

  test("the bridge hears the pane, not the page", () => {
    const frame = paneFrame()
    frame.port!.postMessage({ type: "ade-browser:hello", secret })
    const heard: unknown[] = []
    frame.shim().addEventListener("message", (event: any) => heard.push(event.data))
    frame.fromPage({ type: "visual-editor:set-mode", mode: "edit" })
    frame.fromParent({ type: "visual-editor:set-mode", mode: "edit" })
    expect(heard).toEqual([{ type: "visual-editor:set-mode", mode: "edit" }])
  })

  test("the bridge's input listeners let no made-up event through", () => {
    const frame = paneFrame()
    frame.port!.postMessage({ type: "ade-browser:hello", secret })
    const target = new EventTarget()
    const heard: unknown[] = []
    frame.shim().__ADE_LISTEN__(target, "click", (event: unknown) => heard.push(event))
    target.dispatchEvent(new Event("click"))
    expect(heard).toEqual([])
  })
})

describe("FrameGate", () => {
  const secrets = () => {
    let n = 0
    return () => `secret-${++n}`.padEnd(20, "0")
  }

  /** The pane's end and the frame's end of one ask; `live` says whether the frame's document is still there. */
  function asker() {
    const [pane, frame] = FakePort.pair()
    const state = { live: true, hello: undefined as unknown }
    frame.onmessage = (event: any) => {
      if (!state.live) return
      if (event.data.type === "ade-browser:ping") frame.postMessage({ type: "ade-browser:pong" })
      if (event.data.type === "ade-browser:hello") state.hello = event.data.secret
    }
    return { pane, frame, state }
  }

  function gate() {
    const heard: unknown[] = []
    const g = new FrameGate({ onMessage: (message) => heard.push(message), newSecret: secrets(), grace: 5, wait: 30 })
    return { g, heard }
  }
  const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

  test("the first ask gets a secret at once, and its envelopes are heard", () => {
    const { g, heard } = gate()
    const script = asker()
    g.ask(script.pane)
    expect(script.state.hello).toBe("secret-1".padEnd(20, "0"))
    script.frame.postMessage({ type: FRAME_ENVELOPE, secret: script.state.hello, message: { type: "visual-editor:ready" } })
    script.frame.postMessage({ type: FRAME_ENVELOPE, secret: "forged-secret-000000", message: { type: "x" } })
    expect(heard).toEqual([{ type: "visual-editor:ready" }])
  })

  test("after document.open(): the page's ask gets nothing while the script is there", async () => {
    const { g } = gate()
    const script = asker()
    g.ask(script.pane)
    const page = asker()
    g.ask(page.pane)
    await tick()
    expect(page.state.hello).toBeUndefined()
    expect(page.pane.closed).toBe(true)
    expect(script.pane.closed).toBe(false)
  })

  test("after a navigation: the new document's script gets a new secret, the old port is closed", async () => {
    const { g, heard } = gate()
    const old = asker()
    g.ask(old.pane)
    old.state.live = false
    const next = asker()
    g.ask(next.pane)
    expect(next.state.hello).toBeUndefined()
    await tick()
    expect(next.state.hello).toBe("secret-2".padEnd(20, "0"))
    expect(old.pane.closed).toBe(true)
    old.frame.postMessage({ type: FRAME_ENVELOPE, secret: "secret-1".padEnd(20, "0"), message: { type: "late" } })
    expect(heard).toEqual([])
  })

  test("in a new document, the script's ask wins over the page's that follows it", async () => {
    const { g } = gate()
    const old = asker()
    g.ask(old.pane)
    old.state.live = false
    const script = asker()
    const page = asker()
    g.ask(script.pane)
    g.ask(page.pane)
    await tick()
    expect(script.state.hello).toBeDefined()
    expect(page.state.hello).toBeUndefined()
  })

  test("a document that stalls answers late, and still loses", async () => {
    const { g } = gate()
    const script = asker()
    g.ask(script.pane)
    // The page stalls its thread: both answers come out together, the asker's first.
    script.state.live = false
    const page = asker()
    page.state.live = false
    g.ask(page.pane)
    await tick(10)
    page.frame.postMessage({ type: "ade-browser:pong" })
    script.frame.postMessage({ type: "ade-browser:pong" })
    await tick()
    expect(page.state.hello).toBeUndefined()
    expect(page.pane.closed).toBe(true)
  })

  test("nobody answers: nothing is handed out", async () => {
    const { g } = gate()
    const old = asker()
    g.ask(old.pane)
    old.state.live = false
    const gone = asker()
    gone.state.live = false
    g.ask(gone.pane)
    await tick()
    expect(gone.pane.closed).toBe(true)
  })

  test("an ask without a port is ignored, and dispose closes everything", () => {
    const { g } = gate()
    g.ask(undefined)
    const script = asker()
    g.ask(script.pane)
    g.dispose()
    expect(script.pane.closed).toBe(true)
  })
})

describe("openEnvelope", () => {
  const secret = newFrameSecret()

  test("opens only an envelope with the pane's secret", () => {
    const message = { type: "visual-editor:ready" }
    expect(openEnvelope({ type: FRAME_ENVELOPE, secret, message }, secret)).toEqual(message)
    expect(openEnvelope({ type: FRAME_ENVELOPE, secret: "guess", message }, secret)).toBeUndefined()
    expect(openEnvelope({ type: FRAME_ENVELOPE, message }, secret)).toBeUndefined()
    expect(openEnvelope(message, secret)).toBeUndefined()
    expect(openEnvelope(null, secret)).toBeUndefined()
    expect(openEnvelope("visual-editor:ready", secret)).toBeUndefined()
  })

  test("an empty or short secret opens nothing", () => {
    expect(openEnvelope({ type: FRAME_ENVELOPE, secret: "", message: 1 }, "")).toBeUndefined()
  })

  test("secrets are long and different", () => {
    expect(secret).toMatch(/^[0-9a-f]{36}$/)
    expect(newFrameSecret()).not.toBe(secret)
  })
})

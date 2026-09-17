/**
 * The script ADE's window runs at the start of every document in every frame.
 *
 * The desktop host registers it with `initialization_script_for_all_frames`
 * (`src-tauri/src/lib.rs`), from `src-tauri/scripts/browser-frame.js`, which
 * `bun scripts/gen-frame-script.ts` writes from this module. A test keeps the
 * two equal.
 *
 * It does two things, and nothing in ADE's own document:
 *
 * 1. **In every frame, Tauri's IPC is made inert.** On Windows every
 *    initialization script, Tauri's own included, also runs in subframes, so
 *    a page in a pane finds `window.__TAURI_INTERNALS__` and `window.ipc`.
 *    Tauri refuses the calls (S46 F0), and this is the second barrier: an
 *    invoke from a frame now fails before Tauri's client puts its key in a
 *    request, so a page that wraps `fetch` or `postMessage` has nothing to
 *    read. The objects cannot be removed (Tauri defines them
 *    non-configurable), so what goes is the one path to the key: the
 *    `Tauri-*` request headers.
 *
 * 2. **In a browser pane's frame, the inspector bridge is loaded** into the
 *    real page, so any page that can be framed can be inspected, not only
 *    the ones that ship the bridge. The pane's frame is the direct child of
 *    ADE's window named `ade-browser`. The script opens a `MessageChannel`
 *    before any page script runs and hands the pane one end with its ask;
 *    the secret comes back, and the bridge speaks, only on that channel. A
 *    page posting `visual-editor:ready` on its own is not believed, and a
 *    page that wipes the script's window listeners (`document.open()`) has
 *    nothing to overhear: the channel's listener is not on the window.
 *
 * The pane answers one ask per document (`FrameGate`): a later ask is
 * answered only when the document holding the channel no longer replies,
 * which is what a navigation looks like and a `document.open()` does not.
 */

import { INSPECTOR_BRIDGE_SCRIPT } from "./protocol"

/** The `name` of a browser pane's frame. */
export const FRAME_NAME = "ade-browser"
/** Frame → pane, on the window, with a port: "send me the secret". Anyone in the frame can send it. */
export const FRAME_ASK = "ade-browser:ask"
/** Pane → frame, on the port: the secret. */
export const FRAME_HELLO = "ade-browser:hello"
/** Pane → frame and back, on the port: "is the document that asked still there?" */
export const FRAME_PING = "ade-browser:ping"
export const FRAME_PONG = "ade-browser:pong"
/** Frame → pane, on the port: one bridge message, with the secret. */
export const FRAME_ENVELOPE = "ade-browser:bridge"

export interface FrameEnvelope {
  type: typeof FRAME_ENVELOPE
  secret: string
  message: unknown
}

/** The bridge message inside an envelope, when the envelope carries `secret`. */
export function openEnvelope(data: unknown, secret: string): unknown {
  if (!data || typeof data !== "object") return undefined
  const envelope = data as Partial<FrameEnvelope>
  if (envelope.type !== FRAME_ENVELOPE || typeof envelope.secret !== "string") return undefined
  if (envelope.secret !== secret || secret.length < 16) return undefined
  return envelope.message
}

/** A fresh secret for one pane. */
export function newFrameSecret(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The script's body. Serialised with `toString`, so it must not refer to
 * anything outside itself: the constants above are repeated inside on purpose.
 *
 * Page scripts run after it, so whatever it needs later — getters, `call`,
 * `postMessage` — it takes now, before the page can replace them.
 */
export function frameGuard(win: any, bridge: (shim: any) => void): void {
  if (win.top === win) return
  const define = Object.defineProperty
  const uncurry = Function.prototype.bind.bind(Function.prototype.call)
  if (win.__ADE_FRAME__) return
  define(win, "__ADE_FRAME__", { value: true })

  // 1. IPC: no Tauri-* header can be set in a frame.
  try {
    const Base = win.Headers
    if (typeof Base === "function") {
      const test = uncurry(RegExp.prototype.test)
      const tauriHeader = /^\s*tauri-/i
      // Tauri names its headers with string literals; a page's own names pass.
      const isTauri = (name: unknown) => typeof name === "string" && test(tauriHeader, name)
      const refuse = () => {
        throw new TypeError("ADE: Tauri IPC is not available in a frame")
      }
      class FrameHeaders extends Base {
        set(name: unknown, value: unknown) {
          if (isTauri(name)) refuse()
          return super.set(name, value)
        }
        append(name: unknown, value: unknown) {
          if (isTauri(name)) refuse()
          return super.append(name, value)
        }
      }
      Object.freeze(FrameHeaders.prototype)
      Object.freeze(FrameHeaders)
      define(win, "Headers", { value: FrameHeaders, writable: false, configurable: false })
    }
  } catch {}
  try {
    const webview = win.chrome && win.chrome.webview
    if (webview) {
      const inert = Object.freeze({
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
      })
      define(win.chrome, "webview", { value: inert, writable: false, configurable: false })
    }
  } catch {}

  // 2. The inspector, in a browser pane's frame only.
  if (win.parent !== win.top || win.name !== "ade-browser") return
  /*
   * The bridge goes into a page or the mirror (about:srcdoc), not into the
   * frame's first empty document or the webview's error page: either would
   * announce the bridge over a page that never loads ("connection refused",
   * a site that refuses framing). Those documents do not ask.
   */
  const location = win.location || {}
  const scheme = String(location.protocol)
  const bridgeHere =
    scheme === "http:" || scheme === "https:" || scheme === "blob:" || String(location.href) === "about:srcdoc"

  if (!bridgeHere) return

  const eventProto = win.MessageEvent.prototype
  const getData = uncurry(Object.getOwnPropertyDescriptor(eventProto, "data")!.get!)
  const getSource = uncurry(Object.getOwnPropertyDescriptor(eventProto, "source")!.get!)
  const listen = uncurry(win.EventTarget.prototype.addEventListener)
  const parent = win.parent
  const postToParent = uncurry(parent.postMessage)
  const portProto = win.MessagePort.prototype
  const portPost = uncurry(portProto.postMessage)
  const portStart = uncurry(portProto.start)
  const computed = uncurry(win.getComputedStyle)
  const push = uncurry(Array.prototype.push)
  const shift = uncurry(Array.prototype.shift)
  // `isTrusted` is each event's own getter; on anything but a real event it throws.
  const trustedGetter = Object.getOwnPropertyDescriptor(new win.Event("ade"), "isTrusted")
  const isTrustedOf = trustedGetter && trustedGetter.get ? uncurry(trustedGetter.get) : undefined
  const trusted = (event: unknown) => {
    try {
      return isTrustedOf ? isTrustedOf(event) === true : false
    } catch {
      return false
    }
  }

  // A site's own copy of the bridge stays out: this one is the one ADE trusts.
  define(win, "__NIKCLI_INSPECTOR_ACTIVE__", { value: true, writable: false, configurable: false })

  let secret: string | undefined
  let started = false
  const queue: unknown[] = []
  const channel = new win.MessageChannel()
  const port = channel.port1
  const send = (message: unknown) => {
    if (secret === undefined) {
      push(queue, message)
      return
    }
    portPost(port, { type: "ade-browser:bridge", secret, message })
  }
  // A listener on the page's DOM that only real input reaches: a page's
  // `dispatchEvent(new MouseEvent("click"))` selects nothing.
  const listenTrusted = (target: unknown, type: string, handler: (event: unknown) => void, options?: unknown) =>
    listen(
      target,
      type,
      (event: unknown) => {
        if (trusted(event)) handler(event)
      },
      options,
    )

  listen(port, "message", (event: unknown) => {
    const data = getData(event)
    if (!data || typeof data !== "object") return
    if (data.type === "ade-browser:ping") {
      portPost(port, { type: "ade-browser:pong" })
      return
    }
    if (data.type !== "ade-browser:hello" || secret !== undefined || typeof data.secret !== "string") return
    secret = data.secret as string
    while (queue.length) send(shift(queue))
    if (started) return
    started = true
    bridge({
      __NIKCLI_INSPECTOR_ACTIVE__: false,
      __ADE_LISTEN__: listenTrusted,
      parent: { postMessage: (message: unknown) => send(message) },
      getComputedStyle: (element: unknown, pseudo?: unknown) => computed(win, element, pseudo),
      addEventListener: (type: string, handler: (event: unknown) => void, options?: unknown) => {
        if (type !== "message") return listen(win, type, handler, options)
        // Only what the pane sends reaches the bridge.
        return listen(
          win,
          "message",
          (event: unknown) => {
            if (getSource(event) !== parent) return
            handler({ data: getData(event), source: parent })
          },
          options,
        )
      },
    })
  })
  portStart(port)
  postToParent(parent, { type: "ade-browser:ask" }, "*", [channel.port2])
}

/** What `FrameGate` needs of a port: a browser `MessagePort`, or a test's. */
export type GatePort = Pick<MessagePort, "postMessage" | "close" | "onmessage">

/**
 * The pane's side of the channel: which ask gets the secret.
 *
 * The first ask is the frame script's, sent before any page script runs, so
 * it is answered at once. A later ask comes from a new document (a
 * navigation) or from the page of the current one (after `document.open()`
 * wiped the script's listeners, the page can ask on its own). They are told
 * apart by asking the port that holds the secret whether its document is
 * still there: a navigated-away document never answers; the script of the
 * current one always does, even after `document.open()`, because its
 * listener is on the port. A page that stalls its own thread stalls that
 * answer and its own ask's answer together, so the verdict waits for an
 * asker to answer and then `grace` more. Every answered ask gets a new
 * secret, and the old port is closed.
 */
export class FrameGate {
  private current: GatePort | undefined
  private asks: { port: GatePort; alive: boolean }[] = []
  private currentAlive = false
  private graceTimer: ReturnType<typeof setTimeout> | undefined
  private waitTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly options: {
      /** One bridge message from the document that holds the secret. */
      onMessage: (message: unknown) => void
      newSecret?: () => string
      grace?: number
      wait?: number
    },
  ) {}

  ask(port: GatePort | undefined): void {
    if (!port) return
    if (!this.current) {
      this.accept(port)
      return
    }
    const entry = { port, alive: false }
    this.asks.push(entry)
    port.onmessage = (event) => {
      if (!isPong(event.data) || entry.alive) return
      entry.alive = true
      this.graceTimer ??= setTimeout(() => this.settle(), this.options.grace ?? 300)
    }
    port.postMessage({ type: FRAME_PING })
    if (this.asks.length > 1) return
    this.currentAlive = false
    this.current.postMessage({ type: FRAME_PING })
    this.waitTimer = setTimeout(() => this.settle(), this.options.wait ?? 3000)
  }

  dispose(): void {
    this.clearTimers()
    for (const entry of this.asks) entry.port.close()
    this.asks = []
    this.current?.close()
    this.current = undefined
  }

  private settle(): void {
    this.clearTimers()
    const asks = this.asks
    this.asks = []
    // The document that holds the secret is still there: nobody else gets one.
    const winner = this.currentAlive ? undefined : asks.find((entry) => entry.alive)
    for (const entry of asks) if (entry !== winner) entry.port.close()
    if (!winner) return
    this.current?.close()
    this.accept(winner.port)
  }

  private accept(port: GatePort): void {
    this.current = port
    const secret = (this.options.newSecret ?? newFrameSecret)()
    port.onmessage = (event) => {
      if (this.current !== port) return
      if (isPong(event.data)) {
        this.currentAlive = true
        return
      }
      const message = openEnvelope(event.data, secret)
      if (message !== undefined) this.options.onMessage(message)
    }
    port.postMessage({ type: FRAME_HELLO, secret })
  }

  private clearTimers(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer)
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.graceTimer = undefined
    this.waitTimer = undefined
  }
}

function isPong(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === FRAME_PONG
}

/** The whole script, as the host injects it. */
export function frameScript(): string {
  return [
    "// Generated by packages/ade/scripts/gen-frame-script.ts from src/browser/frame-script.ts. Do not edit.",
    `;(${frameGuard.toString()})(window, function (window) {${INSPECTOR_BRIDGE_SCRIPT}});`,
    "",
  ].join("\n")
}

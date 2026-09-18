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

import { INSPECTOR_BRIDGE_SCRIPT } from "./protocol";

/** The `name` of a browser pane's frame. */
export const FRAME_NAME = "ade-browser";
/** Frame → pane, on the window, with a port: "send me the secret". Anyone in the frame can send it. */
export const FRAME_ASK = "ade-browser:ask";
/** Pane → frame, on the port: the secret. */
export const FRAME_HELLO = "ade-browser:hello";
/** Pane → frame and back, on the port: "is the document that asked still there?" */
export const FRAME_PING = "ade-browser:ping";
export const FRAME_PONG = "ade-browser:pong";
/** Frame → pane, on the port: one bridge message, with the secret. */
export const FRAME_ENVELOPE = "ade-browser:bridge";

export interface FrameEnvelope {
  type: typeof FRAME_ENVELOPE;
  secret: string;
  message: unknown;
}

/** The bridge message inside an envelope, when the envelope carries `secret`. */
export function openEnvelope(data: unknown, secret: string): unknown {
  if (!data || typeof data !== "object") return undefined;
  const envelope = data as Partial<FrameEnvelope>;
  if (envelope.type !== FRAME_ENVELOPE || typeof envelope.secret !== "string")
    return undefined;
  if (envelope.secret !== secret || secret.length < 16) return undefined;
  return envelope.message;
}

/** A fresh secret for one pane. */
export function newFrameSecret(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * The frame-guard source as a string. It is the single source of truth for
 * what runs inside every framed document: `frameScript()` writes it to the
 * committed artifact, and `frameGuard` below is compiled from the same string
 * so behaviour and serialised source can never drift.
 *
 * The script must not refer to anything outside itself: the constants in this
 * module are repeated inside on purpose. Page scripts run after it, so
 * whatever it needs later — getters, `call`, `postMessage` — it takes now,
 * before the page can replace them.
 *
 * Hand-written, not extracted from `frameGuard`. Bun's transpiler embeds a
 * reformatted copy of a TS function into the emitted JS, and that reformat
 * differs between bun builds (baseline vs full, x64 vs arm). Using
 * `frameGuard.toString()` therefore produced an artifact that matched the test
 * on one machine and not on another; a literal string is stable everywhere.
 */
const FRAME_GUARD_SOURCE = `function frameGuard(win, bridge) {
  if (win.top === win) return
  const define = Object.defineProperty,
    uncurry = Function.prototype.bind.bind(Function.prototype.call)
  if (win.__ADE_FRAME__) return
  define(win, "__ADE_FRAME__", { value: !0 })
  try {
    const Base = win.Headers
    if (typeof Base === "function") {
      const test = uncurry(RegExp.prototype.test),
        tauriHeader = /^\\s*tauri-/i,
        isTauri = (name) => typeof name === "string" && test(tauriHeader, name),
        refuse = () => {
          throw TypeError("ADE: Tauri IPC is not available in a frame")
        }

      class FrameHeaders extends Base {
        set(name, value) {
          if (isTauri(name)) refuse()
          return super.set(name, value)
        }
        append(name, value) {
          if (isTauri(name)) refuse()
          return super.append(name, value)
        }
      }
      Object.freeze(FrameHeaders.prototype)
      Object.freeze(FrameHeaders)
      define(win, "Headers", { value: FrameHeaders, writable: !1, configurable: !1 })
    }
  } catch {}
  try {
    if (win.chrome && win.chrome.webview) {
      const inert = Object.freeze({
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
      })
      define(win.chrome, "webview", { value: inert, writable: !1, configurable: !1 })
    }
  } catch {}
  if (win.parent !== win.top || win.name !== "ade-browser") return
  const location = win.location || {},
    scheme = String(location.protocol)
  if (!(scheme === "http:" || scheme === "https:" || scheme === "blob:" || String(location.href) === "about:srcdoc"))
    return
  const eventProto = win.MessageEvent.prototype,
    getData = uncurry(Object.getOwnPropertyDescriptor(eventProto, "data").get),
    getSource = uncurry(Object.getOwnPropertyDescriptor(eventProto, "source").get),
    listen = uncurry(win.EventTarget.prototype.addEventListener),
    parent = win.parent,
    postToParent = uncurry(parent.postMessage),
    portProto = win.MessagePort.prototype,
    portPost = uncurry(portProto.postMessage),
    portStart = uncurry(portProto.start),
    computed = uncurry(win.getComputedStyle),
    push = uncurry(Array.prototype.push),
    shift = uncurry(Array.prototype.shift),
    trustedGetter = Object.getOwnPropertyDescriptor(new win.Event("ade"), "isTrusted"),
    isTrustedOf = trustedGetter && trustedGetter.get ? uncurry(trustedGetter.get) : void 0,
    trusted = (event) => {
      try {
        return isTrustedOf ? isTrustedOf(event) === !0 : !1
      } catch {
        return !1
      }
    }
  define(win, "__NIKCLI_INSPECTOR_ACTIVE__", { value: !0, writable: !1, configurable: !1 })
  let secret,
    started = !1
  const queue = [],
    channel = new win.MessageChannel(),
    port = channel.port1,
    send = (message) => {
      if (secret === void 0) {
        push(queue, message)
        return
      }
      portPost(port, { type: "ade-browser:bridge", secret, message })
    },
    listenTrusted = (target, type, handler, options) =>
      listen(
        target,
        type,
        (event) => {
          if (trusted(event)) handler(event)
        },
        options,
      )
  listen(port, "message", (event) => {
    const data = getData(event)
    if (!data || typeof data !== "object") return
    if (data.type === "ade-browser:ping") {
      portPost(port, { type: "ade-browser:pong" })
      return
    }
    if (data.type !== "ade-browser:hello" || secret !== void 0 || typeof data.secret !== "string") return
    secret = data.secret
    while (queue.length) send(shift(queue))
    if (started) return
    started = !0
    bridge({
      __NIKCLI_INSPECTOR_ACTIVE__: !1,
      __ADE_LISTEN__: listenTrusted,
      parent: { postMessage: (message) => send(message) },
      getComputedStyle: (element, pseudo) => computed(win, element, pseudo),
      addEventListener: (type, handler, options) => {
        if (type !== "message") return listen(win, type, handler, options)
        return listen(
          win,
          "message",
          (event) => {
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
}`;

/**
 * The guard, compiled from `FRAME_GUARD_SOURCE`. Behaviour and serialised
 * source are tied to the same string, so the test that pins the generated
 * artifact (`bun scripts/gen-frame-script.ts`) and the runtime guard can
 * never diverge.
 */
export const frameGuard: (win: any, bridge: (shim: any) => void) => void =
  new Function("return (" + FRAME_GUARD_SOURCE + ")")();

/** What `FrameGate` needs of a port: a browser `MessagePort`, or a test's. */
export type GatePort = Pick<MessagePort, "postMessage" | "close" | "onmessage">;

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
  private current: GatePort | undefined;
  private asks: { port: GatePort; alive: boolean }[] = [];
  private currentAlive = false;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private waitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: {
      /** One bridge message from the document that holds the secret. */
      onMessage: (message: unknown) => void;
      newSecret?: () => string;
      grace?: number;
      wait?: number;
    },
  ) {}

  ask(port: GatePort | undefined): void {
    if (!port) return;
    if (!this.current) {
      this.accept(port);
      return;
    }
    const entry = { port, alive: false };
    this.asks.push(entry);
    port.onmessage = (event) => {
      if (!isPong(event.data) || entry.alive) return;
      entry.alive = true;
      this.graceTimer ??= setTimeout(
        () => this.settle(),
        this.options.grace ?? 300,
      );
    };
    port.postMessage({ type: FRAME_PING });
    if (this.asks.length > 1) return;
    this.currentAlive = false;
    this.current.postMessage({ type: FRAME_PING });
    this.waitTimer = setTimeout(() => this.settle(), this.options.wait ?? 3000);
  }

  dispose(): void {
    this.clearTimers();
    for (const entry of this.asks) entry.port.close();
    this.asks = [];
    this.current?.close();
    this.current = undefined;
  }

  private settle(): void {
    this.clearTimers();
    const asks = this.asks;
    this.asks = [];
    // The document that holds the secret is still there: nobody else gets one.
    const winner = this.currentAlive
      ? undefined
      : asks.find((entry) => entry.alive);
    for (const entry of asks) if (entry !== winner) entry.port.close();
    if (!winner) return;
    this.current?.close();
    this.accept(winner.port);
  }

  private accept(port: GatePort): void {
    this.current = port;
    const secret = (this.options.newSecret ?? newFrameSecret)();
    port.onmessage = (event) => {
      if (this.current !== port) return;
      if (isPong(event.data)) {
        this.currentAlive = true;
        return;
      }
      const message = openEnvelope(event.data, secret);
      if (message !== undefined) this.options.onMessage(message);
    };
    port.postMessage({ type: FRAME_HELLO, secret });
  }

  private clearTimers(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.graceTimer = undefined;
    this.waitTimer = undefined;
  }
}

function isPong(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { type?: unknown }).type === FRAME_PONG
  );
}

/** The whole script, as the host injects it. */
export function frameScript(): string {
  return [
    "// Generated by packages/ade/scripts/gen-frame-script.ts from src/browser/frame-script.ts. Do not edit.",
    `;(${FRAME_GUARD_SOURCE})(window, function (window) {${INSPECTOR_BRIDGE_SCRIPT}});`,
    "",
  ].join("\n");
}

/**
 * The canonical source of the guard. Exported so the test can assert the
 * function compiled from it behaves like `frameGuard`, which keeps the two
 * views (runtime + serialised) anchored to the same string.
 */
export const FRAME_GUARD_BODY = FRAME_GUARD_SOURCE;

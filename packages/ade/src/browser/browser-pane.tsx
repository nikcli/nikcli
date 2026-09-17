/**
 * Browser Pane Component for the ADE.
 *
 * Provides a live, interactive web page inside a grid pane. Supports URL navigation,
 * device preset emulation with aspect-ratio-preserving scaling, visual element
 * inspection, and prompt context dispatching to the agent.
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import {
  captureArea,
  editsFor,
  elementSummary,
  mergeEdit,
  propertyName,
  type BrowserRequest,
  type EditRecord,
  type Rect,
} from "./request"
import {
  HANDSHAKE_TIMEOUT_MS,
  INITIAL_HANDSHAKE_STATE,
  bridgelessChoice,
  framingBlocked,
  noticeWithoutCopy,
  type PaneNotice,
  reduceFidelity,
  type Fidelity,
  type HandshakeEvent,
} from "./handshake"
import { type BridgeMessage, type InspectedElement } from "./protocol"
import { FRAME_ASK, FRAME_NAME, FrameGate } from "./frame-script"
import { planSend, type BrowserController, type OwnerStatus, type SessionChoice } from "./binding"
// The same file the host runs in every frame; the mirror carries it inline.
import FRAME_SCRIPT from "../../src-tauri/scripts/browser-frame.js?raw"
import { escapeAttribute, withLoadToken } from "./frame-url"
import {
  canStep,
  currentEntry,
  restoreHistory,
  step,
  visit,
  type BrowserHistory,
} from "./history"
import { canOpenExternally, openExternally, probeFraming, readHeaders } from "./host-bridge"
import { normalizeUrl } from "./url"
import { fitViewport, type DevicePreset } from "./viewport"
import { t } from "../i18n"
import { SENSITIVE_SELECTOR } from "../record/sensitive"

export interface BrowserPaneProps {
  id?: string
  title?: string
  initialUrl?: string
  /** The back/forward list the pane had when it was last drawn. */
  initialHistory?: BrowserHistory
  focused?: boolean
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
  /**
   * Sends the request to session `to`, with the area of the window to
   * photograph. The pane decides `to`: the bound session, or the one the
   * user picks. Resolves to why it could not, or nothing when it went.
   */
  onSendRequest?: (
    request: BrowserRequest,
    capture: { crop: Rect; redact: Rect[]; scale: number },
    to: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string; stopped?: boolean }>
  /** The session this pane is bound to (S46), see `binding.ts`. */
  owner?: OwnerStatus
  /** The running sessions a send can go to, for the chip's menu and the picker. */
  sessions?: SessionChoice[]
  /** Binds the pane to a session, or with `undefined` unbinds it. */
  onBind?: (sessionId: string | undefined) => void
  /** Brings the bound session into view. */
  onFocusOwner?: () => void
  /** What an agent's `@ade browser …` drives; `undefined` when the pane goes. */
  onController?: (controller: BrowserController | undefined) => void
  /**
   * Every page the pane loads, with the history that led to it.
   *
   * The owner keeps both: this component is rebuilt whenever the pane is
   * drawn again, and without them it came back on the URL it was opened with.
   */
  onNavigate?: (url: string, history: BrowserHistory) => void
}

type LoadState = "idle" | "loading" | "ready" | "unreachable"

const DEVICE_LABELS: Record<DevicePreset, string> = {
  responsive: "Fluido",
  desktop: "Desktop",
  tablet: "Tablet",
  mobile: "Mobile",
}

/**
 * Device preset glyphs on a 16px grid, stroke-based, inheriting currentColor.
 * Text labels cost ~230px of toolbar; at pane widths below ~500px that pushes
 * the close button out of reach, so the presets carry icons plus tooltips.
 */
function DevicePresetIcon(props: { preset: DevicePreset }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <Show when={props.preset === "responsive"}>
        <path d="M2 8h12M4.5 5.5L2 8l2.5 2.5M11.5 5.5L14 8l-2.5 2.5" />
      </Show>
      <Show when={props.preset === "desktop"}>
        <rect x="2" y="3" width="12" height="8" rx="1.5" />
        <path d="M8 11v2M5.5 13h5" />
      </Show>
      <Show when={props.preset === "tablet"}>
        <rect x="3.5" y="2" width="9" height="12" rx="1.5" />
        <path d="M7 12h2" />
      </Show>
      <Show when={props.preset === "mobile"}>
        <rect x="5" y="2" width="6" height="12" rx="1.5" />
        <path d="M7.25 12h1.5" />
      </Show>
    </svg>
  )
}

/** What a chip's edit fields change, in the order they are shown. */
const EDIT_FIELDS: { property: string; styleKey?: keyof InspectedElement["styles"]; label: string }[] = [
  { property: "text", label: "browser.edit.text" },
  { property: "color", styleKey: "color", label: "browser.edit.color" },
  { property: "backgroundColor", styleKey: "backgroundColor", label: "browser.edit.background" },
  { property: "fontSize", styleKey: "fontSize", label: "browser.edit.fontSize" },
  { property: "padding", styleKey: "padding", label: "browser.edit.padding" },
  { property: "borderRadius", styleKey: "borderRadius", label: "browser.edit.radius" },
]

/**
 * Change an element in the page, in place: its text when it has only text,
 * and a few styles. Applied on Enter or when the field is left; the page
 * reports what each change replaced, and that goes with the request.
 */
function EditFields(props: { element: InspectedElement; onApply: (property: string, value: string) => void }): JSX.Element {
  const fields = () => EDIT_FIELDS.filter((entry) => entry.property !== "text" || props.element.textOnly)
  return (
    <div data-slot="browser-edit-fields">
      <For each={fields()}>
        {(entry) => {
          const initial = () =>
            entry.property === "text" ? props.element.innerText ?? "" : (entry.styleKey ? props.element.styles?.[entry.styleKey] : "") ?? ""
          let last = initial()
          const commit = (value: string) => {
            if (value === last) return
            last = value
            props.onApply(entry.property, value)
          }
          return (
            <label data-slot="browser-edit-field">
              <span>{t(entry.label as never)}</span>
              <input
                type="text"
                value={initial()}
                spellcheck={false}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === "Enter") commit(e.currentTarget.value)
                }}
                onBlur={(e) => commit(e.currentTarget.value)}
              />
            </label>
          )
        }}
      </For>
    </div>
  )
}

export function BrowserPane(props: BrowserPaneProps): JSX.Element {
  const defaultUrl = normalizeUrl(props.initialUrl || "http://localhost:3000") || "http://localhost:3000"

  const [url, setUrl] = createSignal(defaultUrl)
  const [inputUrl, setInputUrl] = createSignal(url())
  const [history, setHistory] = createSignal(restoreHistory(defaultUrl, props.initialHistory))
  const [srcdoc, setSrcdoc] = createSignal<string | null>(null)
  const [loadToken, setLoadToken] = createSignal(1)
  const [loadState, setLoadState] = createSignal<LoadState>("idle")
  const [loadError, setLoadError] = createSignal<string>()
  const [notice, setNotice] = createSignal<PaneNotice>()
  const [openError, setOpenError] = createSignal<string>()
  /*
   * Fidelity is decided by the reducer in `handshake.ts`, not here.
   *
   * That reducer, and the forty assertions pinning it, were imported by
   * nothing but their own test: this component reimplemented the same
   * transitions inline, and the two had already drifted — the reducer treats
   * `load-error` as terminal, and the component had no way to reach that
   * state at all. A tested state machine that production does not use is not
   * coverage, it is a second opinion nobody asked for.
   */
  const [fidelity, setFidelityRaw] = createSignal<Fidelity>(INITIAL_HANDSHAKE_STATE.fidelity)
  const handshake = (event: HandshakeEvent) => setFidelityRaw((current) => reduceFidelity(current, event))

  const [mode, setMode] = createSignal<"browse" | "edit">("browse")
  const [device, setDevice] = createSignal<DevicePreset>("responsive")
  const [landscape, setLandscape] = createSignal(false)

  const [selection, setSelection] = createSignal<InspectedElement[]>([])
  const [promptText, setPromptText] = createSignal("")
  const [containerBox, setContainerBox] = createSignal({ width: 0, height: 0 })
  const [ownerMenu, setOwnerMenu] = createSignal(false)
  /** A send waiting for the user to say which session gets it. */
  const [asking, setAsking] = createSignal(false)
  /** Edits made in the page from here, with the value each replaced. */
  const [edits, setEdits] = createSignal<EditRecord[]>([])
  /** The chip whose edit fields are open. */
  const [editing, setEditing] = createSignal<string>()
  const [sending, setSending] = createSignal(false)
  /** What the last send did, in the footer. */
  const [sendNote, setSendNote] = createSignal<{ ok: boolean; text: string }>()

  let iframeRef: HTMLIFrameElement | undefined
  let viewportContainerRef: HTMLDivElement | undefined
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined
  let loadGeneration = 0
  /** The page's HTML, fetched when the handshake window closed; the mirror is built from it. */
  let pageCopy: { generation: number; target: string; html: string } | undefined
  /** The mirror is up only because the user chose Inspect: Browse brings the real page back. */
  let mirrorForInspect = false
  /*
   * The channel to the bridge in this pane's frame.
   *
   * The frame script asks for it with a port of its own, before the page
   * runs; the bridge then speaks only on that port, signed (`frame-script.ts`).
   * A page that posts `visual-editor:ready` or a selection on its own is not
   * believed, and a page that asks for the secret itself gets it only if the
   * document holding it is gone.
   */
  const frameGate = new FrameGate({ onMessage: (message) => handleBridge(message as BridgeMessage) })
  onCleanup(() => frameGate.dispose())

  /**
   * Messages to the frame go to `"*"`, for a page loaded by URL too.
   *
   * The frame is sandboxed without `allow-same-origin`, so every document in
   * it — mirror or live page — has an opaque origin, and a target origin of
   * `http://localhost:3000` matches nothing: the message is dropped without an
   * error. That is why Design Mode never switched on for a page carrying the
   * bridge itself. `"*"` gives nothing away: what goes out is the mode, the
   * selectors the page itself sent; the secret goes on the frame script's own
   * port, and what the bridge says comes back on it (`frameGate`).
   */
  const post = (message: unknown) => {
    try {
      iframeRef?.contentWindow?.postMessage(message, "*")
    } catch {
      // Frame might be detached or cross-origin restricted
    }
  }

  const syncMode = () => {
    post({ type: "visual-editor:set-mode", mode: mode() })
  }

  // Effect runs whenever mode changes, keeping the injected inspector in sync.
  createEffect(() => {
    mode()
    syncMode()
  })

  onCleanup(() => {
    if (handshakeTimer) clearTimeout(handshakeTimer)
  })

  /**
   * Replaces the frame with a srcdoc copy of the page, carrying the bridge.
   */
  const showMirror = (target: string, html: string) => {
    // Inject base tag so relative asset URLs resolve against the target server,
    // and inject the bridge script into the document head.
    /*
     * Escaped, because it goes into an attribute.
     *
     * `normalizeUrl` now returns the canonical form, in which a quote is
     * already `%22`, so this is the belt to that braces: `target` also
     * arrives here from a redirect the page chose, and one unescaped `"`
     * closes the `href` and turns the rest into markup.
     */
    const baseHref = escapeAttribute(target.endsWith("/") ? target : `${target}/`)
    const headInjection = `<meta charset="utf-8"><base href="${baseHref}"><script>${FRAME_SCRIPT}<\/script>`

    let injected = html
    if (injected.includes("<head>")) {
      injected = injected.replace("<head>", `<head>${headInjection}\n`)
    } else if (injected.includes("<html>")) {
      injected = injected.replace("<html>", `<html>\n<head>${headInjection}\n</head>\n`)
    } else {
      injected = `${headInjection}\n${injected}`
    }

    handshake({ type: "ready", mode: "mirror" })
    setSrcdoc(injected)
    setLoadState("ready")
    setLoadError(undefined)
    setLoadToken((v) => v + 1)
  }

  /**
   * Decides what the pane shows when the page did not announce the bridge.
   *
   * The real page stays unless it cannot be framed or the user is inspecting:
   * see `bridgelessChoice`. The fetch still runs, because it is what tells a
   * missing page (404) or an unreachable server apart from a working one.
   */
  const settleWithoutBridge = async (target: string, generation: number) => {
    const isCurrent = () => generation === loadGeneration
    /*
     * The host reads the framing headers outside CORS, which a page's own
     * fetch cannot: most servers that refuse framing do not expose the
     * header that says so. Started now so it runs alongside the fetch.
     */
    const probe = probeFraming(target)
    const hostSaysBlocked = async () => framingBlocked(readHeaders(await probe))

    try {
      const res = await fetch(target, { mode: "cors" })
      if (!isCurrent()) return

      if (res.ok) {
        const html = await res.text()
        const blocked = framingBlocked((name) => res.headers.get(name))
        // A bridge that announced itself meanwhile has already settled it.
        if (!isCurrent() || fidelity() !== "pending") return
        pageCopy = { generation, target, html }
        const inspecting = mode() === "edit"
        if (bridgelessChoice({ blocked, inspecting }) === "keep-page") {
          handshake({ type: "no-bridge" })
          setLoadState("ready")
          setLoadError(undefined)
        } else {
          mirrorForInspect = !blocked
          handshake({ type: "timeout" })
          showMirror(target, html)
        }
        if (blocked) return
        /*
         * The host's answer is not waited for: the page is settled already,
         * and the probe can take seconds. If it says the page refuses
         * framing, the frame is empty, and the copy replaces it once.
         */
        if (!(await hostSaysBlocked()) || !isCurrent()) return
        mirrorForInspect = false
        if (srcdoc() === null && fidelity() === "none") showMirror(target, html)
        return
      }
      /*
       * A reply that is not ok is an answer, so the probe below must not run.
       *
       * It used to fall through: the 404 was recorded, then the `no-cors`
       * probe reached the very same server, succeeded, and cleared the error
       * it had just set. The pane said "ready" over a blank frame with no
       * mention of the 404 anywhere — the one case where the user needs to
       * be told the path is wrong, not that everything is fine.
       */
      handshake({ type: "load-error", error: `${res.status} ${res.statusText}` })
      setLoadState("ready")
      setLoadError(`${res.status} ${res.statusText}`)
      return
    } catch (err) {
      if (!isCurrent()) return
      setLoadError(err instanceof Error ? err.message : String(err))
    }

    // The CORS fetch threw, which says nothing about the server: a page with
    // no CORS headers throws exactly like one that is not running. The
    // `no-cors` probe tells the two apart.
    try {
      await fetch(target, { mode: "no-cors" })
      if (!isCurrent()) return
      // Reachable, but with no copy to fall back on. Settled now; the host's
      // answer, when it comes, can only add the message about a refused frame.
      setLoadError(undefined)
      handshake({ type: "load-error" })
      setLoadState("ready")
      setNotice(noticeWithoutCopy({ blocked: false, inspecting: mode() === "edit" }))
      if ((await hostSaysBlocked()) && isCurrent()) setNotice(noticeWithoutCopy({ blocked: true, inspecting: false }))
    } catch {
      if (!isCurrent()) return
      handshake({ type: "load-error", error: "Server non raggiungibile" })
      setLoadState("unreachable")
      setLoadError(t("browser.unreachable"))
    }
  }

  const startHandshake = (target: string, generation: number) => {
    if (handshakeTimer) clearTimeout(handshakeTimer)
    handshakeTimer = setTimeout(() => {
      if (generation !== loadGeneration) return
      // Still pending while the page is fetched: whether it becomes the
      // mirror, stays as it is or fails is what that fetch decides.
      if (fidelity() === "pending") void settleWithoutBridge(target, generation)
    }, HANDSHAKE_TIMEOUT_MS)
  }

  const load = (target: string) => {
    loadGeneration += 1
    const generation = loadGeneration

    if (handshakeTimer) clearTimeout(handshakeTimer)
    pageCopy = undefined
    mirrorForInspect = false
    setNotice(undefined)
    setOpenError(undefined)
    setLoadState("loading")
    setLoadError(undefined)
    setSelection([])
    // A new document: what was edited in the old one is gone with it.
    setEdits([])
    setEditing(undefined)
    setSendNote(undefined)
    handshake({ type: "navigate", url: target })
    setSrcdoc(null)
    setLoadToken((v) => v + 1)

    startHandshake(target, generation)
  }

  /*
   * Inspect needs the bridge, so a page kept without one is swapped for the
   * mirror only when the user asks; Browse puts the real page back.
   */
  createEffect(
    on(
      mode,
      (next) => {
        if (next === "edit") {
          if (fidelity() !== "none" || srcdoc() !== null || notice() === "blocked") return
          const copy = pageCopy
          if (!copy || copy.generation !== loadGeneration) {
            // Settled with no copy: say why Inspect has nothing to select.
            if (loadState() === "ready") setNotice(noticeWithoutCopy({ blocked: false, inspecting: true }))
            return
          }
          mirrorForInspect = true
          showMirror(copy.target, copy.html)
          return
        }
        if (notice() === "no-copy") setNotice(undefined)
        if (mirrorForInspect) load(url())
      },
      { defer: true },
    ),
  )

  const show = (target: string, next: BrowserHistory) => {
    setUrl(target)
    setInputUrl(target)
    load(target)
    if (next === history()) return
    setHistory(next)
    props.onNavigate?.(target, next)
  }

  const navigateTo = (raw: string) => {
    const normalized = normalizeUrl(raw)
    if (!normalized) return
    show(normalized, visit(history(), normalized))
  }

  /*
   * Back and forward walk the pane's own list. They used to call the frame's
   * `history`, which a frame sandboxed without `allow-same-origin` does not
   * let ADE touch: the call threw and the buttons did nothing.
   */
  const go = (delta: -1 | 1) => {
    const next = step(history(), delta)
    if (next !== history()) show(currentEntry(next), next)
  }

  /*
   * A URL set from outside (voice's `browserNavigate`) is a navigation too.
   * The pane's own reports come back through here with the URL it already
   * shows, and stop at the comparison.
   */
  createEffect(
    on(
      () => props.initialUrl,
      (next) => {
        const normalized = next ? normalizeUrl(next) : undefined
        if (normalized && normalized !== url()) navigateTo(normalized)
      },
      { defer: true },
    ),
  )

  const onFrameLoad = () => {
    if (srcdoc() !== null) {
      setLoadState("ready")
    }

    if (srcdoc() === null && fidelity() === "pending") {
      startHandshake(url(), loadGeneration)
    }

    /*
     * There used to be an attempt to reach into `contentDocument` here and
     * append the bridge script directly. It cannot work any more, and it should
     * not: the frame is sandboxed without `allow-same-origin`, so its document
     * has an opaque origin and is unreachable from here by design. That is the
     * point — a `srcdoc` document inherits the embedder's origin unless the
     * sandbox denies it, and this frame is filled with HTML fetched from
     * whatever server the address bar names.
     *
     * A page that does not ship the bridge itself still gets one when the user
     * inspects it: `settleWithoutBridge` keeps a copy, and the bridge is
     * injected into that copy, where it belongs.
     */
    syncMode()
  }

  const handleMessage = (event: MessageEvent) => {
    // Untrusted source guard: ignore any message not originating from our iframe
    if (!iframeRef?.contentWindow || event.source !== iframeRef.contentWindow) return
    const raw = event.data as { type?: unknown } | null
    // The only thing the frame's window may say: "here is my port".
    if (raw && typeof raw === "object" && raw.type === FRAME_ASK) frameGate.ask(event.ports[0])
  }

  const handleBridge = (data: BridgeMessage | undefined) => {
    if (!data || typeof data !== "object" || typeof data.type !== "string") return
    if (!data.type.startsWith("visual-editor:")) return

    if (data.type === "visual-editor:ready") {
      if (handshakeTimer) clearTimeout(handshakeTimer)
      handshake({ type: "ready", mode: srcdoc() === null ? "native" : "mirror" })
      setLoadState("ready")
      syncMode()
      return
    }

    if (data.type === "visual-editor:element-selected") {
      /*
       * Only while the user has design mode on.
       *
       * The message says "the user clicked an element", but nothing about it
       * proves that: the page is the one sending it, and the page is not ADE's.
       * Outside edit mode the user has not asked this page for anything, so an
       * unprompted selection is a page writing text into a prompt box on its
       * own — and that prompt goes to an agent.
       */
      if (mode() !== "edit") return

      const element = data.element
      if (element && typeof element.selector === "string") {
        setSelection((prev) =>
          prev.some((item) => item.selector === element.selector) ? prev : [...prev, element],
        )
      }
      return
    }

    if (data.type === "visual-editor:edit-applied") {
      const edit = data as unknown as Partial<EditRecord>
      if (typeof edit.selector !== "string" || typeof edit.property !== "string") return
      setEdits((current) =>
        mergeEdit(current, {
          selector: edit.selector!,
          property: edit.property!,
          before: String(edit.before ?? ""),
          after: String(edit.after ?? ""),
        }),
      )
      return
    }

    if (data.type === "visual-editor:clear-selection") {
      if (Array.isArray(data.selectors)) {
        const keep = new Set(data.selectors)
        setSelection((prev) => prev.filter((item) => keep.has(item.selector)))
      } else {
        setSelection([])
      }
    }
  }

  onMount(() => {
    window.addEventListener("message", handleMessage)
    onCleanup(() => window.removeEventListener("message", handleMessage))

    if (viewportContainerRef) {
      const observer = new ResizeObserver(([entry]) => {
        if (!entry) return
        const rect = entry.contentRect
        setContainerBox({ width: rect.width, height: rect.height })
      })
      observer.observe(viewportContainerRef)
      onCleanup(() => observer.disconnect())
    }

    load(url())
  })

  const removeElement = (selector: string) => {
    const next = selection().filter((item) => item.selector !== selector)
    setSelection(next)
    post({ type: "visual-editor:clear-selection", selectors: next.map((item) => item.selector) })
  }

  const clearSelection = () => {
    setSelection([])
    post({ type: "visual-editor:clear-selection" })
  }

  const selectSection = (selector: string) => post({ type: "visual-editor:select-section", selector })

  /** An edit typed in a chip, applied to the page; the page reports it back. */
  const applyEdit = (selector: string, property: string, value: string) => {
    if (property === "text") post({ type: "visual-editor:apply-text", selector, text: value })
    else post({ type: "visual-editor:apply-style", selector, property, value })
  }

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  /** Where to photograph: the selected boxes in the frame, without ADE's own secret fields. */
  const captureRequest = () => {
    const box = iframeRef?.getBoundingClientRect()
    const frame: Rect = box ? { x: box.left, y: box.top, w: box.width, h: box.height } : { x: 0, y: 0, w: 0, h: 0 }
    const scale = viewportFit().isResponsive ? 1 : viewportFit().scale
    const crop = captureArea(frame, scale, selection().map((element) => element.rect).filter(Boolean))
    const redact = Array.from(document.querySelectorAll(SENSITIVE_SELECTOR), (element) => {
      const r = element.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    }).filter((r) => r.w > 0 && r.h > 0)
    return { crop, redact, scale: window.devicePixelRatio || 1 }
  }

  const deliver = async (to: string) => {
    if (sending() || !props.onSendRequest) return
    const elements = selection()
    const request: BrowserRequest = {
      paneTitle: props.title || t("browser.preview"),
      url: url(),
      instruction: promptText().trim(),
      elements,
      edits: editsFor(edits(), elements),
      viewport: {
        width: viewportFit().isResponsive ? containerBox().width : viewportFit().viewportWidth,
        height: viewportFit().isResponsive ? containerBox().height : viewportFit().viewportHeight,
        device: DEVICE_LABELS[device()],
      },
    }
    setSending(true)
    setSendNote(undefined)
    // ADE's own popover is over the page: out of the picture while it is taken.
    await nextFrame()
    await nextFrame()
    const outcome = await props.onSendRequest(request, captureRequest(), to).catch((error: unknown) => ({
      ok: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }))
    setSending(false)
    if (!outcome.ok) {
      if ("stopped" in outcome && outcome.stopped) setAsking(true)
      setSendNote({ ok: false, text: t("browser.send.failed", outcome.reason) })
      return
    }
    const title = props.sessions?.find((session) => session.id === to)?.title ?? ""
    setSendNote({ ok: true, text: t("browser.send.sent", title) })
    setAsking(false)
    setPromptText("")
    setEditing(undefined)
    clearSelection()
  }

  /*
   * To the bound session, or ask. Never to whichever session happens to be
   * running: see `planSend`. The text and the selection stay until it goes.
   */
  const sendPromptWithContext = () => {
    if (!promptText().trim() && selection().length === 0) return
    const plan = planSend(props.owner ?? { state: "none" })
    if (plan.kind === "send") void deliver(plan.to)
    else setAsking(true)
  }

  const sendTo = (sessionId: string) => {
    props.onBind?.(sessionId)
    void deliver(sessionId)
  }

  const ownerLabel = () => {
    const owner = props.owner ?? { state: "none" as const }
    if (owner.state === "ready") return t("browser.owner.ready", owner.title)
    if (owner.state === "closed") return t("browser.owner.closed", owner.title)
    return t("browser.owner.none")
  }

  onMount(() => {
    props.onController?.({
      reload: () => load(url()),
      setInspect: (on) => setMode(on ? "edit" : "browse"),
      state: () => ({
        url: url(),
        inspecting: mode() === "edit",
        fidelity: fidelityLabel(),
        selected: selection().length,
      }),
    })
    onCleanup(() => props.onController?.(undefined))
  })

  const viewportFit = createMemo(() =>
    fitViewport({
      preset: device(),
      containerWidth: containerBox().width,
      containerHeight: containerBox().height,
      landscape: landscape(),
    }),
  )

  const fidelityLabel = () => {
    switch (fidelity()) {
      case "native":
        return t("browser.fidelity.native")
      case "mirror":
        return t("browser.fidelity.mirror")
      case "none":
        return t("browser.fidelity.none")
      case "pending":
      default:
        return t("browser.fidelity.pending")
    }
  }

  const dimensionsLabel = () => {
    const fit = viewportFit()
    if (fit.isResponsive) return t("browser.fluid")
    const pct = Math.round(fit.scale * 100)
    return `${fit.viewportWidth}×${fit.viewportHeight} (${pct}%)`
  }

  return (
    <article
      data-component="browser-pane"
      data-focused={props.focused ? "true" : undefined}
      data-fidelity={fidelity()}
      data-mode={mode()}
      data-status={loadState()}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="browser-header">
        {/* Picked up by the grid (`grid/session-grid.tsx`); the toolbar is
            full of controls, so the pane offers one place that is only a
            handle. */}
        <span data-slot="pane-grip" title={t("browser.grip")} aria-hidden="true">
          <svg viewBox="0 0 8 12" width="8" height="12">
            <circle cx="2" cy="2" r="1" />
            <circle cx="6" cy="2" r="1" />
            <circle cx="2" cy="6" r="1" />
            <circle cx="6" cy="6" r="1" />
            <circle cx="2" cy="10" r="1" />
            <circle cx="6" cy="10" r="1" />
          </svg>
        </span>
        <div data-slot="browser-nav-group">
          <button
            type="button"
            data-slot="browser-nav-btn"
            disabled={!canStep(history(), -1)}
            onClick={() => go(-1)}
            aria-label={t("browser.back")}
            title={t("browser.back")}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button
            type="button"
            data-slot="browser-nav-btn"
            disabled={!canStep(history(), 1)}
            onClick={() => go(1)}
            aria-label={t("browser.forward")}
            title={t("browser.forward")}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button
            type="button"
            data-slot="browser-nav-btn"
            onClick={() => load(url())}
            aria-label={t("browser.reload")}
            title={t("browser.reload")}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2 6a4 4 0 1 1 1.2 2.8M2 9V6h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <div data-slot="browser-url-bar">
          <span
            data-slot="browser-status-dot"
            data-status={loadState()}
            aria-hidden="true"
          />
          <input
            type="text"
            data-slot="browser-url-input"
            value={inputUrl()}
            onInput={(e) => setInputUrl(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                navigateTo(inputUrl())
              }
            }}
            placeholder={t("browser.address.placeholder")}
            spellcheck={false}
          />
        </div>

        <div data-slot="browser-mode-group">
          <button
            type="button"
            data-slot="browser-mode-btn"
            data-active={mode() === "browse" ? "true" : undefined}
            onClick={() => setMode("browse")}
            title={t("browser.mode.browse.tip")}
          >
            {t("browser.mode.browse")}
          </button>
          <button
            type="button"
            data-slot="browser-mode-btn"
            data-active={mode() === "edit" ? "true" : undefined}
            onClick={() => setMode("edit")}
            title={t("browser.mode.edit.tip")}
          >
            {t("browser.mode.edit")}
          </button>
        </div>

        <div data-slot="browser-device-group">
          <For each={["responsive", "desktop", "tablet", "mobile"] as const}>
            {(preset) => (
              <button
                type="button"
                data-slot="browser-device-btn"
                data-active={device() === preset ? "true" : undefined}
                onClick={() => setDevice(preset)}
                title={DEVICE_LABELS[preset]}
                aria-label={DEVICE_LABELS[preset]}
              >
                <DevicePresetIcon preset={preset} />
              </button>
            )}
          </For>
          <Show when={device() !== "responsive"}>
            <button
              type="button"
              data-slot="browser-rotate-btn"
              data-active={landscape() ? "true" : undefined}
              onClick={() => setLandscape((v) => !v)}
              title={t("browser.rotate")}
              aria-label={t("browser.rotate")}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.5 1.83L14 5.33" />
                <path d="M14 2v3.33h-3.33" />
              </svg>
            </button>
          </Show>
        </div>

        <Show when={props.onBind}>
          <div
            data-slot="browser-owner-wrap"
            // A click anywhere else, the page included, closes the menu.
            onFocusOut={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOwnerMenu(false)
            }}
          >
            <button
              type="button"
              data-slot="browser-owner"
              data-state={props.owner?.state ?? "none"}
              aria-haspopup="menu"
              aria-expanded={ownerMenu()}
              title={t("browser.owner.tip")}
              onClick={() => setOwnerMenu((open) => !open)}
            >
              {ownerLabel()}
            </button>
            <Show when={ownerMenu()}>
              <div data-slot="browser-owner-menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setOwnerMenu(false)}>
                <Show when={props.owner?.state === "ready"}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOwnerMenu(false)
                      props.onFocusOwner?.()
                    }}
                  >
                    {t("browser.owner.focus")}
                  </button>
                </Show>
                <span data-slot="browser-owner-heading">{t("browser.owner.bind")}</span>
                <For each={props.sessions ?? []} fallback={<span data-slot="browser-owner-empty">{t("browser.send.none")}</span>}>
                  {(session) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={props.owner?.state !== "none" && (props.owner as { id: string }).id === session.id}
                      onClick={() => {
                        setOwnerMenu(false)
                        props.onBind?.(session.id)
                      }}
                    >
                      {session.title}
                    </button>
                  )}
                </For>
                <Show when={props.owner && props.owner.state !== "none"}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOwnerMenu(false)
                      props.onBind?.(undefined)
                    }}
                  >
                    {t("browser.owner.unbind")}
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        <div data-slot="browser-actions">
          <Show when={props.onExpand}>
            <button
              type="button"
              data-slot="browser-action"
              onClick={() => props.onExpand?.()}
              aria-label={t("palette.pane.expand")}
            >
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path
                  d="M1 4.5V1h3.5M11 7.5V11H7.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </Show>
          <Show when={props.onClose}>
            <button
              type="button"
              data-slot="browser-action"
              onClick={() => props.onClose?.()}
              aria-label={t("palette.pane.close")}
            >
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
            </button>
          </Show>
        </div>
      </header>

      <div data-slot="browser-body">
        <div ref={viewportContainerRef} data-slot="browser-viewport-container">
          {/*
            * One iframe, always mounted.
            *
            * There used to be two, in mutually exclusive `<Show>`s sharing a
            * single `ref`: switching device preset unmounted one and mounted
            * the other, so the guest page reloaded from scratch — losing its
            * scroll, its form state and anything it had fetched — merely to
            * change the frame's width. For an instant between the two,
            * `iframeRef` also pointed at a detached node, and any
            * `postMessage` in that window went nowhere.
            *
            * The wrapper's geometry is computed reactively instead. In
            * responsive mode it carries no sizing at all, so the frame fills
            * the pane as it did before.
            */}
          <div
            data-slot="browser-viewport-fit"
            data-responsive={viewportFit().isResponsive ? "true" : undefined}
            style={
              viewportFit().isResponsive
                ? undefined
                : {
                    /*
                     * The space the *scaled* frame actually occupies.
                     *
                     * A transform does not change an element's layout box,
                     * so without this the flex parent reserved the full
                     * unscaled device height and centred that — pushing a
                     * shrunk Desktop preview off the top of the pane.
                     */
                    width: `${viewportFit().renderedWidth}px`,
                    height: `${viewportFit().renderedHeight}px`,
                  }
            }
          >
          <div
            data-slot="browser-viewport-scaler"
            data-responsive={viewportFit().isResponsive ? "true" : undefined}
            style={
              viewportFit().isResponsive
                ? undefined
                : {
                    width: `${viewportFit().viewportWidth}px`,
                    height: `${viewportFit().viewportHeight}px`,
                    transform: `scale(${viewportFit().scale})`,
                    /*
                     * Top left, and the box shrinks with the scale.
                     *
                     * With `top center` and a full-size box, a Desktop
                     * preview in a narrow pane scaled below 1 and the
                     * untransformed layout box stayed full height — so the
                     * scaled frame was laid out for a box far taller than
                     * what it drew, and the preview sat entirely above the
                     * visible area. `renderedWidth`/`renderedHeight` are
                     * what `fitViewport` computes for exactly this, and
                     * nothing used them.
                     */
                    "transform-origin": "top left",
                  }
            }
          >
            <iframe
              ref={iframeRef}
              data-slot="browser-frame"
              /*
               * Keyed on the load token so Reload actually reloads.
               *
               * `setLoadToken` was incremented and never read. In `native`
               * fidelity the Reload button rewrote `src` with the same
               * string, Solid saw no change and wrote nothing, so the frame
               * did not renavigate — and the handshake timer then fired at
               * 1500 ms and replaced a perfectly live page with a static
               * mirror of it.
               */
              data-load={loadToken()}
              src={srcdoc() ? undefined : withLoadToken(url(), loadToken())}
              srcdoc={srcdoc() ?? undefined}
              onLoad={onFrameLoad}
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              name={FRAME_NAME}
              title={props.title || t("browser.preview")}
            />
          </div>
          </div>

          <Show when={loadState() === "unreachable"}>
            <div data-slot="browser-error-overlay">
              <span data-slot="browser-error-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="8" cy="8" r="5.5" />
                  <path d="M2.5 8h11M8 2.5C4.8 5.3 4.8 10.7 8 13.5M8 2.5c3.2 2.8 3.2 8.2 0 11" />
                  <path d="M3.5 3.5l9 9" />
                </svg>
              </span>
              <span data-slot="browser-error-title">{t("browser.error.title")}</span>
              <span data-slot="browser-error-msg">
                {loadError() || t("browser.error.hint")}
              </span>
              <button
                type="button"
                data-slot="browser-retry-btn"
                onClick={() => load(url())}
              >
                {t("browser.retry")}
              </button>
            </div>
          </Show>
          
          <Show when={notice()}>
            {(kind) => (
              <div data-slot="browser-error-overlay" data-notice={kind()}>
                <span data-slot="browser-error-title">
                  {kind() === "blocked" ? t("browser.blocked.title") : t("browser.noCopy.title")}
                </span>
                <span data-slot="browser-error-msg">
                  {kind() === "blocked" ? t("browser.blocked.msg") : t("browser.noCopy.msg")}
                </span>
                <Show when={openError()}>
                  {(problem) => <span data-slot="browser-error-msg">{t("browser.openExternal.failed", problem())}</span>}
                </Show>
                <div data-slot="browser-notice-actions">
                  <Show when={canOpenExternally()}>
                    <button
                      type="button"
                      data-slot="browser-retry-btn"
                      onClick={async () => setOpenError(await openExternally(url()))}
                    >
                      {t("browser.openExternal")}
                    </button>
                  </Show>
                  <Show
                    when={kind() === "no-copy"}
                    fallback={
                      <button type="button" data-slot="browser-retry-btn" onClick={() => load(url())}>
                        {t("browser.retry")}
                      </button>
                    }
                  >
                    <button type="button" data-slot="browser-retry-btn" onClick={() => setMode("browse")}>
                      {t("browser.noCopy.back")}
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </Show>

          <Show when={!sending() && (mode() === "edit" || selection().length > 0)}>
            <div data-slot="browser-prompt-popover">
              <Show when={selection().length > 0}>
                <div data-slot="browser-selection-list">
                  <span data-slot="browser-selection-label">
                    {t("browser.context")} <span data-slot="browser-section-hint">{t("browser.section.hint")}</span>
                  </span>
                  <div data-slot="browser-context-blocks">
                    <For each={selection()}>
                      {(el) => (
                        <div data-slot="browser-context-block">
                          <div data-slot="browser-context-header">
                            <span data-slot="browser-context-tag">&lt;{el.tagName.toLowerCase()}&gt;</span>
                            <span data-slot="browser-context-name">{elementSummary(el)}</span>
                            <Show when={el.section && !el.ownSection}>
                              <button
                                type="button"
                                data-slot="browser-context-action"
                                title={t("browser.section.whole.tip", el.section!.label)}
                                onClick={() => selectSection(el.selector)}
                              >
                                {t("browser.section.whole", el.section!.name)}
                              </button>
                            </Show>
                            <button
                              type="button"
                              data-slot="browser-context-action"
                              aria-expanded={editing() === el.selector}
                              onClick={() => setEditing((open) => (open === el.selector ? undefined : el.selector))}
                            >
                              {t("browser.edit.toggle")}
                            </button>
                            <button
                              type="button"
                              data-slot="browser-context-remove"
                              onClick={() => removeElement(el.selector)}
                              aria-label={`Rimuovi ${el.selector}`}
                            >
                              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                                <path d="M4 4l8 8M12 4l-8 8" />
                              </svg>
                            </button>
                          </div>
                          <Show when={editing() === el.selector}>
                            <EditFields element={el} onApply={(property, value) => applyEdit(el.selector, property, value)} />
                          </Show>
                          <For each={edits().filter((edit) => edit.selector === el.selector)}>
                            {(edit) => (
                              <div data-slot="browser-edit-row">
                                {propertyName(edit.property)}: <s>{edit.before}</s> → {edit.after}
                              </div>
                            )}
                          </For>
                          <Show when={el.outerHTML}>
                            <pre data-slot="browser-context-code"><code>{el.outerHTML}</code></pre>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                  <button
                    type="button"
                    data-slot="browser-clear-selection"
                    onClick={clearSelection}
                  >
                    {t("browser.clearSelection")}
                  </button>
                </div>
              </Show>

              <Show when={asking()}>
                <div data-slot="browser-send-picker" role="dialog" aria-label={t("browser.send.ask")}>
                  <span data-slot="browser-send-question">
                    {props.owner?.state === "closed"
                      ? t("browser.send.closed", props.owner.title)
                      : t("browser.send.ask")}
                  </span>
                  <div data-slot="browser-send-choices">
                    <For each={props.sessions ?? []} fallback={<span data-slot="browser-owner-empty">{t("browser.send.none")}</span>}>
                      {(session) => (
                        <button type="button" data-slot="browser-send-choice" onClick={() => sendTo(session.id)}>
                          {session.title}
                        </button>
                      )}
                    </For>
                    <button type="button" data-slot="browser-clear-selection" onClick={() => setAsking(false)}>
                      {t("new.cancel")}
                    </button>
                  </div>
                </div>
              </Show>

              <div data-slot="browser-prompt-input-row">
                <span data-slot="browser-prompt-caret" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 3l5 5-5 5" />
                  </svg>
                </span>
                <input
                  type="text"
                  data-slot="browser-prompt-input"
                  value={promptText()}
                  onInput={(e) => setPromptText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      sendPromptWithContext()
                    } else if (e.key === "Escape") {
                      clearSelection()
                      setPromptText("")
                      setMode("browse")
                    }
                  }}
                  placeholder={
                    selection().length > 0
                      ? t("browser.prompt.selected")
                      : t("browser.prompt.empty")
                  }
                  spellcheck={false}
                />
                <button
                  type="button"
                  data-slot="browser-send-btn"
                  onClick={sendPromptWithContext}
                  disabled={!promptText().trim() && selection().length === 0}
                >
                  {t("agent.send")}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>

      <footer data-slot="browser-footer">
        <span data-slot="browser-fidelity">{fidelityLabel()}</span>
        <span data-slot="browser-dimensions">{dimensionsLabel()}</span>
        <Show when={sending() || sendNote()}>
          <span data-slot="browser-send-note" data-ok={sending() || sendNote()?.ok ? "true" : "false"} role="status">
            {sending() ? t("browser.send.sending") : sendNote()?.text}
          </span>
        </Show>
        <span data-slot="browser-selection-count">
          {selection().length === 0
            ? t("browser.selection.none")
            : t("browser.selection.count", selection().length)}
        </span>
      </footer>
    </article>
  )
}

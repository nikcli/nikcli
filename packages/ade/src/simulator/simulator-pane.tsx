import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { SimulatorController } from "./commands"
import {
  DEVICES,
  clampWindowSize,
  describeSimulator,
  deviceById,
  fitFrame,
  isLoadableAppUrl,
  parseAppUrl,
  type DevServerGuess,
  type SimulatorState,
} from "./simulator"
import "./simulator-pane.css"
import { t } from "../i18n"

/**
 * An app under development, running inside a device frame in the grid.
 *
 * The frame is a real viewport, not a picture: the iframe is laid out at the
 * device's CSS size — so media queries, `vh` and touch-sized layouts behave as
 * they will on the phone — and then scaled down to fit the pane. A desktop
 * window is dragged from its corner to find the width where the layout gives.
 *
 * Geometry, device list, dev server guess and URL rules are in
 * `simulator.ts`, where `bun test` can reach them.
 */

export interface SimulatorPatch {
  appUrl?: string
  appDevice?: string
  appLandscape?: boolean
  appWindow?: { width: number; height: number }
}

export interface SimulatorPaneProps {
  id: string
  title: string
  url: string
  deviceId?: string
  landscape?: boolean
  windowSize?: { width: number; height: number }
  focused?: boolean
  onChange: (patch: SimulatorPatch) => void
  /** Reads the project's config and guesses where its dev server is. */
  guessServers?: () => Promise<DevServerGuess[]>
  onController?: (controller: SimulatorController | undefined) => void
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}

/** How long a dev server has to answer before the panel calls it unreachable. */
const PROBE_TIMEOUT_MS = 2500

/**
 * Whether anything answers at `url`.
 *
 * `no-cors`, so the answer is opaque and nothing of the app is read: the only
 * question is whether the connection was accepted. A refused connection
 * rejects; an iframe would instead load the webview's own error page and fire
 * `load` as if all were well.
 */
async function probe(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function SimulatorPane(props: SimulatorPaneProps) {
  let stage: HTMLDivElement | undefined

  const [box, setBox] = createSignal({ width: 0, height: 0 })
  const [draft, setDraft] = createSignal(props.url)
  const [reachable, setReachable] = createSignal<boolean>()
  const [guesses, setGuesses] = createSignal<DevServerGuess[]>([])
  const [note, setNote] = createSignal<string>()
  /* Bumped to remount the iframe: a cross-origin frame cannot be told to reload. */
  const [loadKey, setLoadKey] = createSignal(0)
  /* A window size being dragged, before it is committed to the pane. */
  const [dragSize, setDragSize] = createSignal<{ width: number; height: number }>()
  /* The scale at the start of a drag, held until release so the corner stays under the pointer. */
  const [dragScale, setDragScale] = createSignal<number>()

  const device = createMemo(() => deviceById(props.deviceId))
  const fit = createMemo(() => {
    const computed = fitFrame({
      device: device(),
      landscape: Boolean(props.landscape),
      windowSize: dragSize() ?? props.windowSize,
      containerWidth: box().width,
      containerHeight: box().height,
    })
    const held = dragScale()
    if (held === undefined) return computed
    return {
      ...computed,
      scale: held,
      renderedWidth: Math.round(computed.outerWidth * held),
      renderedHeight: Math.round(computed.outerHeight * held),
    }
  })

  const state = (): SimulatorState => ({
    url: props.url || undefined,
    device: device(),
    landscape: Boolean(props.landscape),
    viewportWidth: fit().viewportWidth,
    viewportHeight: fit().viewportHeight,
    reachable: reachable(),
  })

  /*
   * Each load has a number, and only the latest one's probe is believed. A
   * probe of a dead port takes its whole timeout; one of a live server that
   * started after it answers first, and without this the late "no" hid an app
   * that was running.
   */
  let loads = 0
  const load = async (url: string): Promise<boolean> => {
    if (!isLoadableAppUrl(url, window.location.origin)) {
      throw new Error("questo indirizzo è ADE stessa; apri il dev server della tua app")
    }
    const mine = ++loads
    setNote(undefined)
    setDraft(url)
    if (url !== props.url) props.onChange({ appUrl: url })
    const answered = await probe(url)
    if (mine !== loads) return answered
    setReachable(answered)
    setLoadKey((key) => key + 1)
    return answered
  }

  const controller: SimulatorController = {
    state,
    open: load,
    setDevice(id) {
      props.onChange({ appDevice: id })
    },
    rotate() {
      props.onChange({ appLandscape: !props.landscape })
    },
    setWindowSize(size) {
      props.onChange({ appWindow: clampWindowSize(size.width, size.height) })
    },
    reload() {
      return props.url ? load(props.url) : Promise.resolve(false)
    },
  }

  onMount(() => {
    props.onController?.(controller)
    if (stage) {
      const observer = new ResizeObserver(([entry]) => {
        if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height })
      })
      observer.observe(stage)
      onCleanup(() => observer.disconnect())
    }
    if (props.url) void load(props.url).catch((error: unknown) => setNote(String(error instanceof Error ? error.message : error)))
    void props.guessServers?.().then(setGuesses, () => setGuesses([]))
  })
  onCleanup(() => props.onController?.(undefined))

  const submit = (text: string) => {
    const url = parseAppUrl(text)
    if (!url) {
      setNote(t("sim.badUrl"))
      return
    }
    void load(url).catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
  }

  /* Dragging a desktop window's corner; the size is committed on release. */
  const startResize = (event: PointerEvent) => {
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    const start = { x: event.clientX, y: event.clientY }
    const from = { width: fit().viewportWidth, height: fit().viewportHeight }
    const scale = fit().scale || 1
    setDragScale(scale)
    const move = (next: PointerEvent) => {
      setDragSize(
        clampWindowSize(from.width + ((next.clientX - start.x) / scale) * 2, from.height + (next.clientY - start.y) / scale),
      )
    }
    const end = () => {
      handle.removeEventListener("pointermove", move)
      const size = dragSize()
      setDragSize(undefined)
      setDragScale(undefined)
      if (size) props.onChange({ appWindow: size })
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end, { once: true })
    handle.addEventListener("pointercancel", end, { once: true })
  }

  const hostName = () => {
    try {
      return new URL(props.url).host
    } catch {
      return props.url
    }
  }

  return (
    <article
      data-component="simulator-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2">
            <rect x="4.2" y="1.5" width="7.6" height="13" rx="1.6" />
            <path d="M7 12.4h2" stroke-linecap="round" />
          </svg>
        </span>
        <h2 data-slot="pane-title" title={props.url || props.title}>
          {props.url ? `${props.title} · ${hostName()}` : props.title}
        </h2>
        <div data-slot="pane-actions">
          <button type="button" data-slot="pane-action" onClick={() => props.onExpand?.()} aria-label={t("pane.expand")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M1 4.5V1h3.5M11 7.5V11H7.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label={t("pane.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div data-slot="sim-toolbar">
        <button
          type="button"
          data-slot="sim-button"
          disabled={!props.url}
          onClick={() => void controller.reload()}
          aria-label={t("sim.reload")}
          title={t("sim.reload")}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
            <path d="M10 6a4 4 0 1 1-1.2-2.8M10 1.5v2.2H7.8" />
          </svg>
        </button>
        <input
          data-slot="sim-url"
          type="text"
          spellcheck={false}
          placeholder={t("sim.address.placeholder")}
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(event.currentTarget.value)
          }}
          aria-label={t("sim.address")}
        />
        <select
          data-slot="sim-device"
          value={device().id}
          onChange={(event) => controller.setDevice(event.currentTarget.value)}
          aria-label={t("sim.device")}
        >
          <For each={DEVICES}>{(item) => <option value={item.id}>{item.label}</option>}</For>
        </select>
        <Show when={device().kind !== "window"}>
          <button
            type="button"
            data-slot="sim-button"
            data-active={props.landscape ? "true" : undefined}
            onClick={() => controller.rotate()}
            aria-label={t("browser.rotate")}
            title={t("browser.rotate")}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
              <rect x="1.5" y="4" width="7" height="6.5" rx="1" />
              <path d="M6 1.5h2.5A2 2 0 0 1 10.5 3.5V5M9.3 3.8l1.2 1.2 1.2-1.2" stroke-linecap="round" />
            </svg>
          </button>
        </Show>
        <span data-slot="sim-size" title={describeSimulator(state())}>
          {fit().viewportWidth}×{fit().viewportHeight}
          <Show when={fit().scale > 0 && fit().scale < 1}> · {Math.round(fit().scale * 100)}%</Show>
        </span>
      </div>

      <div ref={stage} data-slot="sim-stage">
        <Show
          when={props.url}
          fallback={
            <div data-slot="sim-empty">
              <p data-slot="sim-empty-text">{t("sim.empty")}</p>
              <Show when={guesses().length > 0}>
                <ul data-slot="sim-guesses">
                  <For each={guesses()}>
                    {(guess) => (
                      <li>
                        <button type="button" data-slot="sim-guess" onClick={() => submit(guess.url)}>
                          <span data-slot="sim-guess-label">{guess.label}</span>
                          <span data-slot="sim-guess-url">{guess.url}</span>
                          <Show when={guess.command}>
                            <span data-slot="sim-guess-command">bun run {guess.command}</span>
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          }
        >
          <div
            data-slot="sim-fit"
            style={{ width: `${fit().renderedWidth}px`, height: `${fit().renderedHeight}px` }}
          >
            <div
              data-slot="sim-device-frame"
              data-kind={device().kind}
              data-cutout={device().cutout}
              data-landscape={props.landscape && device().kind !== "window" ? "true" : undefined}
              style={{
                width: `${fit().outerWidth}px`,
                height: `${fit().outerHeight}px`,
                padding: `${device().bezel}px`,
                "border-radius": `${device().radius + device().bezel}px`,
                transform: `scale(${fit().scale})`,
              }}
            >
              <Show when={device().kind === "window"}>
                <div data-slot="sim-titlebar">
                  <span data-slot="sim-traffic" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span data-slot="sim-titlebar-text">{hostName()}</span>
                </div>
              </Show>
              <div
                data-slot="sim-screen"
                style={{
                  width: `${fit().screenWidth}px`,
                  height: `${fit().screenHeight}px`,
                  "border-radius": device().kind === "window" ? "0" : `${device().radius}px`,
                }}
              >
                <Show when={fit().statusBar > 0}>
                  <div data-slot="sim-statusbar" style={{ height: `${fit().statusBar}px` }}>
                    <span data-slot="sim-clock">9:41</span>
                    <span data-slot="sim-cutout" aria-hidden="true" />
                    <span data-slot="sim-indicators" aria-hidden="true">
                      <svg viewBox="0 0 18 10" width="18" height="10" fill="currentColor">
                        <rect x="0" y="6" width="3" height="4" rx="0.6" />
                        <rect x="5" y="4" width="3" height="6" rx="0.6" />
                        <rect x="10" y="2" width="3" height="8" rx="0.6" />
                        <rect x="15" y="0" width="3" height="10" rx="0.6" />
                      </svg>
                      <svg viewBox="0 0 24 11" width="24" height="11" fill="none" stroke="currentColor">
                        <rect x="0.5" y="0.5" width="20" height="10" rx="2.5" />
                        <rect x="2" y="2" width="15" height="7" rx="1.4" fill="currentColor" stroke="none" />
                        <path d="M22.5 4v3" stroke-linecap="round" />
                      </svg>
                    </span>
                  </div>
                </Show>
                {/*
                  Remounted on every load: a frame on another origin cannot be
                  told to reload, and rewriting `src` with the same string is
                  not a navigation at all.
                */}
                <Show when={reachable() !== false && loadKey()} keyed>
                  {(_key) => (
                    <iframe
                      data-slot="sim-frame"
                      src={props.url}
                      title={`App: ${props.url}`}
                      style={{ width: `${fit().viewportWidth}px`, height: `${fit().viewportHeight}px` }}
                      /*
                       * Same-origin allowed so the app keeps its storage,
                       * cookies and service worker; `isLoadableAppUrl` refuses
                       * ADE's own origin, which is what makes that safe.
                       */
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                      allow="clipboard-write"
                    />
                  )}
                </Show>
                <Show when={device().kind === "phone" && !props.landscape}>
                  <span data-slot="sim-home" aria-hidden="true" />
                </Show>
              </div>
              <Show when={device().kind === "window"}>
                <span
                  data-slot="sim-resize"
                  onPointerDown={startResize}
                  aria-label={t("sim.resize")}
                  title={t("sim.resize.tip")}
                />
              </Show>
            </div>
          </div>

          <Show when={reachable() === false}>
            <div data-slot="sim-overlay" role="alert">
              <strong>{t("sim.unreachable", props.url ?? "")}</strong>
              <span>{t("sim.unreachable.hint")}</span>
              <Show when={guesses().some((guess) => guess.url !== props.url)}>
                <span data-slot="sim-overlay-guesses">
                  {t("sim.or")}{" "}
                  <For each={guesses().filter((guess) => guess.url !== props.url)}>
                    {(guess) => (
                      <button type="button" data-slot="sim-link" onClick={() => submit(guess.url)}>
                        {guess.label} ({guess.url})
                      </button>
                    )}
                  </For>
                </span>
              </Show>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={note()}>
        {(text) => (
          <p data-slot="sim-note" role="status">
            {text()}
          </p>
        )}
      </Show>
    </article>
  )
}

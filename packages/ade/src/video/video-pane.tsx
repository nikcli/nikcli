import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { dragCarriesPaths, readDraggedPaths } from "../sidebar/file-drag"
import {
  clampSeek,
  formatTimecode,
  frameFileName,
  isPlayable,
  mediaUrl,
  MAX_RATE,
  MIN_RATE,
  PLAYABLE_EXTENSIONS,
  type VideoState,
} from "./video"
import type { VideoController } from "./commands"
import { FolderGlyph, PaneActions } from "../grid/pane-actions"
import "./video-pane.css"
import { t } from "../i18n"

/**
 * A video, in the grid, wearing the same chrome as everything else — and
 * driveable by the agent that made the video.
 *
 * The point of the panel is the second half. What a session just built can be
 * watched next to it, and the agent can watch too: `commands.ts` turns a line
 * an agent writes on its own stdout into a call on the controller this
 * component hands out, and every reply is built from what the element
 * actually did. So the component's job is to be an honest controller — never
 * to report a seek it did not make, never to say "in riproduzione" of an
 * element a webview refused to start.
 *
 * All the arithmetic and the wording live in `video.ts`, because a `.tsx`
 * cannot be imported under `bun test` in this repo and an off-by-one in a
 * timecode is invisible in a screenshot.
 */

export interface VideoPaneProps {
  id: string
  title: string
  /** The file being played, empty when the panel is waiting for one. */
  path: string
  focused?: boolean
  /** Records the chosen file on the pane, so it survives a re-render. */
  onOpen: (path: string) => void
  /**
   * Where a captured frame is written. Absent in the browser harness, and
   * then capture reports that it cannot rather than appearing to work.
   */
  onCapture?: (name: string, png: Uint8Array) => Promise<string>
  /** Opens a native file picker, when the host has one. */
  onPick?: () => Promise<string | undefined>
  /**
   * Hands the controller to the workbench, which routes agent commands to it.
   * Called again with `undefined` when the pane goes away.
   */
  onController?: (controller: VideoController | undefined) => void
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}

export function VideoPane(props: VideoPaneProps) {
  let element: HTMLVideoElement | undefined

  /*
   * The state is mirrored into signals rather than read off the element.
   *
   * Two reasons, and the second is the one that matters: a signal is what the
   * header can redraw from, and `state()` has to be answerable synchronously
   * from a command handler — `controller.state()` is called immediately after
   * an `await`ed action, and reading `element.currentTime` there is right
   * only because the events below have already run.
   */
  const [playing, setPlaying] = createSignal(false)
  const [position, setPosition] = createSignal(0)
  const [duration, setDuration] = createSignal(0)
  const [rate, setRate] = createSignal(1)
  const [note, setNote] = createSignal<string>()

  const state = (): VideoState => ({
    source: props.path || undefined,
    playing: playing(),
    position: position(),
    duration: duration(),
    rate: rate(),
  })

  /** Waits for the element to actually reach the frame that was asked for. */
  const seekTo = (seconds: number): Promise<number> =>
    new Promise((resolve) => {
      const video = element
      if (!video) return resolve(position())
      const done = () => {
        video.removeEventListener("seeked", done)
        setPosition(video.currentTime)
        resolve(video.currentTime)
      }
      video.addEventListener("seeked", done)
      video.currentTime = seconds
      /*
       * A seek to where the element already is fires no `seeked` at all, and
       * the command would never answer. Resolving on the next frame in that
       * case is not a guess: the position is already correct.
       */
      if (Math.abs(video.currentTime - seconds) < 0.001) queueMicrotask(done)
    })

  /** Draws the current frame and hands back the PNG bytes. */
  const frameBytes = (): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      const video = element
      if (!video || !video.videoWidth) return reject(new Error("nessun fotogramma disponibile"))
      const canvas = document.createElement("canvas")
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext("2d")
      if (!context) return reject(new Error("canvas non disponibile"))
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error("codifica del fotogramma fallita"))
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
      }, "image/png")
    })

  const controller: VideoController = {
    state,
    async open(path) {
      if (!isPlayable(path)) {
        throw new Error(`formato non riproducibile; supportati: ${PLAYABLE_EXTENSIONS.join(", ")}`)
      }
      setNote(undefined)
      props.onOpen(path)
      /*
       * Waited for, not assumed. `open` resolves once the element has enough
       * of the file to answer questions about it; resolving earlier would let
       * the agent's next command ask the duration of a video with none.
       */
      await new Promise<void>((resolve, reject) => {
        // Re-read on the next tick: `onOpen` sets the prop, and the `src`
        // below is bound to it.
        queueMicrotask(() => {
          const video = element
          if (!video) return resolve()
          const ready = () => {
            cleanup()
            resolve()
          }
          const failed = () => {
            cleanup()
            reject(new Error("il file non è leggibile o il formato non è supportato"))
          }
          const cleanup = () => {
            video.removeEventListener("loadedmetadata", ready)
            video.removeEventListener("error", failed)
          }
          video.addEventListener("loadedmetadata", ready)
          video.addEventListener("error", failed)
        })
      })
      return path
    },
    async play() {
      const video = element
      if (!video) throw new Error("nessun riproduttore")
      // Rethrown rather than swallowed: a webview refuses to play without a
      // gesture from the user, and it refuses by rejecting. Reported as a
      // success, the agent would capture frames that never move.
      await video.play()
    },
    pause() {
      element?.pause()
    },
    seek: seekTo,
    setRate(next) {
      if (!element) return
      element.playbackRate = next
      setRate(next)
    },
    async capture() {
      if (!props.onCapture) throw new Error("questo host non può scrivere file")
      const bytes = await frameBytes()
      return props.onCapture(frameFileName(props.path, position()), bytes)
    },
  }

  // Synchronously, not after an await: an `onCleanup` registered later has a
  // null owner and is a silent no-op.
  onMount(() => props.onController?.(controller))
  onCleanup(() => props.onController?.(undefined))

  const pick = async () => {
    const chosen = await props.onPick?.()
    if (!chosen) return
    if (!isPlayable(chosen)) {
      setNote(t("video.unplayable", PLAYABLE_EXTENSIONS.join(", ")))
      return
    }
    setNote(undefined)
    props.onOpen(chosen)
  }

  const captureNow = async () => {
    try {
      const written = await controller.capture()
      // Said out loud, because a capture that lands somewhere the user cannot
      // guess is the same as no capture.
      setNote(t("video.captured", written))
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <article
      data-component="video-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
      onDragOver={(event) => {
        const data = event.dataTransfer
        if (!data || !dragCarriesPaths(data)) return
        event.preventDefault()
        data.dropEffect = "copy"
      }}
      onDrop={(event) => {
        const data = event.dataTransfer
        if (!data) return
        const paths = readDraggedPaths(data)
        const playable = paths.find(isPlayable)
        if (!playable) return
        event.preventDefault()
        setNote(undefined)
        props.onOpen(playable)
      }}
    >
      <header class="pill hA" data-slot="pane-header">
        <span class="logo" data-slot="pane-identity" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
            <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
            <path d="M6.5 6.5l4 2.5-4 2.5z" />
          </svg>
        </span>
        <h2 class="nm" data-slot="pane-title" title={props.path || props.title}>
          {props.path ? (props.path.split(/[\\/]/).pop() ?? props.title) : props.title}
        </h2>
        <span data-slot="video-header-gap" />
        <PaneActions onExpand={() => props.onExpand?.()} onClose={() => props.onClose?.()}>
          {/* Only once a video is open: an empty pane already offers the choice in the middle. */}
          <Show when={props.onPick && props.path}>
            <button type="button" class="act" data-slot="pane-action" onClick={() => void pick()} aria-label={t("media.pick")} title={t("media.pick")}>
              <FolderGlyph />
            </button>
          </Show>
        </PaneActions>
      </header>

      <div data-slot="video-stage">
        <Show
          when={props.path}
          fallback={
            <div data-slot="video-empty">
              <p data-slot="video-empty-text">
                {t("video.empty")}
                <br />
                <span data-slot="video-empty-formats">{PLAYABLE_EXTENSIONS.join(" · ")}</span>
              </p>
              <Show when={props.onPick}>
                <button type="button" data-slot="video-open" onClick={() => void pick()}>
                  {t("media.pick")}
                </button>
              </Show>
            </div>
          }
        >
          <video
            ref={element}
            data-slot="video-element"
            src={mediaUrl(props.path)}
            /*
             * No `controls`: the panel's own row is the one the agent drives,
             * and two sets of controls that can disagree about the rate is a
             * way for the interface to contradict the reply the agent got.
             */
            playsinline
            preload="metadata"
            onLoadedMetadata={(event) => {
              setDuration(event.currentTarget.duration)
              setPosition(event.currentTarget.currentTime)
              setRate(event.currentTarget.playbackRate)
              setNote(undefined)
            }}
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
            onError={() => setNote(t("video.unreadable"))}
          />
        </Show>
      </div>

      <Show when={props.path}>
        <div data-slot="video-controls">
          <button
            type="button"
            data-slot="video-button"
            onClick={() => {
              if (playing()) return controller.pause()
              void controller.play().catch((error: unknown) => {
                setNote(error instanceof Error ? error.message : String(error))
              })
            }}
            aria-label={playing() ? "Metti in pausa" : "Riproduci"}
          >
            <Show
              when={playing()}
              fallback={
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path d="M3 2l7 4-7 4z" fill="currentColor" />
                </svg>
              }
            >
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path d="M3.5 2h2v8h-2zM6.5 2h2v8h-2z" fill="currentColor" />
              </svg>
            </Show>
          </button>

          <input
            type="range"
            data-slot="video-seek"
            min={0}
            max={Number.isFinite(duration()) && duration() > 0 ? duration() : 0}
            step={0.1}
            value={position()}
            onInput={(event) => {
              void seekTo(clampSeek(Number(event.currentTarget.value), duration()))
            }}
            aria-label={t("video.position")}
          />

          <span data-slot="video-time">
            {formatTimecode(position())} / {formatTimecode(duration())}
          </span>

          <label data-slot="video-rate">
            <span data-slot="video-rate-label">{t("video.speed")}</span>
            <select
              value={String(rate())}
              onChange={(event) => controller.setRate(Number(event.currentTarget.value))}
              aria-label={t("video.speed.label")}
            >
              {[MIN_RATE, 0.5, 1, 1.5, 2, MAX_RATE].map((value) => (
                <option value={String(value)}>{value}×</option>
              ))}
            </select>
          </label>

          <Show when={props.onCapture}>
            <button type="button" data-slot="video-button" onClick={() => void captureNow()} aria-label={t("video.capture")}>
              <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="1" y="3" width="10" height="7" rx="1" />
                <circle cx="6" cy="6.5" r="2" />
              </svg>
            </button>
          </Show>
        </div>
      </Show>

      <Show when={note()}>
        {(text) => (
          <p data-slot="video-note" role="status">
            {text()}
          </p>
        )}
      </Show>
    </article>
  )
}

import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import "./tray.css"
import { t } from "../i18n"

/**
 * The screenshots you just took, waiting to be handed to an agent.
 *
 * Bottom left, over the grid rather than beside it: a strip that pushed the
 * terminals aside would cost every session a slice of width for something that
 * is empty most of the time. It sits in the corner the sidebar already occupies,
 * where nothing is ever drawn, and folds away to a single word when unwanted.
 *
 * A thumbnail is dragged onto the session that should see it. Dropping writes
 * the path into that terminal and stops — no newline — because which agent gets
 * the picture and what to ask about it are two different decisions, and only the
 * first one is made by the drag.
 */

export interface Shot {
  path: string
  name: string
  modified_ms: number
}

export interface ShotTrayProps {
  shots: Shot[]
  /** Loads the image bytes for a thumbnail. Absent in the browser harness. */
  load?: (path: string) => Promise<Uint8Array | null>
  /** Takes a shot out of the tray without touching the file. */
  onDismiss: (path: string) => void
  /** Removes the file from disk. */
  onDelete?: (path: string) => void
}

/** A thumbnail, loaded once and revoked when it leaves the tray. */
function Thumb(props: { shot: Shot; load?: ShotTrayProps["load"] }) {
  const [url, setUrl] = createSignal<string>()

  onMount(() => {
    let revoked = false
    /*
     * The URL is held in a variable and revoked by a cleanup registered
     * *synchronously*, not by one registered after the await.
     *
     * Solid's owner is only current during the synchronous part of a
     * reactive scope; after an await it is null, and `onCleanup` in that
     * state is a silent no-op — it neither runs nor warns. So the
     * `revokeObjectURL` below the await was never called, and every
     * thumbnail leaked its blob: several megabytes each for a 4K screenshot,
     * held for the lifetime of the window.
     */
    let objectUrl: string | undefined

    void (async () => {
      const bytes = await props.load?.(props.shot.path).catch(() => null)
      if (!bytes || revoked) return
      /*
       * A blob URL rather than a base64 data URL. A screenshot of a 4K display
       * is several megabytes, and base64 makes it a third larger again — as a
       * string, held in the DOM, for every thumbnail on screen.
       */
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }))
      setUrl(objectUrl)
    })()

    onCleanup(() => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    })
  })

  return (
    <Show when={url()} fallback={<span data-slot="shot-loading" aria-hidden="true" />}>
      {(src) => <img data-slot="shot-image" src={src()} alt={props.shot.name} draggable={false} />}
    </Show>
  )
}

export function ShotTray(props: ShotTrayProps) {
  const [collapsed, setCollapsed] = createSignal(false)
  const [opened, setOpened] = createSignal<Shot>()

  return (
    <Show when={props.shots.length > 0}>
      <aside
        data-component="shot-tray"
        data-collapsed={collapsed() ? "true" : undefined}
        aria-label={`Schermate recenti (${props.shots.length})`}
      >
        {/*
         * No heading, and nothing to collapse.
         *
         * The tray lives in a strip at the bottom of the sidebar that is
         * reserved for it, so a title was a name for something you recognise
         * by looking at it, and a collapse control was a way to empty a space
         * nothing else can use. The count is in the accessible name, where it
         * is still available to anyone who cannot see the thumbnails.
         */}
        <Show when={!collapsed()}>
          <div data-slot="shot-tray-strip">
            <For each={props.shots}>
              {(shot) => (
                /*
                 * The tile is the drag handle and the open button at once.
                 *
                 * It used to wrap a <button> around the thumbnail, and in
                 * Chromium a button swallows the press that would have started
                 * the drag: `draggable` on the ancestor is simply never
                 * honoured, so the thumbnails looked draggable and were not.
                 * The tile carries the role instead, and the only real button
                 * left inside it is the dismiss, which is meant to be pressed.
                 */
                <figure
                  data-slot="shot"
                  title={shot.name}
                  draggable={true}
                  role="button"
                  tabindex={0}
                  aria-label={`Apri ${shot.name}`}
                  onClick={() => setOpened(shot)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    setOpened(shot)
                  }}
                  onDragStart={(event) => {
                    /*
                     * The path travels as plain text so any drop target that
                     * accepts text — a pane, the composer, a field ADE does not
                     * own yet — receives something it can use, rather than a
                     * private format only this tray understands.
                     */
                    event.dataTransfer?.setData("text/plain", shot.path)
                    event.dataTransfer?.setData("application/x-ade-shot", shot.path)
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
                  }}
                >
                  <Thumb shot={shot} load={props.load} />
                  <button
                    type="button"
                    data-slot="shot-dismiss"
                    onClick={(event) => {
                      // Or the tile behind it opens the picture being put away.
                      event.stopPropagation()
                      props.onDismiss(shot.path)
                    }}
                    aria-label={t("shots.dismiss.named", shot.name)}
                    title={t("shots.dismiss")}
                  >
                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                      <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                    </svg>
                  </button>
                </figure>
              )}
            </For>
          </div>
        </Show>
      </aside>

      {/* Opened at full size, over everything, closed by anything: the picture
          is being looked at for a second, not worked in. */}
      <Show when={opened()}>
        {(shot) => (
          <div
            data-component="shot-viewer"
            role="dialog"
            aria-label={shot().name}
            onClick={() => setOpened(undefined)}
          >
            <figure data-slot="shot-viewer-frame" onClick={(event) => event.stopPropagation()}>
              <Thumb shot={shot()} load={props.load} />
              <figcaption data-slot="shot-viewer-caption">
                <span data-slot="shot-viewer-name">{shot().name}</span>
                <span data-slot="shot-viewer-hint">{t("shots.hint")}</span>
                {/* Deleting is offered here and not on the thumbnail: the × in
                    the tray puts a screenshot away, and a click that throws the
                    file off the disk must not sit a few pixels from one that
                    does not. */}
                <Show when={props.onDelete}>
                  <button
                    type="button"
                    data-slot="shot-viewer-close"
                    data-tone="danger"
                    onClick={() => {
                      props.onDelete?.(shot().path)
                      setOpened(undefined)
                    }}
                  >
                    {t("shots.delete")}
                  </button>
                </Show>
                <button type="button" data-slot="shot-viewer-close" onClick={() => setOpened(undefined)}>
                  {t("shots.close")}
                </button>
              </figcaption>
            </figure>
          </div>
        )}
      </Show>
    </Show>
  )
}

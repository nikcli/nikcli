import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { every } from "../host/every"
import type { DirEntry } from "../host/shell"
import { dragCarriesPaths, readDraggedPaths } from "../sidebar/file-drag"
import type { ModelController } from "./commands"
import {
  changeStamp,
  decideReload,
  filesToStamp,
  isSuperseded,
  sameFiles,
  describeModelState,
  directoryOf,
  isModel,
  MAX_MODEL_BYTES,
  MODEL_EXTENSIONS,
  viewFileName,
  WATCH_INTERVAL_MS,
  type ModelState,
  type ModelStats,
  type ViewPreset,
} from "./model"
import type { ModelViewer } from "./viewer"
import "./model-pane.css"
import { locale, t } from "../i18n"

/**
 * A 3D model, in the grid, with the same chrome as every other pane.
 *
 * Orbit with the left button, pan with the right, zoom with the wheel. The
 * file is watched while it is on screen, so an asset being exported or a mesh
 * an agent is regenerating shows up changed without anyone reopening it.
 *
 * The scene itself is `viewer.ts`, loaded with `import()` the first time a
 * model is shown; the decisions about files, reloads and wording are in
 * `model.ts`, where `bun test` can reach them.
 */

export interface ModelPaneProps {
  id: string
  title: string
  /** The model being shown, empty when the panel is waiting for one. */
  path: string
  focused?: boolean
  onOpen: (path: string) => void
  onPick?: () => Promise<string | undefined>
  readBytes?: (path: string, maxBytes: number) => Promise<Uint8Array>
  readDir?: (path: string) => Promise<DirEntry[]>
  onCapture?: (name: string, png: Uint8Array) => Promise<string>
  onController?: (controller: ModelController | undefined) => void
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}

const VIEW_BUTTONS: { preset: ViewPreset; readonly label: string }[] = [
  { preset: "iso", label: "Iso" },
  {
    preset: "front",
    get label() {
      return t("model.view.front")
    },
  },
  {
    preset: "right",
    get label() {
      return t("model.view.side")
    },
  },
  {
    preset: "top",
    get label() {
      return t("model.view.top")
    },
  },
]

export function ModelPane(props: ModelPaneProps) {
  let stage: HTMLDivElement | undefined
  let viewer: ModelViewer | undefined
  let viewerPromise: Promise<ModelViewer> | undefined
  let disposed = false

  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [stats, setStats] = createSignal<ModelStats>()
  const [note, setNote] = createSignal<string>()

  /* What is on screen, for the watcher: the files it came from and their stamp. */
  let watched: readonly string[] = []
  let loadedStamp = ""
  let pendingStamp: string | undefined
  /*
   * Only the latest load reaches the scene. Two can overlap — an agent opens
   * a file while the watcher reloads another — and the one that finishes
   * last is not always the one that started last.
   */
  let generation = 0
  /* The file the camera was last framed on; a reload of it keeps the view. */
  let framed = ""

  const state = (): ModelState => ({
    source: props.path || undefined,
    loading: loading(),
    error: error(),
    stats: stats(),
  })

  const ensureViewer = (): Promise<ModelViewer> => {
    if (viewer) return Promise.resolve(viewer)
    if (!viewerPromise) {
      viewerPromise = import("./viewer").then((module) => {
        if (disposed || !stage) throw new Error("pannello chiuso")
        viewer = module.createModelViewer(stage, (reason) => setError(reason))
        return viewer
      })
      // A failed import must not be cached: the next open tries again.
      viewerPromise.catch(() => (viewerPromise = undefined))
    }
    return viewerPromise
  }

  const stampNow = async (files: readonly string[]): Promise<string> => {
    if (!props.readDir || files.length === 0) return ""
    const directories = [...new Set(files.map(directoryOf))]
    const listings = await Promise.all(directories.map((dir) => props.readDir!(dir).catch(() => [] as DirEntry[])))
    return changeStamp(listings.flat(), files)
  }

  let currentLoad: Promise<void> = Promise.resolve()
  const load = (path: string): Promise<void> => (currentLoad = loadNow(path))

  const loadNow = async (path: string) => {
    const mine = ++generation
    if (!props.readBytes) {
      setError(t("media.noBinary"))
      return
    }
    const read = props.readBytes
    setLoading(true)
    setError(undefined)
    /*
     * Stamped before the read, not after: a save that lands while the file is
     * being parsed must look like a change on the next poll. Stamped after,
     * it matched what was on disk by then and the pane stayed on the old
     * model, or on the error from the half-written one.
     */
    const expected = filesToStamp(path, framed, watched)
    const before = await stampNow(expected)
    try {
      const scene = await ensureViewer()
      const result = await scene.load(
        path,
        (file) => read(file, MAX_MODEL_BYTES),
        path !== framed,
        () => mine === generation,
      )
      if (mine !== generation) return
      framed = path
      setStats(result.stats)
      setNote(result.missing.length > 0 ? t("model.missing", result.missing.join(", ")) : undefined)
      watched = result.files
      // Files first seen in this load have no earlier stamp; one poll re-reads them.
      loadedStamp = sameFiles(expected, watched) ? before : ""
      pendingStamp = undefined
    } catch (failure) {
      if (mine !== generation || isSuperseded(failure)) return
      setStats(undefined)
      setError(failure instanceof Error ? failure.message : String(failure))
      // Watched anyway: a file that failed to parse halfway through an export
      // is exactly the one that will be fixed by the next save.
      watched = [path]
      loadedStamp = before
      pendingStamp = undefined
    } finally {
      if (mine === generation) setLoading(false)
    }
  }

  createEffect(
    on(
      () => props.path,
      (path) => {
        if (path) void load(path)
      },
    ),
  )

  const controller: ModelController = {
    state,
    async open(path) {
      if (!isModel(path)) throw new Error(`formato non supportato; supportati: ${MODEL_EXTENSIONS.join(", ")}`)
      if (path === props.path) return load(path)
      // The effect on `props.path` starts the load when the prop changes;
      // this waits for that load rather than starting a second one.
      props.onOpen(path)
      await Promise.resolve()
      await currentLoad
    },
    reload() {
      return props.path ? load(props.path) : Promise.resolve()
    },
    view(preset) {
      viewer?.view(preset)
    },
    async capture() {
      if (!props.onCapture) throw new Error("questo host non può scrivere file")
      if (!viewer) throw new Error("nessun modello caricato")
      const png = await viewer.capture()
      return props.onCapture(viewFileName(props.path, new Date()), png)
    },
  }

  onMount(() => {
    props.onController?.(controller)

    /*
     * Polled, and only while the window is visible: `every` pauses while the
     * page is hidden. One listing per directory the model came from, which is
     * a handful of stats — cheaper than a native watcher that would have to
     * be started, stopped and kept in step with the panel's file.
     */
    const stopWatch = every(WATCH_INTERVAL_MS, async () => {
      if (!props.path || loading() || watched.length === 0) return
      const next = await stampNow(watched)
      const decision = decideReload(loadedStamp, pendingStamp, next)
      pendingStamp = decision.pending
      if (decision.reload) await load(props.path)
    })

    /* The stage's colours are the theme's; a switch repaints the scene. */
    const themeObserver = new MutationObserver(() => viewer?.syncTheme())
    themeObserver.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-theme"],
    })
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)")
    const onScheme = () => viewer?.syncTheme()
    scheme?.addEventListener("change", onScheme)

    onCleanup(() => {
      stopWatch()
      themeObserver.disconnect()
      scheme?.removeEventListener("change", onScheme)
    })
  })

  onCleanup(() => {
    disposed = true
    generation++
    props.onController?.(undefined)
    viewer?.dispose()
    viewer = undefined
  })

  const pick = async () => {
    const chosen = await props.onPick?.()
    if (!chosen) return
    if (!isModel(chosen)) {
      setNote(t("media.unsupported", MODEL_EXTENSIONS.join(", ")))
      return
    }
    props.onOpen(chosen)
  }

  const captureNow = async () => {
    try {
      setNote(t("model.captured", await controller.capture()))
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : String(failure))
    }
  }

  return (
    <article
      data-component="model-pane"
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
        const model = readDraggedPaths(data).find(isModel)
        if (!model) return
        event.preventDefault()
        props.onOpen(model)
      }}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
          >
            <path d="M8 1.8l5.6 3.1v6.2L8 14.2l-5.6-3.1V4.9z" />
            <path d="M2.4 4.9L8 8l5.6-3.1M8 8v6.2" />
          </svg>
        </span>
        <h2 data-slot="pane-title" title={props.path || props.title}>
          {props.path ? (props.path.split(/[\\/]/).pop() ?? props.title) : props.title}
        </h2>
        <div data-slot="pane-actions">
          <button
            type="button"
            data-slot="pane-action"
            onClick={() => props.onExpand?.()}
            aria-label={t("pane.expand")}
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
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label={t("pane.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path
                d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      {/* The stage is always in the DOM: the viewer attaches its canvas to it. */}
      <div ref={stage} data-slot="model-stage" data-empty={props.path ? undefined : "true"}>
        <Show when={!props.path}>
          <div data-slot="model-empty">
            <p data-slot="model-empty-text">
              {t("model.empty")}
              <br />
              <span data-slot="model-empty-formats">{MODEL_EXTENSIONS.join(" · ")}</span>
            </p>
            <Show when={props.onPick}>
              <button type="button" data-slot="model-open" onClick={() => void pick()}>
                {t("media.pick")}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={props.path && loading()}>
          <div data-slot="model-overlay" role="status">
            {t("media.loading")}
          </div>
        </Show>
        <Show when={props.path && !loading() && error()}>
          {(text) => (
            <div data-slot="model-overlay" data-tone="error" role="alert">
              {text()}
            </div>
          )}
        </Show>
      </div>

      <Show when={props.path}>
        <div data-slot="model-controls">
          <For each={VIEW_BUTTONS}>
            {(item) => (
              <button
                type="button"
                data-slot="model-button"
                disabled={!stats()}
                onClick={() => controller.view(item.preset)}
              >
                {item.label}
              </button>
            )}
          </For>
          <span data-slot="model-stats" title={describeModelState(state())}>
            {stats()
              ? t("model.triangles", stats()!.triangles.toLocaleString(locale() === "en" ? "en-US" : "it-IT"))
              : ""}
          </span>
          <button
            type="button"
            data-slot="model-button"
            onClick={() => void controller.reload()}
            aria-label={t("model.reload")}
            title={t("model.reload")}
          >
            <svg
              viewBox="0 0 12 12"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            >
              <path d="M10 6a4 4 0 1 1-1.2-2.8M10 1.5v2.2H7.8" />
            </svg>
          </button>
          <Show when={props.onCapture}>
            <button
              type="button"
              data-slot="model-button"
              disabled={!stats()}
              onClick={() => void captureNow()}
              aria-label={t("model.capture")}
              title={t("model.capture")}
            >
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
          <p data-slot="model-note" role="status">
            {text()}
          </p>
        )}
      </Show>
    </article>
  )
}

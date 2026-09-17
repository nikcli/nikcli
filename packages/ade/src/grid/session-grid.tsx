import { For, type JSX, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  type Direction,
  type DropZone,
  type Span,
  cellsWanted,
  spanInGrid,
  dropZone,
  effectiveSpan,
  moveTile,
  neighbour,
  packTiles,
  swapTiles,
} from "./arrange"
import { isDragHandle } from "./drag-handle"
import { focusAfterClose, moveFocus } from "./focus"
import { GRID_GAP, MIN_PANE_HEIGHT, gridColumns } from "./layout"
import { t } from "../i18n"

export interface GridPane {
  id: string
  /** Anything the pane should render as its body. */
  render: () => JSX.Element
}

/** What the grid needs to know about a tile to size it. Read reactively. */
export interface GridTile {
  span?: Span
}

export interface SessionGridProps {
  panes: GridPane[]
  focused: string | undefined
  onFocus: (id: string) => void
  onClose?: (id: string, nextFocus: string | undefined) => void
  /** User-chosen column count. Undefined lets the layout decide. */
  columns?: number
  /** The size the user chose for a tile. Without it every tile is one cell. */
  tileOf?: (id: string) => GridTile | undefined
  /** The visible panes in their new order, after a drag or a keyboard move. */
  onMove?: (order: string[]) => void
  /** A tile's new size, or `undefined` to give it back its default. */
  onResize?: (id: string, span: Span | undefined) => void
}

const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
}

/** How far the pointer must travel before a press on a header becomes a drag. */
const DRAG_THRESHOLD = 6

/** The word the overlay shows for the zone the pointer is over. */
const ZONE_LABELS: Record<DropZone, string> = {
  before: "Prima",
  after: "Dopo",
  above: "Sopra",
  below: "Sotto",
  swap: "Scambia",
}

/**
 * The tiled grid of live agent sessions.
 *
 * Everything about *where* panes go lives in `./layout` and `./arrange`, and
 * everything about which one is focused lives in `./focus`. What is left here
 * is measurement and wiring — deliberately, because the extracted parts are
 * where the bugs are and none of them needs a DOM to be tested.
 */
export function SessionGrid(props: SessionGridProps) {
  let container!: HTMLDivElement
  const [box, setBox] = createSignal({ width: 0, height: 0 })

  onMount(() => {
    // The column count is a function of the container, so it has to be measured
    // rather than assumed: this grid sits next to a sidebar and a panel that the
    // user drags, and a window resize is not the only thing that changes it.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const rect = entry.contentRect
      setBox({ width: rect.width, height: rect.height })
    })
    observer.observe(container)
    onCleanup(() => observer.disconnect())
  })

  /** A size being dragged, shown before it is committed. */
  const [resizing, setResizing] = createSignal<{ id: string; span: Span } | undefined>()

  const tile = (id: string): GridTile => {
    const live = resizing()
    const base = spanInGrid(props.tileOf?.(id) ?? {}, props.panes.length)
    return live?.id === id ? { ...base, span: live.span } : base
  }

  const columns = createMemo(() =>
    gridColumns({
      count: cellsWanted(props.panes.map((pane) => tile(pane.id))),
      width: box().width,
      height: box().height,
      pinned: props.columns,
    }),
  )

  const spans = createMemo(() => props.panes.map((pane) => effectiveSpan(tile(pane.id), columns())))
  const layout = createMemo(() => packTiles(spans(), columns()))
  const indexOf = createMemo(() => new Map(props.panes.map((pane, index) => [pane.id, index])))

  /*
   * The cells are drawn in the order panes first appeared, never re-sorted.
   *
   * Reordering the DOM is how a drag would naturally be drawn, and it is the
   * wrong way here: moving a node that holds a browser pane's frame reloads
   * the page, and moving a terminal's host costs it a re-measure mid-stream.
   * Every cell is placed by `grid-row` and `grid-column` instead, so a drag
   * changes two style attributes and nothing is reparented.
   */
  let seen: GridPane[] = []
  const stable = createMemo(() => {
    const present = new Set(props.panes.map((pane) => pane.id))
    const kept = seen.filter((pane) => present.has(pane.id))
    const known = new Set(kept.map((pane) => pane.id))
    seen = [...kept, ...props.panes.filter((pane) => !known.has(pane.id))]
    return seen
  })

  const focusedIndex = createMemo(() => props.panes.findIndex((pane) => pane.id === props.focused))

  /*
   * `close` used to be declared here and never called: the grid does not draw
   * the close control, the pane does, and the pane calls the workbench
   * directly. Removed rather than left as a helper nobody reaches — dead code
   * next to live code reads as a code path, and someone will eventually
   * reason about the system as though this one ran.
   */

  const onKeyDown = (event: KeyboardEvent) => {
    const direction = ARROWS[event.key]
    // Only with a modifier: the arrows belong to whatever has focus inside the
    // pane — a prompt, a scrolled transcript — and stealing them would make the
    // composer unusable.
    if (!direction || !event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return
    const index = focusedIndex()
    if (index === -1) return
    const next = neighbour(layout().placements, index, direction)
    const pane = props.panes[next]
    if (next === -1 || !pane) return
    event.preventDefault()
    props.onFocus(pane.id)
  }

  /*
   * Alt+Shift+Arrow carries the focused pane with it: the same move a drag
   * onto the neighbour's middle makes, so the mouse is never the only way to
   * arrange the grid.
   *
   * Caught on the way down, not on the way up. By the time a keydown bubbles
   * out of a terminal, xterm has already written the escape sequence to the
   * shell, and an editor has already extended its selection: the panes swapped
   * and the prompt received garbage. The chord is the grid's whether or not a
   * neighbour exists, so it is swallowed at the edge too rather than leaking
   * into the pane once there is nowhere left to move.
   */
  const onMoveKey = (event: KeyboardEvent) => {
    const direction = ARROWS[event.key]
    if (!direction || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || !props.onMove) return
    event.preventDefault()
    event.stopPropagation()
    const index = focusedIndex()
    const current = props.panes[index]
    const pane = props.panes[neighbour(layout().placements, index, direction)]
    if (!current || !pane) return
    props.onMove(swapTiles(props.panes.map((p) => p.id), current.id, pane.id))
  }

  onMount(() => {
    container.addEventListener("keydown", onMoveKey, true)
    onCleanup(() => container.removeEventListener("keydown", onMoveKey, true))
  })

  /* ---------------------------------------------------------------- drag */

  const [dragging, setDragging] = createSignal<string | undefined>()
  const [drop, setDrop] = createSignal<{ target: string; zone: DropZone } | undefined>()

  const cellAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-slot="grid-cell"]') ?? undefined

  const startDrag = (id: string, event: PointerEvent) => {
    if (!props.onMove || event.button !== 0 || props.panes.length < 2) return
    const target = event.target as Element | null
    if (!isDragHandle(target)) return
    // A title being renamed is an input, excluded above; one being read is a
    // handle, and its double click still reaches it because nothing is
    // prevented until the pointer has actually travelled.
    const startX = event.clientX
    const startY = event.clientY
    let active = false

    const move = (e: PointerEvent) => {
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return
        active = true
        setDragging(id)
      }
      e.preventDefault()
      const cell = cellAt(e.clientX, e.clientY)
      const over = cell?.dataset.tileId
      if (!cell || !over || over === id) {
        setDrop(undefined)
        return
      }
      const rect = cell.getBoundingClientRect()
      setDrop({ target: over, zone: dropZone(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height) })
    }

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move, true)
      window.removeEventListener("pointerup", up, true)
      window.removeEventListener("pointercancel", cancel, true)
      window.removeEventListener("keydown", escape, true)
      const landing = drop()
      setDragging(undefined)
      setDrop(undefined)
      if (!commit || !active || !landing) return
      const tiles = props.panes.map((pane, index) => ({ id: pane.id, span: spans()[index]! }))
      const order = moveTile(tiles, id, landing.target, landing.zone, columns())
      if (order.some((paneId, index) => paneId !== props.panes[index]?.id)) props.onMove?.(order)
      props.onFocus(id)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !active) return
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }

    window.addEventListener("pointermove", move, true)
    window.addEventListener("pointerup", up, true)
    window.addEventListener("pointercancel", cancel, true)
    window.addEventListener("keydown", escape, true)
  }

  /* -------------------------------------------------------------- resize */

  const startResize = (id: string, event: PointerEvent) => {
    if (!props.onResize || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const cell = (event.currentTarget as HTMLElement).parentElement
    if (!cell) return
    const rect = cell.getBoundingClientRect()
    const index = indexOf().get(id)
    if (index === undefined) return
    const start = spans()[index]!
    const style = getComputedStyle(container)
    const columnGap = Number.parseFloat(style.columnGap) || GRID_GAP
    const rowGap = Number.parseFloat(style.rowGap) || GRID_GAP
    // One cell's size, recovered from the tile's own: the grid's tracks are
    // not all the same height once it scrolls, but the tile's are.
    const unitWidth = (rect.width - columnGap * (start.columns - 1)) / start.columns
    const unitHeight = (rect.height - rowGap * (start.rows - 1)) / start.rows

    const move = (e: PointerEvent) => {
      e.preventDefault()
      const across = Math.round((e.clientX - rect.left + columnGap) / (unitWidth + columnGap))
      const down = Math.round((e.clientY - rect.top + rowGap) / (unitHeight + rowGap))
      setResizing({ id, span: effectiveSpan({ span: { columns: across, rows: down } }, columns()) })
    }
    const up = () => {
      window.removeEventListener("pointermove", move, true)
      window.removeEventListener("pointerup", up, true)
      window.removeEventListener("pointercancel", up, true)
      const chosen = resizing()
      setResizing(undefined)
      // A press that did not change the size is not a choice: committing it
      // would overwrite a size the grid only clamped for now, or pin a
      // pane on the default it was never resized from.
      if (!chosen || (chosen.span.columns === start.columns && chosen.span.rows === start.rows)) return
      props.onResize?.(id, chosen.span)
    }
    window.addEventListener("pointermove", move, true)
    window.addEventListener("pointerup", up, true)
    window.addEventListener("pointercancel", up, true)
  }

  return (
    <div
      ref={container}
      data-component="session-grid"
      data-empty={props.panes.length === 0 ? "true" : undefined}
      data-arranging={dragging() || resizing() ? "true" : undefined}
      onKeyDown={onKeyDown}
      style={{
        "grid-template-columns": `repeat(${columns()}, minmax(0, 1fr))`,
        "grid-auto-rows": `minmax(${MIN_PANE_HEIGHT}px, calc((100% - ${
          GRID_GAP * (layout().rows - 1)
        }px) / ${Math.max(1, layout().rows)}))`,
      }}
    >
      <For each={stable()}>
        {(pane) => {
          const place = () => {
            const index = indexOf().get(pane.id)
            return index === undefined ? undefined : layout().placements[index]
          }
          const zone = () => (drop()?.target === pane.id ? drop()!.zone : undefined)
          return (
            <div
              data-slot="grid-cell"
              data-tile-id={pane.id}
              data-focused={pane.id === props.focused ? "true" : undefined}
              data-dragging={dragging() === pane.id ? "true" : undefined}
              data-sized={props.tileOf?.(pane.id)?.span ? "true" : undefined}
              style={
                place()
                  ? {
                      "grid-column": `${place()!.column + 1} / span ${place()!.columns}`,
                      "grid-row": `${place()!.row + 1} / span ${place()!.rows}`,
                    }
                  : { display: "none" }
              }
              onFocusIn={() => props.onFocus(pane.id)}
              onPointerDown={(event) => {
                props.onFocus(pane.id)
                startDrag(pane.id, event)
              }}
            >
              {pane.render()}
              <Show when={zone()}>
                {(current) => (
                  <div data-slot="drop-zone" data-zone={current()} aria-hidden="true">
                    <span data-slot="drop-zone-label">{ZONE_LABELS[current()]}</span>
                  </div>
                )}
              </Show>
              <Show when={props.onResize}>
                <div
                  data-slot="tile-resize"
                  role="separator"
                  aria-label={t("grid.resize")}
                  title={t("grid.resize.tip")}
                  onPointerDown={(event) => startResize(pane.id, event)}
                  onDblClick={(event) => {
                    event.stopPropagation()
                    props.onResize?.(pane.id, undefined)
                  }}
                />
              </Show>
            </div>
          )
        }}
      </For>
    </div>
  )
}

/** Exposed so a host can drive closing without reimplementing the focus rule. */
export { focusAfterClose, moveFocus }

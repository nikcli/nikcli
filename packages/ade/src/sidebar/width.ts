/**
 * Width clamping and resize calculations for the ADE sidebar.
 *
 * The sidebar sits alongside a tiled grid of live agent sessions. If it is too
 * narrow, session titles and file paths turn into unreadable ellipses; if it is
 * too wide, it starves the grid of the horizontal space needed to maintain its
 * minimum readable pane widths.
 */

/** Default sidebar width in pixels when no persisted preference exists. */
export const DEFAULT_SIDEBAR_WIDTH = 260

/**
 * Below this width, workspace titles and file names are truncated so severely
 * that scanning them becomes frustrating.
 */
export const MIN_SIDEBAR_WIDTH = 180

/**
 * Above this width, the sidebar consumes enough horizontal space to squeeze
 * two-column grid layouts into single columns on standard displays.
 */
export const MAX_SIDEBAR_WIDTH = 480

/**
 * Clamps a proposed sidebar width to stay within safe readable bounds.
 *
 * Defensive against invalid bounds (min > max) and non-finite numbers (NaN,
 * Infinity) which can occur during unconstrained pointer drag events or
 * corrupted storage states.
 */
export function clampSidebarWidth(width: number, min = MIN_SIDEBAR_WIDTH, max = MAX_SIDEBAR_WIDTH): number {
  const safeMin = Number.isFinite(min) ? min : MIN_SIDEBAR_WIDTH
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : Math.max(safeMin, MAX_SIDEBAR_WIDTH)

  if (!Number.isFinite(width)) {
    return Math.min(safeMax, Math.max(safeMin, DEFAULT_SIDEBAR_WIDTH))
  }

  return Math.min(safeMax, Math.max(safeMin, width))
}

/**
 * Computes the new sidebar width resulting from a pointer drag gesture.
 *
 * Drag delta is calculated from the initial pointer position to avoid
 * accumulated rounding errors from incremental frame-by-frame updates.
 */
export function calculateResize(
  startX: number,
  currentX: number,
  startWidth: number,
  min = MIN_SIDEBAR_WIDTH,
  max = MAX_SIDEBAR_WIDTH,
): number {
  const delta = currentX - startX
  return clampSidebarWidth(startWidth + delta, min, max)
}

/**
 * Parses and validates a sidebar width retrieved from persistent storage.
 *
 * Corrupt, empty, or out-of-bounds stored values fall back gracefully to the
 * default rather than throwing or creating an invisible 0px sidebar.
 */
export function parseSidebarWidth(
  raw: string | null | undefined,
  fallback = DEFAULT_SIDEBAR_WIDTH,
  min = MIN_SIDEBAR_WIDTH,
  max = MAX_SIDEBAR_WIDTH,
): number {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return clampSidebarWidth(fallback, min, max)
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return clampSidebarWidth(fallback, min, max)
  }

  return clampSidebarWidth(parsed, min, max)
}

/**
 * The attributes behind the layout primitives, as a pure function.
 *
 * Kept apart from `layout.tsx` so it can be tested: a `.tsx` does not load
 * under `bun test` in this package. The types are the design rule — a gap is a
 * step of `--ade-space-*` or nothing — and the function is the only place that
 * spells a prop as the attribute `layout.css` matches.
 */

/** Steps of `--ade-space-*`. */
export type Space = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export type PadX = 4 | 5 | 6 | 7
export type PadY = 2 | 3 | 4 | 5
export type Align = "start" | "center" | "end" | "baseline" | "stretch"
export type Justify = "start" | "center" | "end" | "between"
export type Border = "top" | "bottom"
export type LayoutKind = "stack" | "row" | "grid" | "scroll" | "overlay" | "surface"
export type Tone = "neutral" | "accent" | "working" | "waiting" | "done" | "error"

export interface LayoutOptions {
  gap?: Space
  pad?: Space
  padX?: PadX
  padY?: PadY
  align?: Align
  justify?: Justify
  border?: Border
  wrap?: boolean
  grow?: boolean
}

export type LayoutAttrs = Record<`data-${string}`, string | undefined>

export function layoutAttrs(kind: LayoutKind, options: LayoutOptions = {}): LayoutAttrs {
  return {
    "data-layout": kind,
    "data-gap": options.gap?.toString(),
    "data-pad": options.pad?.toString(),
    "data-pad-x": options.padX?.toString(),
    "data-pad-y": options.padY?.toString(),
    "data-align": options.align,
    "data-justify": options.justify,
    "data-border": options.border,
    "data-wrap": options.wrap ? "" : undefined,
    "data-grow": options.grow ? "" : undefined,
  }
}

/** Props the primitives consume; everything else goes to the element. */
export const LAYOUT_KEYS = ["gap", "pad", "padX", "padY", "align", "justify", "border", "wrap", "grow"] as const

export function badgeAttrs(tone: Tone = "neutral"): LayoutAttrs {
  return { "data-ui": "badge", "data-tone": tone === "neutral" ? undefined : tone }
}

/**
 * Layout primitives: Stack, Row, Grid, Scroll, Overlay, Surface, Badge.
 *
 * Thin on purpose. Each renders one element with the attributes `layout.css`
 * matches and passes every other prop through, so a primitive can carry a
 * `data-slot`, a `ref`, a role or a handler exactly like the `div` it replaces.
 * Spacing is only ever a token step; see `layout-attrs.ts`.
 */
import { splitProps, type JSX, type ParentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import { LAYOUT_KEYS, badgeAttrs, layoutAttrs, type LayoutKind, type LayoutOptions, type Tone } from "./layout-attrs"
import "./layout.css"

type Tag = "div" | "section" | "header" | "footer" | "nav" | "ul" | "ol" | "li" | "form" | "main" | "aside"

type BoxProps = ParentProps<LayoutOptions & JSX.HTMLAttributes<HTMLElement> & { as?: Tag }>

function box(kind: LayoutKind) {
  return (props: BoxProps) => {
    const [layout, own, rest] = splitProps(props, LAYOUT_KEYS, ["as"])
    return <Dynamic component={own.as ?? "div"} {...layoutAttrs(kind, layout)} {...rest} />
  }
}

/** A column with token gaps. */
export const Stack = box("stack")
/** A row, centred on the cross axis by default. `wrap` lets it break. */
export const Row = box("row")
/** Auto-filling columns; set `--ade-grid-min` in `style` for the minimum track. */
export const Grid = box("grid")

/** A scrolling region. `max` bounds its height (`"320px"`, `"40vh"`). */
export function Scroll(props: ParentProps<JSX.HTMLAttributes<HTMLDivElement> & { max?: string }>) {
  const [own, rest] = splitProps(props, ["max", "children"])
  return (
    <div data-layout="scroll" style={own.max ? { "--ade-scroll-max": own.max } : undefined} {...rest}>
      {own.children}
    </div>
  )
}

/**
 * The scrim behind a dialog. A press on the scrim itself — not on anything
 * inside it — calls `onClose`, which is what every overlay in ADE did by hand.
 */
export function Overlay(
  props: ParentProps<JSX.HTMLAttributes<HTMLDivElement> & { onClose?: () => void; place?: "top" | "center" }>,
) {
  const [own, rest] = splitProps(props, ["onClose", "place", "children"])
  return (
    <div
      data-layout="overlay"
      data-place={own.place === "center" ? "center" : undefined}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) own.onClose?.()
      }}
      {...rest}
    >
      {own.children}
    </div>
  )
}

/** The raised panel a dialog is drawn on. */
export function Surface(
  props: ParentProps<JSX.HTMLAttributes<HTMLDivElement> & { size?: "sm" | "md" | "lg" | "xl" }>,
) {
  const [own, rest] = splitProps(props, ["size", "children"])
  return (
    <div data-layout="surface" data-size={own.size ?? "md"} {...rest}>
      {own.children}
    </div>
  )
}

/** A small uppercase label in one of the status tones. */
export function Badge(props: ParentProps<JSX.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }>) {
  const [own, rest] = splitProps(props, ["tone", "children"])
  return (
    <span {...badgeAttrs(own.tone)} {...rest}>
      {own.children}
    </span>
  )
}

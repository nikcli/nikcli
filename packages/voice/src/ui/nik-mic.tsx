/**
 * The nikcli microphone — the product's N drawn as a mic capsule.
 *
 * A generic microphone glyph says "audio" and nothing else; every app that
 * listens has one. This one says whose it is: the capsule is the head of the
 * mic and the N stands inside it, held by the same margins on both sides, with
 * the pickup cradle and stem beneath. At a glance it reads as a microphone; on
 * a second look it reads as the letter, which is the right order for a mark
 * that has to work at 14px in a toolbar.
 *
 * Two cuts, because one drawing cannot do both jobs:
 *
 *   line   — hairline capsule, N stroked inside it. Enough air to sit next to
 *            a heading without shouting. Below ~18px the N silts up.
 *   solid  — capsule filled, N knocked out of the fill. Holds its shape at
 *            14px and reads as a state indicator, which is what a toolbar
 *            button and a live widget need.
 *
 * The geometry is shared: the same capsule, the same N, so the two cuts are
 * the same mark and not two marks that resemble each other.
 */

export interface NikMicProps {
  /** Rendered edge length in px. The drawing is square. */
  size?: number
  /** Which cut to draw. Defaults to the hairline. */
  variant?: "line" | "solid"
  /**
   * Colour of the N in the solid cut — it is knocked out of the fill, so it
   * has to match whatever sits behind the mark rather than inherit from it.
   */
  knockout?: string
  class?: string
}

/*
 * One geometry, named once.
 *
 * The capsule is 9 wide inside a 24 box, and the N's stems sit 2.5 in from
 * each of its edges — the same figure top and bottom, so the letter is centred
 * in the head by construction rather than by eye.
 */
const CAPSULE = { x: 7.5, y: 2, w: 9, h: 12.5, r: 4.5 }
const N_TOP = 5
const N_BOTTOM = 11
const N_LEFT = 10
const N_RIGHT = 14

/** The cradle and stem, identical in both cuts. */
function Cradle(props: { width: number }) {
  return (
    <>
      <path
        d="M4.5 11.5v1a7.5 7.5 0 0 0 15 0v-1"
        fill="none"
        stroke="currentColor"
        stroke-width={props.width}
        stroke-linecap="round"
      />
      <path d="M12 20v2" fill="none" stroke="currentColor" stroke-width={props.width} stroke-linecap="round" />
    </>
  )
}

export function NikMic(props: NikMicProps) {
  const size = () => props.size ?? 16
  const solid = () => props.variant === "solid"

  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      class={props.class}
      data-component="nik-mic"
      data-variant={solid() ? "solid" : "line"}
      aria-hidden="true"
    >
      <rect
        x={CAPSULE.x}
        y={CAPSULE.y}
        width={CAPSULE.w}
        height={CAPSULE.h}
        rx={CAPSULE.r}
        fill={solid() ? "currentColor" : "none"}
        stroke={solid() ? "none" : "currentColor"}
        stroke-width="1.6"
      />

      {/*
        The N. Three strokes rather than one path: the diagonal has to meet the
        stems at their ends and nowhere else, and a single polyline would round
        the joins into a shape that stops being a letter.
      */}
      <g
        fill="none"
        stroke={solid() ? (props.knockout ?? "var(--ade-accent-fg, #fff)") : "currentColor"}
        stroke-width={solid() ? 1.9 : 1.7}
        stroke-linecap="round"
      >
        <path d={`M${N_LEFT} ${N_BOTTOM}V${N_TOP}`} />
        <path d={`M${N_LEFT} ${N_TOP}L${N_RIGHT} ${N_BOTTOM}`} />
        <path d={`M${N_RIGHT} ${N_TOP}V${N_BOTTOM}`} />
      </g>

      <Cradle width={solid() ? 1.9 : 1.6} />
    </svg>
  )
}

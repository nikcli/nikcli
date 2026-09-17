/**
 * The nikcli mark as a cube, turning.
 *
 * Six faces, each carrying the letter N, rotating slowly on two axes so that
 * three of them are visible at any moment and the set of three keeps changing.
 * It replaces the flat block mark in ADE's title bar: the mark there is the
 * one element that is not a control and not a status, so it is the only place
 * in the bar where something can move without competing with a reading.
 *
 * The letter is the ASCII character, set in the interface's monospace face —
 * not the drawn mark. That is the point of the object: at a face size of
 * fourteen pixels the block mark is a rectangle and the three-stroke letter is
 * a smudge, while a mono glyph is a shape the font was designed to hold at
 * that size. It also makes the cube read as a terminal artefact, which is what
 * the product is.
 *
 * Backface culling is what keeps it legible. With all six faces drawn, the
 * translucent ones behind show through and the cube becomes a tangle of
 * hairlines; hidden, the silhouette stays a clean cube outline and the letters
 * turn away rather than reversing.
 *
 * The letter is on the four sides only, and the turn is around one axis.
 * Tumbling on two axes showed all six faces, which sounds better and is not:
 * the lid swings into view carrying an upside-down N, and a reversed letter
 * reads as a rendering bug rather than as the far side of a solid. So the lid
 * and the base are blank, the way a printed box is printed on its sides, and
 * the cube turns the way a box on a turntable does. A constant shallow tilt
 * keeps the top edge in view, so it never flattens into a badge at the moment
 * a face comes square-on.
 */

import { createSignal, onCleanup, onMount } from "solid-js"
import { ASCII_COLS, ASCII_ROWS, renderAsciiCube } from "./ascii-cube"
import "./nik-cube.css"

export interface NikCubeProps {
  /**
   * Which cut.
   *
   * `solid` is the CSS one — six real faces with the letter set in mono, the
   * browser doing the projection. `ascii` is the same cube drawn with
   * characters: `renderAsciiCube` projects it and stamps it into an 11×7 grid
   * every frame, edges made of `-|/\+` and an N in the middle of each face
   * turned towards you. Same object, two materials — one belongs on a
   * designed surface, the other says out loud that this is a terminal tool.
   */
  variant?: "solid" | "ascii"
  /** Rendered edge length in px. The cube is square in all three dimensions. */
  size?: number
  /**
   * Seconds for one full turn.
   *
   * Slow by default. It is an identity, not an indicator: fast enough to read
   * as "spinning" is fast enough to pull the eye away from the session list
   * every time it passes.
   */
  seconds?: number
  class?: string
}

/** The six faces. Only the four sides are printed; see the note above. */
const FACES = [
  { id: "front", letter: true },
  { id: "back", letter: true },
  { id: "right", letter: true },
  { id: "left", letter: true },
  { id: "top", letter: false },
  { id: "bottom", letter: false },
] as const

/**
 * Frames a second.
 *
 * Deliberately low. A character grid has eleven columns to say which way the
 * cube is facing, so most frames at sixty are identical to the one before and
 * the ones that are not jump by a whole cell — the motion is quantised by the
 * grid, not by the clock. Twelve is where it stops looking like a dropped
 * frame rate and starts looking like the medium.
 */
const ASCII_FPS = 12

function AsciiCube(props: NikCubeProps) {
  const seconds = () => props.seconds ?? 14
  const [angle, setAngle] = createSignal(0)

  onMount(() => {
    if (typeof window === "undefined") return
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    if (reduced) {
      /* Parked at a three-quarter view, like the CSS cut: two printed faces,
         both letters, no turning. */
      setAngle(Math.PI / 4)
      return
    }
    const step = (Math.PI * 2) / (seconds() * ASCII_FPS)
    const timer = setInterval(() => setAngle((previous) => (previous + step) % (Math.PI * 2)), 1000 / ASCII_FPS)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <pre
      data-component="nik-cube"
      data-variant="ascii"
      class={props.class}
      style={{
        "--cube-size": `${props.size ?? 22}px`,
        "--cube-rows": String(ASCII_ROWS),
        "--cube-cols": String(ASCII_COLS),
      }}
      aria-hidden="true"
    >
      {renderAsciiCube({ cols: ASCII_COLS, rows: ASCII_ROWS, angle: angle() })}
    </pre>
  )
}

export function NikCube(props: NikCubeProps) {
  if (props.variant === "ascii") return <AsciiCube {...props} />

  return (
    <span
      data-component="nik-cube"
      data-variant="solid"
      class={props.class}
      style={{
        "--cube-size": `${props.size ?? 22}px`,
        "--cube-seconds": `${props.seconds ?? 14}s`,
      }}
      aria-hidden="true"
    >
      <span data-slot="cube">
        {FACES.map((face) => (
          <span data-slot="face" data-face={face.id}>
            {face.letter ? "N" : ""}
          </span>
        ))}
      </span>
    </span>
  )
}

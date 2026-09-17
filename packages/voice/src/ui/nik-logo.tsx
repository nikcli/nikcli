/**
 * The nikcli mark.
 *
 * The block N from `packages/console/app/src/asset/brand/nikcli-logo-*.svg`,
 * as a component rather than an imported file: the widget draws it inside a
 * filled disc, where it has to take the disc's foreground colour instead of
 * the two greys the asset ships baked in. An <img> cannot be recoloured, and a
 * second pair of assets for a second background is how a mark starts drifting
 * from itself.
 *
 * The geometry is copied from the asset unchanged — a 4×5 grid of square
 * cells in a 32×40 box — so this and the files stay the same drawing.
 *
 * Both of the mark's tones come from `currentColor`: the counter is the same
 * colour held back, which is what the two greys in the asset are doing against
 * their own grounds. That keeps the mark readable on any ground it is given,
 * rather than only on the two it was drawn for.
 */

export interface NikLogoProps {
  /** Rendered height in px. The width follows the mark's 4:5 proportion. */
  size?: number
  /**
   * How strongly the counter is held back from the stems, 0…1.
   *
   * The default is the value the widget wants: inside a filled disc, at
   * 15px, 0.45 is what separates the two without the mark falling apart.
   * Somewhere larger and on a plain ground it is too much — the counter
   * fills the bowl of the N and the whole mark reads as a rectangle — so
   * the caller can hold it back further.
   */
  counterOpacity?: number
  class?: string
}

/** The counter — the filled inside of the N, held back from the stems. */
const COUNTER =
  "M8 16H16V24H8ZM16 16H24V24H16ZM8 24H16V32H8ZM16 24H24V32H16ZM8 32H16V40H8ZM16 32H24V40H16Z"

/** The stems and the shoulder. */
const STEMS =
  "M0 0H8V8H0ZM8 0H16V8H8ZM16 0H24V8H16ZM0 8H8V16H0ZM24 8H32V16H24ZM0 16H8V24H0ZM24 16H32V24H24ZM0 24H8V32H0ZM24 24H32V32H24ZM0 32H8V40H0ZM24 32H32V40H24Z"

export function NikLogo(props: NikLogoProps) {
  const height = () => props.size ?? 16
  const width = () => (height() * 32) / 40

  return (
    <svg
      width={width()}
      height={height()}
      viewBox="0 0 32 40"
      class={props.class}
      data-component="nik-logo"
      aria-hidden="true"
    >
      <path d={COUNTER} fill="currentColor" opacity={props.counterOpacity ?? 0.45} />
      <path d={STEMS} fill="currentColor" />
    </svg>
  )
}

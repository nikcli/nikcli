/**
 * A bot's face: a shape and a colour, and where its eyes are looking.
 *
 * A roster of grey circles with an initial in each is a list of names. The
 * thing that makes a bot recognisable at a glance — before the name is read —
 * is a silhouette that is always the same for that bot and different from the
 * others. So each bot gets one of nine shapes in one of six colours, derived
 * from its identifier: the file `revisore.md` is a magenta circle on every
 * machine, in the roster, in the thread and in the sidebar, with nothing
 * written down anywhere. A field in the frontmatter would be a second thing
 * to keep in step with the first, and nikcli would not know what it was for.
 *
 * The colours are ADE's own ANSI palette, so they follow the theme: the
 * component sets `--bot-color: var(--ade-ansi-<name>)` and the light values
 * are picked by the stylesheet, not here.
 *
 * Pure, in a `.ts`, because a wrong hash is a bot that changes shape between
 * two builds, which is worse than any shape being ugly.
 */

export const SHAPES = ["circle", "drop", "cloud", "hex", "egg", "pill", "tri", "square", "blob"] as const
export type Shape = (typeof SHAPES)[number]

export const COLORS = ["magenta", "blue", "green", "cyan", "yellow", "red"] as const
export type Color = (typeof COLORS)[number]

export interface Avatar {
  readonly shape: Shape
  readonly color: Color
}

/**
 * FNV-1a, 32 bit. Stable, cheap, and spreads short similar names — `bot1`,
 * `bot2` — onto different shapes, which is what the roster needs.
 */
export function hashIdentifier(identifier: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < identifier.length; i++) {
    hash ^= identifier.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * A face written down: `shape/color`, the form the agent file's `avatar` key
 * takes. nikcli ignores keys it does not know, so the choice travels with the
 * file — a bot copied to another machine keeps its face.
 */
export function avatarKey(avatar: Avatar): string {
  return `${avatar.shape}/${avatar.color}`
}

/** The face a file names, or nothing when the key is absent or not a face. */
export function parseAvatar(value: string | undefined): Avatar | undefined {
  if (!value) return undefined
  const [shape, color] = value.trim().toLowerCase().split("/")
  if (!SHAPES.includes(shape as Shape) || !COLORS.includes(color as Color)) return undefined
  return { shape: shape as Shape, color: color as Color }
}

/** The face to draw: the one chosen, or the one the name gives. */
export function faceOf(identifier: string, chosen?: string): Avatar {
  return parseAvatar(chosen) ?? avatarFor(identifier)
}

export function avatarFor(identifier: string): Avatar {
  const hash = hashIdentifier(identifier.trim().toLowerCase())
  // Two independent slices of the hash, so shape and colour do not move
  // together: with 9 × 6 combinations the low bits alone would pair them.
  const shape = SHAPES[hash % SHAPES.length]
  const color = COLORS[Math.floor(hash / 64) % COLORS.length]
  return { shape, color }
}

/**
 * What the eyes do.
 *
 * The same states a session has, with one more for a bot that cannot be
 * spoken to — a subagent, or one whose file is broken — whose eyes are
 * closed. The stylesheet moves the two strokes; nothing else changes, so the
 * face stays two strokes and never becomes a drawing.
 */
export type Expression = "still" | "busy" | "waiting" | "error" | "off"

export function expressionFor(status: "idle" | "working" | "waiting" | "error" | "off" | undefined): Expression {
  switch (status) {
    case "working":
      return "busy"
    case "waiting":
      return "waiting"
    case "error":
      return "error"
    case "off":
      return "off"
    default:
      return "still"
  }
}

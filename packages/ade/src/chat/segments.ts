/**
 * Splitting a model's reply into prose and code blocks.
 *
 * Not a markdown renderer, and not the start of one. Fenced code is the only
 * construct that *has* to be structural: monospaced, preserved whitespace,
 * and copyable as a unit. Everything else — emphasis, lists, headings — reads
 * acceptably as plain text and is left alone, which keeps this file small
 * enough to be obviously correct and keeps untrusted model output away from
 * any innerHTML path.
 */

export interface ProseSegment {
  kind: "prose"
  text: string
}

export interface CodeSegment {
  kind: "code"
  /** The fence's info string, when it named one. */
  language?: string
  text: string
}

export type Segment = ProseSegment | CodeSegment

const FENCE = /^\s*```([^\s`]*)\s*$/

/**
 * Splits on triple-backtick fences, tolerating a block that never closes.
 *
 * The unclosed case is the normal one while streaming: the opening fence
 * arrives several hundred milliseconds before the closing one, and treating
 * that interval as prose makes every code block visibly reflow the moment it
 * completes. It is rendered as code from the first line instead.
 */
export function splitSegments(text: string): Segment[] {
  const segments: Segment[] = []
  const lines = text.split("\n")

  let prose: string[] = []
  let code: string[] | undefined
  let language: string | undefined

  const flushProse = () => {
    if (prose.length === 0) return
    const joined = prose.join("\n")
    // Blank runs between blocks are separators, not content.
    if (joined.trim().length > 0) segments.push({ kind: "prose", text: joined.replace(/^\n+|\n+$/g, "") })
    prose = []
  }

  for (const line of lines) {
    const fence = FENCE.exec(line)

    if (fence && code === undefined) {
      flushProse()
      code = []
      language = fence[1] || undefined
      continue
    }

    if (fence && code !== undefined) {
      segments.push({ kind: "code", ...(language ? { language } : {}), text: code.join("\n") })
      code = undefined
      language = undefined
      continue
    }

    if (code !== undefined) code.push(line)
    else prose.push(line)
  }

  if (code !== undefined) {
    segments.push({ kind: "code", ...(language ? { language } : {}), text: code.join("\n") })
  } else {
    flushProse()
  }

  return segments
}

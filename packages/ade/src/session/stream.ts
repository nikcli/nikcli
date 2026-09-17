/**
 * ANSI stripping, parsing, and line classification for agent process output.
 *
 * Agent CLI processes emit a firehose of ANSI-decorated text: colour codes,
 * cursor movement, progress bars that rewrite the same line hundreds of times.
 * This module turns that raw stream into something a transcript pane can
 * render without drowning.
 *
 * Everything here is pure: no process handles, no streams — just strings in,
 * structured data out. The actual I/O boundary lives in the Tauri command
 * layer.
 */

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

/**
 * Matches all standard ANSI escape sequences:
 * - CSI sequences: ESC [ ... final_byte
 * - OSC sequences: ESC ] ... ST (BEL or ESC \)
 * - Simple two-byte escapes: ESC followed by a single character
 *
 * The regex is intentionally permissive: agent output can contain malformed
 * sequences from partial flushes, and failing to strip one is worse than
 * stripping too aggressively.
 */
/*
 * The CSI parameter class is `[0-9;:<=>?]` and the final byte is `[@-~]`, not
 * `[A-Za-z]`.
 *
 * Both were too narrow for what agents actually send. crossterm opens with
 * `ESC[>1u` — push keyboard enhancement flags — whose `>` is a private
 * parameter and whose `u` is in range either way; matched against `[0-9;]`
 * the sequence broke at the `>`, and `1u` appeared in the transcript as the
 * first thing the session said. `ESC[?25l` (hide cursor) failed the same way.
 * The intermediate bytes `[ -/]` are matched too, which is what `ESC[?1049h`
 * and the DEC private modes need.
 */
const ANSI_RE = /\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g

/** Remove all ANSI escape sequences, returning plain text. */
export function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, "")
}

// ---------------------------------------------------------------------------
// ANSI parsing → Span[]
// ---------------------------------------------------------------------------

/** A run of text with a single style. */
export interface Span {
  text: string
  bold?: boolean
  /** One of the 16 base terminal colours, or undefined for default. */
  color?: AnsiColor
}

/**
 * The 16 base ANSI colours.
 *
 * Named after their SGR codes rather than their visual appearance, because the
 * actual colour depends on the terminal theme — "red" in Solarized is not the
 * same hue as "red" in Monokai, and the renderer maps these names to CSS
 * variables.
 */
export type AnsiColor =
  | "black" | "red" | "green" | "yellow"
  | "blue" | "magenta" | "cyan" | "white"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
  | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite"

const COLOR_TABLE: Record<number, AnsiColor> = {
  30: "black", 31: "red", 32: "green", 33: "yellow",
  34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "brightBlack", 91: "brightRed", 92: "brightGreen", 93: "brightYellow",
  94: "brightBlue", 95: "brightMagenta", 96: "brightCyan", 97: "brightWhite",
}

interface ParseState {
  bold: boolean
  color: AnsiColor | undefined
}

function resetState(): ParseState {
  return { bold: false, color: undefined }
}

function applySgr(state: ParseState, params: number[]): ParseState {
  const next = { ...state }
  // An empty param list is equivalent to [0] (reset).
  const codes = params.length === 0 ? [0] : params
  for (const code of codes) {
    if (code === 0) {
      next.bold = false
      next.color = undefined
    } else if (code === 1) {
      next.bold = true
    } else if (code === 22) {
      next.bold = false
    } else if (code in COLOR_TABLE) {
      next.color = COLOR_TABLE[code]
    } else if (code === 39) {
      next.color = undefined
    }
  }
  return next
}

/**
 * Parse a line of ANSI-decorated text into styled spans.
 *
 * Handles CSI SGR sequences (colours and bold). Other escape sequences are
 * silently stripped — they affect cursor position or window title, neither of
 * which the transcript pane uses.
 */
export function parseAnsi(line: string): Span[] {
  const spans: Span[] = []
  let state = resetState()
  let textBuf = ""

  const flush = () => {
    if (textBuf.length === 0) return
    const span: Span = { text: textBuf }
    if (state.bold) span.bold = true
    if (state.color) span.color = state.color
    textBuf = ""
    spans.push(span)
  }

  let i = 0
  while (i < line.length) {
    if (line[i] === "\x1b") {
      // CSI sequence: ESC [
      if (i + 1 < line.length && line[i + 1] === "[") {
        let j = i + 2
        /*
         * Parameter bytes are `0x30-0x3F` and intermediates `0x20-0x2F`, not
         * just digits and semicolons. `ESC[>1u` from crossterm and `ESC[?25l`
         * both begin with a private-parameter byte, so the scan stopped
         * immediately, the final byte was read as `>` or `?`, and the rest of
         * the sequence was rendered as text: every ratatui agent's first line
         * of "output" was the tail of its own keyboard-mode handshake.
         */
        while (j < line.length && line[j] >= "\x30" && line[j] <= "\x3f") j++
        while (j < line.length && line[j] >= "\x20" && line[j] <= "\x2f") j++
        if (j < line.length) {
          const finalByte = line[j]
          if (finalByte === "m") {
            // SGR sequence
            flush()
            const paramStr = line.slice(i + 2, j)
            const params = paramStr.length === 0
              ? []
              : paramStr.split(";").map(s => parseInt(s, 10) || 0)
            state = applySgr(state, params)
          }
          // Skip the entire sequence regardless of type
          i = j + 1
          continue
        }
        // Incomplete CSI — treat the rest as text (partial flush)
        i = j
        continue
      }
      // OSC sequence: ESC ]
      if (i + 1 < line.length && line[i + 1] === "]") {
        let j = i + 2
        while (j < line.length && line[j] !== "\x07") {
          if (line[j] === "\x1b" && j + 1 < line.length && line[j + 1] === "\\") {
            j += 2
            break
          }
          j++
        }
        if (j < line.length && line[j] === "\x07") j++
        i = j
        continue
      }
      // Simple two-byte escape
      i += 2
      continue
    }
    textBuf += line[i]
    i++
  }
  flush()
  return spans
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

export type LineKind = "step" | "shell" | "note" | "diff" | "error"

/**
 * Classify a *stripped* line by its prefix or content.
 *
 * The heuristics are based on real agent output patterns:
 * - Shell commands are prefixed with "$ "
 * - Diff hunks start with "+"/"-" (but not "+++"/"---" headers, which are also diffs)
 * - Errors contain recognisable markers
 * - Steps are numbered actions ("1.", "Step 2:", etc.)
 * - Everything else is a note
 */
export function classifyLine(line: string): LineKind {
  const trimmed = line.trimStart()

  // Error markers — check first because errors can appear inside diffs
  if (/^(Error:|error:|ERR!|FATAL|panic:|Traceback \(most recent)/.test(trimmed)) return "error"
  if (/^\s+at\s+/.test(line) && /\.\w+:\d+/.test(line)) return "error" // stack trace line

  // Shell command
  if (trimmed.startsWith("$ ")) return "shell"

  // Diff: unified diff headers and hunks
  if (trimmed.startsWith("+++ ") || trimmed.startsWith("--- ")) return "diff"
  if (trimmed.startsWith("@@ ")) return "diff"
  if (/^[+-][^+-]/.test(trimmed) || trimmed === "+" || trimmed === "-") return "diff"

  // Step markers — common agent output patterns
  if (/^\d+[.)]\s/.test(trimmed)) return "step"
  if (/^(Step|Passo)\s+\d+/i.test(trimmed)) return "step"
  if (/^#{1,3}\s/.test(trimmed)) return "step"

  return "note"
}

// ---------------------------------------------------------------------------
// Circular buffer with repeat collapsing
// ---------------------------------------------------------------------------

export interface BufferLine {
  text: string
  kind: LineKind
  /** When > 1, this line replaces `repeatCount` identical consecutive lines. */
  repeatCount: number
}

export interface LineBuffer {
  /** The visible lines, oldest first. */
  lines: BufferLine[]
  /** Maximum number of logical lines (after collapsing). */
  limit: number
}

/**
 * Append a line to a circular buffer, collapsing consecutive duplicates.
 *
 * Progress bars and spinners emit the same line hundreds of times; collapsing
 * them into a single entry with a counter keeps the transcript readable
 * without losing information.
 *
 * Returns a *new* buffer — the input is not mutated.
 */
export function appendLine(buffer: LineBuffer, line: string, limit?: number): LineBuffer {
  const effectiveLimit = limit ?? buffer.limit
  const stripped = stripAnsi(line)
  const kind = classifyLine(stripped)

  const lines = [...buffer.lines]

  // Collapse consecutive identical lines
  if (lines.length > 0) {
    const last = lines[lines.length - 1]
    if (last.text === stripped) {
      lines[lines.length - 1] = { ...last, repeatCount: last.repeatCount + 1 }
      return { lines, limit: effectiveLimit }
    }
  }

  lines.push({ text: stripped, kind, repeatCount: 1 })

  // Trim from the front if over limit
  if (lines.length > effectiveLimit) {
    return { lines: lines.slice(lines.length - effectiveLimit), limit: effectiveLimit }
  }

  return { lines, limit: effectiveLimit }
}

/** Empty buffer with the given capacity. */
export function emptyBuffer(limit: number): LineBuffer {
  return { lines: [], limit }
}

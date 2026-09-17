/**
 * Turning a pty's byte stream into lines somebody can read.
 *
 * The pane has a real terminal emulator and does not need this. This is the
 * *second* reading of the same bytes, for the parts of ADE that only want to
 * notice what an agent said — a permission question, a token count, a cost —
 * without understanding cursor movement to find it.
 *
 * It lives apart from `shell.ts` because it is where three bugs lived, all of
 * the same shape: logic that is correct on a whole stream applied to one
 * arbitrary 8 KB read. A chunk boundary is not a semantic boundary, and the
 * only way to test that claim is to be able to hand the code two chunks.
 */

import { stripAnsi } from "./ansi"


/**
 * How much output without a newline is kept before it is emitted anyway.
 *
 * Unbounded, this grew for the length of the session. A ratatui agent
 * redraws its whole screen with cursor moves and never emits a newline, so
 * the buffer never drained, it was re-split on every chunk — quadratic — and
 * `onLine` never fired once, which means no permission detection and no
 * token counting for exactly the agents that most need them.
 */
export const MAX_PENDING_CHARS = 8192

export interface LineAccumulator {
  /** Feeds one chunk and returns whatever complete lines it completed. */
  push(chunk: string): string[]
  /** Whatever is left, for when the process exits mid-line. */
  flush(): string[]
}

/**
 * How far back an unfinished escape sequence is worth looking for.
 *
 * A real sequence is a handful of bytes; an OSC hyperlink is the long one and
 * still fits easily. Bounded so a stream of raw `ESC` bytes with no terminator
 * — which is not a sequence, it is noise — cannot hold the buffer hostage.
 */
const MAX_ESCAPE_TAIL = 256

/**
 * Where to cut so no escape sequence is split in half.
 *
 * Returns the length of `text` when nothing is pending, which is the normal
 * case: the cut only moves when the very end of the buffer is an introducer
 * still waiting for its final byte.
 */
function incompleteEscapeStart(text: string): number {
  const from = Math.max(0, text.length - MAX_ESCAPE_TAIL)
  const at = text.lastIndexOf("\x1b", text.length - 1)
  if (at < from) return text.length

  const tail = text.slice(at)
  return isFinishedEscape(tail) ? text.length : at
}

/** Whether `tail`, which starts at an ESC, is a sequence that has ended. */
function isFinishedEscape(tail: string): boolean {
  // CSI: ESC [ params intermediates final.
  if (tail.startsWith("\x1b[")) return /^\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/.test(tail)

  /*
   * The string sequences, checked before the two-character form rather than
   * after it: their introducers (`P`, `X`, `^`, `_`, `]`) are themselves
   * two-character escapes, so the general rule would call an OSC that is
   * still being written "finished" and cut straight through it.
   */
  if (/^\x1b[\]P^_X]/.test(tail)) return /^\x1b[\]P^_X][\s\S]*?(?:\x07|\x1b\\)/.test(tail)

  if (tail.startsWith("\x1b(") || tail.startsWith("\x1b)") || tail.startsWith("\x1b#")) {
    return /^\x1b[()#][0-9A-Za-z]/.test(tail)
  }
  return /^\x1b[@-Z\\-_]/.test(tail)
}

export function createLineAccumulator(maxPending: number = MAX_PENDING_CHARS): LineAccumulator {
  /*
   * Raw, not stripped.
   *
   * Stripping each chunk as it arrived broke any escape sequence that
   * straddled a read: `ESC [ 3` in one chunk and `1 m` in the next matched
   * nothing in either, so both halves survived into the transcript as
   * literal text. Held raw, the sequence is whole by the time anything looks
   * at it.
   */
  let pending = ""

  const emit = (raw: string): string => stripAnsi(raw)

  return {
    push(chunk: string): string[] {
      pending += chunk

      const parts = pending.split(/\r?\n/)
      /*
       * A chunk ending in a bare `\r` leaves that `\r` in the remainder,
       * where the next chunk's `\n` completes the CRLF. Windows pty output
       * is CRLF and an 8 KB read lands between the two often enough to
       * matter: the old code stripped per chunk, so the trailing `\r` looked
       * like a carriage return with no newline — a redraw — and the rule for
       * those deleted the entire line in front of it. The line was in the
       * xterm pane, so it looked like nondeterministic loss from `onLine`
       * alone.
       */
      pending = parts.pop() ?? ""

      const lines = parts.map(emit)

      if (pending.length > maxPending) {
        /*
         * Cut before the last escape that has not finished yet.
         *
         * The overflow cut is the one place a sequence can still be split in
         * half, because it falls wherever the 8 KB happens to land rather
         * than on a line boundary. Half of `ESC[38;2;128;128;128m` survives
         * the strip as `;128m`, and that is how a colour code ended up read
         * as something the agent had said.
         */
        const cut = incompleteEscapeStart(pending)
        lines.push(emit(pending.slice(0, cut)))
        pending = pending.slice(cut)
      }

      return lines
    },

    flush(): string[] {
      if (pending.length === 0) return []
      const last = emit(pending)
      pending = ""
      return last.trim().length > 0 ? [last] : []
    },
  }
}

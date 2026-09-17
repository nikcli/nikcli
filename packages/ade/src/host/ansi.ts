/*
 * Enough of the terminal's own language to remove it.
 *
 * Not an emulator and not trying to be: the pane has a real one. This exists so
 * the line-reading half of `spawn` sees words instead of cursor moves, and it
 * covers what agent CLIs actually emit — CSI sequences (colour, cursor, erase),
 * OSC strings (window titles, hyperlinks) and the lone escapes around them.
 *
 * Kept in its own file so `line-stream.ts` can use it without importing the
 * host, which would be a cycle.
 */
export function stripAnsi(text: string): string {
  return (
    text
      // OSC: ESC ] ... terminated by BEL or ESC \
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
      /*
       * The other string sequences: DCS (ESC P), SOS (ESC X), PM (ESC ^) and
       * APC (ESC _), all closed by BEL or ST.
       *
       * They have to be removed before the two-character rule below, which
       * would otherwise eat only the introducer and leave the payload as
       * text. That is not hypothetical: a terminal that answers XTGETTCAP
       * replies `ESC P +q<hex>=<hex> ESC \`, and the first thing a restored
       * nikcli session appeared to say was `+q4d73Gi=31337,s=1,v=1,a=q,…`.
       */
      .replace(/\x1b[P^_X][\s\S]*?(?:\x07|\x1b\\)/g, "")
      /*
       * CSI: ESC [ params intermediates final.
       *
       * The parameter class includes `<=>?` because the standard says so, and
       * because crossterm uses them: `ESC[>1u` pushes the keyboard enhancement
       * flags and every ratatui agent sends it on startup. Matched against
       * `[0-9;?]` the sequence broke after `ESC[>`, and `1u` was left behind
       * as the first thing the session appeared to say.
       */
      .replace(/\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g, "")
      // Two-character escapes, and the single-shift/charset selectors
      .replace(/\x1b[()#][0-9A-Za-z]/g, "")
      .replace(/\x1b[@-Z\\-_]/g, "")
      // A carriage return with no newline is a redraw of the same line: keep
      // the last version, which is what the user is looking at.
      .replace(/^.*\r(?!\n)/gm, "")
  )
}

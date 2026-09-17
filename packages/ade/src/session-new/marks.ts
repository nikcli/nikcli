/**
 * Which agents ADE has a real mark for, and what stands in for the rest.
 *
 * Apart from `agent-mark.tsx` because a `.tsx` cannot be imported under
 * `bun test` here, and because this is the half with a claim in it: saying
 * an agent's logo is the real one when it is a letter in a circle is the
 * sort of thing that is wrong quietly, in a list nobody re-reads.
 */

/**
 * The agent ids drawn with their actual mark.
 *
 * Every one of these is published geometry rather than a redrawing, and
 * `agent-mark.tsx` names the file each came out of. `terminal` is the one
 * exception and not a claim about anybody: a shell is not somebody's product,
 * so there is no mark to be unfaithful to.
 *
 * `hermes` is drawn with Nous Research's vector geometry.
 *
 * Adding an entry here without adding the drawing in `agent-mark.tsx` is the
 * mistake this pair exists to make visible, and the test asserts they agree.
 */
export const REAL_MARK_IDS: readonly string[] = [
  "claude-code",
  "codex",
  "opencode",
  "nikcli",
  "agy",
  "kimi",
  "prime",
  "pi",
  "ohmypi",
  "hermes",
  "terminal",
]

/** Whether this agent is drawn with its own mark rather than a monogram. */
export function hasRealMark(id: string): boolean {
  return REAL_MARK_IDS.includes(id)
}

/**
 * The letter a monogram falls back to.
 *
 * The product's own initial, taken from the id rather than the label because
 * the id is the stable name: "Kimi Code" could be relabelled tomorrow and the
 * mark should not change with it.
 */
export function initialOf(id: string): string {
  return (id.replace(/[^a-z0-9]/gi, "")[0] ?? "•").toUpperCase()
}

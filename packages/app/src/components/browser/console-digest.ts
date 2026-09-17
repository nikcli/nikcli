/**
 * Turning a noisy console into something worth sending.
 *
 * The per-row button is right for picking one interesting error out of a log.
 * It is the wrong shape for a page that threw six on load, which is the case you
 * actually want the agent to look at: six clicks send six separate blocks with
 * nothing saying they arrived together.
 *
 * Duplicates collapse because a render loop repeats one message hundreds of
 * times. The count carries the information; the repetition only carries length.
 */

export type ConsoleLine = { level: string; message: string }

/**
 * How many distinct errors are worth sending.
 *
 * Dedup handles a render loop repeating one message; it does nothing for a page
 * that throws five hundred *different* errors, which is an ordinary state for a
 * broken build. Pasting all of them buries the prompt, and the first ones — the
 * likely cause — scroll off the top of what the agent reads.
 */
const MAX_DISTINCT = 40

export type ConsoleDigest = {
  /** How many distinct messages, which is what the header reports. */
  distinct: number
  /** How many lines there were in total, before collapsing. */
  total: number
  /** Distinct errors left out of the body, so the caller cannot imply completeness. */
  omitted: number
  body: string
}

export function digestConsoleErrors(logs: readonly ConsoleLine[]): ConsoleDigest | undefined {
  const errors = logs.filter((log) => log.level === "error" && log.message.trim())
  if (errors.length === 0) return undefined

  const counted = new Map<string, number>()
  for (const log of errors) {
    const message = log.message.trim()
    counted.set(message, (counted.get(message) ?? 0) + 1)
  }

  // Order of first appearance: the first error is usually the cause and the rest
  // are its consequences, and sorting by count would bury it. Which is also why
  // the cap keeps the head rather than a sample.
  const shown = [...counted.entries()].slice(0, MAX_DISTINCT)
  const body = shown.map(([message, count]) => (count > 1 ? `${message}\n  (×${count})` : message)).join("\n\n")

  return {
    distinct: counted.size,
    total: errors.length,
    omitted: Math.max(0, counted.size - shown.length),
    body,
  }
}

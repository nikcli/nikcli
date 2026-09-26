/**
 * Opt-in trace for the background plugin: set `NIKCLI_BG_DEBUG` to a file path
 * and every call appends a line to it.
 *
 * `detail` is a thunk on purpose. Several call sites sit on the render path,
 * and building their payload (a JSON dump of the frame state, a probe of a
 * cell) each frame just to throw it away when tracing is off was measurable
 * garbage in the hot loop. With tracing off the thunk is never invoked.
 */
import fs from "fs"

const FILE = process.env.NIKCLI_BG_DEBUG

/** Whether a trace file is configured. */
export const debugging = Boolean(FILE)

export function dbg(label: string, detail?: () => unknown) {
  if (!FILE) return
  try {
    const value = detail?.()
    const suffix = value === undefined ? "" : ` ${typeof value === "string" ? value : JSON.stringify(value)}`
    fs.appendFileSync(FILE, `${label}${suffix}\n`)
  } catch {}
}

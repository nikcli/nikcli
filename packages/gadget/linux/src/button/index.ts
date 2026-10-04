/**
 * Buttons: a press on the device becomes `ui.press { key }` in nikcli.
 *
 * A driver owns the hardware and reports presses by key; the runtime posts
 * them. `keyboard` maps terminal keys to button keys for development and for
 * a gadget that is really a keyboard. `gpio` polls Linux sysfs pins — the
 * lowest common denominator on a Pi: no library, no root once the pins are
 * exported, and a 20 ms poll is far below a human press.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"

export interface Button {
  readonly keys: readonly string[]
  /** Start reporting presses. Returns the stop function. */
  start(onPress: (key: string) => void): () => void
}

export interface KeyboardOptions {
  /** Button key → terminal key. `enter`, `space`, `escape` or a single character. */
  readonly keys: Readonly<Record<string, string>>
  readonly stdin?: NodeJS.ReadStream
}

const NAMED: Record<string, string> = { enter: "\r", space: " ", escape: "\u001b", tab: "\t" }

export function keyboard(options: KeyboardOptions): Button {
  const keys = Object.keys(options.keys)
  const lookup = new Map<string, string>()
  for (const [key, char] of Object.entries(options.keys)) lookup.set(NAMED[char] ?? char, key)
  return {
    keys,
    start(onPress) {
      const stdin = options.stdin ?? process.stdin
      const raw = stdin.isTTY ? stdin.isRaw : undefined
      if (stdin.isTTY) stdin.setRawMode(true)
      stdin.resume()
      stdin.setEncoding("utf8")
      const listener = (chunk: string) => {
        for (const char of chunk) {
          if (char === "\u0003") {
            process.kill(process.pid, "SIGINT")
            return
          }
          const key = lookup.get(char)
          if (key) onPress(key)
        }
      }
      stdin.on("data", listener)
      return () => {
        stdin.off("data", listener)
        if (stdin.isTTY && raw !== undefined) stdin.setRawMode(raw)
        stdin.pause()
      }
    },
  }
}

export interface GpioOptions {
  /** Button key → BCM pin number. */
  readonly pins: Readonly<Record<string, number>>
  /** A press reads 0 (pull-up, button to ground) unless `activeHigh`. */
  readonly activeHigh?: boolean
  readonly pollMs?: number
  readonly debounceMs?: number
  readonly sysfs?: string
}

export function gpio(options: GpioOptions): Button {
  const root = options.sysfs ?? "/sys/class/gpio"
  const keys = Object.keys(options.pins)
  const pollMs = options.pollMs ?? 20
  const debounceMs = options.debounceMs ?? 50
  const pressed = options.activeHigh ? "1" : "0"
  return {
    keys,
    start(onPress) {
      for (const pin of Object.values(options.pins)) {
        const dir = `${root}/gpio${pin}`
        if (!existsSync(dir)) writeFileSync(`${root}/export`, String(pin))
        writeFileSync(`${dir}/direction`, "in")
      }
      const last = new Map<string, { value: string; at: number }>()
      const timer = setInterval(() => {
        const now = Date.now()
        for (const [key, pin] of Object.entries(options.pins)) {
          let value: string
          try {
            value = readFileSync(`${root}/gpio${pin}/value`, "utf8").trim()
          } catch {
            continue
          }
          const previous = last.get(key)
          if (!previous) {
            last.set(key, { value, at: now })
            continue
          }
          if (value === previous.value) continue
          if (now - previous.at < debounceMs) continue
          last.set(key, { value, at: now })
          if (value === pressed) onPress(key)
        }
      }, pollMs)
      return () => clearInterval(timer)
    },
  }
}

/** Compose drivers: a gadget with a GPIO button and a keyboard fallback reports both. */
export function all(...drivers: readonly Button[]): Button {
  return {
    keys: [...new Set(drivers.flatMap((driver) => driver.keys))],
    start(onPress) {
      const stops = drivers.map((driver) => driver.start(onPress))
      return () => stops.forEach((stop) => stop())
    },
  }
}

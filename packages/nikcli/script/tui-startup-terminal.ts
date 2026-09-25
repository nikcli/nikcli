import type { NativePty } from "@nikcli-ai/util/pty"

export function startupTerminalMode(relay: string | undefined, inputTTY: boolean, outputTTY: boolean) {
  if (relay !== undefined && relay !== "0" && relay !== "1") {
    throw new Error("TERMINAL_RELAY must be 0 or 1")
  }
  if (relay !== "1") return "non-answering-pty" as const
  if (!inputTTY || !outputTTY) {
    throw new Error("TERMINAL_RELAY=1 requires attached terminal stdin and stdout; TERM alone is not evidence")
  }
  return "attached-terminal" as const
}

/** Forward actual terminal replies, not synthetic capability responses. */
export function relayStartupTerminal(pty: NativePty): () => void {
  startupTerminalMode("1", Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY))
  const raw = process.stdin.isRaw
  const paused = process.stdin.isPaused()
  let active = true
  const input = (data: Buffer) => pty.write(data.toString())
  process.stdin.setRawMode(true)
  process.stdin.on("data", input)
  process.stdin.resume()
  pty.onData((data) => {
    if (active) process.stdout.write(data)
  })
  return () => {
    if (!active) return
    active = false
    process.stdin.off("data", input)
    process.stdin.setRawMode(raw)
    if (paused) process.stdin.pause()
    process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[0m")
  }
}

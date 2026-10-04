/**
 * `system.run` — the command a sysadmin gadget is for.
 *
 * Runs as the account the SDK runs as, with exactly its permissions: there is
 * no privilege step here and none in the bridge. The nikcli side asks the
 * operator before every call unless a rule allows it, which is where the
 * safety lives — a gadget cannot approve itself.
 */
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import type { CommandHandler } from "../gadget.ts"

export interface SystemRunArgs {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string
}

export const spec = {
  name: "system.run",
  description:
    "Run a program on the gadget and return its stdout, stderr and exit code. argv[0] is the program; no shell is involved unless you run one.",
  args: {
    type: "object",
    properties: {
      argv: { type: "array", items: { type: "string" }, minItems: 1, description: "Program and arguments" },
      cwd: { type: "string", description: "Working directory" },
      env: { type: "object", additionalProperties: { type: "string" }, description: "Extra environment variables" },
      stdin: { type: "string", description: "Text to write to the program's stdin" },
    },
    required: ["argv"],
  },
  timeoutMs: 60_000,
} as const

export const run: CommandHandler<SystemRunArgs> = async (args, ctx) => {
  if (!Array.isArray(args.argv) || args.argv.length === 0 || args.argv.some((item) => typeof item !== "string")) {
    return { output: "argv must be a non-empty array of strings", isError: true }
  }
  const [program, ...rest] = args.argv as [string, ...string[]]
  const child = spawn(program, rest, {
    cwd: args.cwd,
    env: { ...process.env, ...(args.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    signal: ctx.signal,
  })
  const limit = ctx.maxOutputBytes
  let stdout = ""
  let stderr = ""
  let total = 0 // bytes kept, both streams together
  let truncated = false
  // A decoder per stream: a multi-byte character can straddle two chunks, and counting characters would undercount bytes.
  const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") }
  const collect = (chunk: Buffer, which: "out" | "err") => {
    const room = limit - total
    if (room <= 0) {
      truncated = true
      return
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
    if (kept.length < chunk.length) truncated = true
    total += kept.length
    const text = decoders[which].write(kept)
    if (which === "out") stdout += text
    else stderr += text
  }
  // A program that exits (or never starts) before reading stdin closes the pipe: EPIPE on an unhandled stream error would take the whole gadget down.
  child.stdin.on("error", () => undefined)
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, "out"))
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, "err"))
  if (args.stdin !== undefined) child.stdin.end(args.stdin)
  else child.stdin.end()
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.name === "AbortError") return 124
    stderr += `${error.message}\n`
    return 127
  })
  const output = stderr ? `${stdout}${stdout && !stdout.endsWith("\n") ? "\n" : ""}[stderr]\n${stderr}` : stdout
  return {
    output: truncated ? `${output}\n[output truncated at ${limit} bytes]` : output,
    exitCode,
    isError: exitCode !== 0,
    truncated,
  }
}

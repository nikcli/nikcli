/**
 * `file.read` and `file.write`, 64 KB at a time.
 *
 * A read returns one chunk and says where the next one starts; a write lands
 * in `<path>.nikcli-part` and replaces the target only when the caller says
 * the last chunk is in, so an interrupted transfer never leaves a half file
 * under the real name.
 */
import { closeSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { LIMITS } from "../protocol.ts"
import type { CommandHandler } from "../gadget.ts"

export interface FileReadArgs {
  readonly path: string
  readonly offset?: number
  readonly length?: number
  readonly encoding?: "utf8" | "base64"
}

export interface FileWriteArgs {
  readonly path: string
  readonly content: string
  readonly encoding?: "utf8" | "base64"
  /** Append to the part file instead of starting it over. */
  readonly append?: boolean
  /** The last chunk: rename the part file over `path`. Default true. */
  readonly final?: boolean
  readonly mode?: number
}

export const readSpec = {
  name: "file.read",
  description: `Read a file on the gadget, ${LIMITS.CHUNK_BYTES} bytes at a time. The reply reports size, the next offset and eof.`,
  args: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path" },
      offset: { type: "integer", minimum: 0, description: "Byte offset to start at" },
      length: { type: "integer", minimum: 1, maximum: LIMITS.CHUNK_BYTES, description: "Bytes to read" },
      encoding: { type: "string", enum: ["utf8", "base64"], description: "How the bytes are returned" },
    },
    required: ["path"],
  },
  timeoutMs: 10_000,
} as const

export const writeSpec = {
  name: "file.write",
  description: `Write a file on the gadget, ${LIMITS.CHUNK_BYTES} bytes at a time. Chunks accumulate in a part file; the final chunk replaces the target atomically.`,
  args: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path" },
      content: { type: "string", description: "Chunk content" },
      encoding: { type: "string", enum: ["utf8", "base64"], description: "How content is encoded" },
      append: { type: "boolean", description: "Append to the part file written by the previous chunk" },
      final: { type: "boolean", description: "This is the last chunk (default true)" },
      mode: { type: "integer", description: "File mode for a new file, e.g. 420 for 0644" },
    },
    required: ["path", "content"],
  },
  timeoutMs: 10_000,
} as const

function resolveTarget(target: string, roots: readonly string[] | undefined): string | undefined {
  const absolute = path.resolve(target)
  if (!roots || roots.length === 0) return absolute
  const allowed = roots.some((root) => {
    const base = path.resolve(root)
    return absolute === base || absolute.startsWith(base + path.sep)
  })
  return allowed ? absolute : undefined
}

export const read =
  (roots?: readonly string[]): CommandHandler<FileReadArgs> =>
  async (args) => {
    const target = resolveTarget(args.path, roots)
    if (!target) return { output: `${args.path} is outside the directories this gadget serves`, isError: true }
    const length = Math.min(LIMITS.CHUNK_BYTES, Math.max(1, args.length ?? LIMITS.CHUNK_BYTES))
    const offset = Math.max(0, args.offset ?? 0)
    let fd: number | undefined
    try {
      const size = statSync(target).size
      fd = openSync(target, "r")
      const buffer = Buffer.alloc(length)
      const read = readSync(fd, buffer, 0, length, offset)
      const chunk = buffer.subarray(0, read)
      const encoding = args.encoding ?? "utf8"
      return {
        output: JSON.stringify({
          path: target,
          size,
          offset,
          length: read,
          next: offset + read,
          eof: offset + read >= size,
          encoding,
          content: chunk.toString(encoding),
        }),
      }
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), isError: true }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

export const write =
  (roots?: readonly string[]): CommandHandler<FileWriteArgs> =>
  async (args) => {
    const target = resolveTarget(args.path, roots)
    if (!target) return { output: `${args.path} is outside the directories this gadget serves`, isError: true }
    const bytes = Buffer.from(args.content, args.encoding ?? "utf8")
    if (bytes.byteLength > LIMITS.CHUNK_BYTES) {
      return { output: `chunk of ${bytes.byteLength} bytes exceeds ${LIMITS.CHUNK_BYTES}`, isError: true }
    }
    const part = `${target}.nikcli-part`
    try {
      await mkdir(path.dirname(target), { recursive: true })
      const fd = openSync(part, args.append ? "a" : "w", args.mode ?? 0o644)
      try {
        writeSync(fd, bytes)
      } finally {
        closeSync(fd)
      }
      const final = args.final !== false
      if (final) renameSync(part, target)
      const size = statSync(final ? target : part).size
      return { output: JSON.stringify({ path: target, written: bytes.byteLength, size, final }) }
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), isError: true }
    }
  }

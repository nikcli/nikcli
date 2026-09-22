import { Effect, Schema } from "effect"
import { zod } from "@nikcli-ai/util/effect-zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Identifier } from "@nikcli-ai/util/id"
import { assertExternalDirectory } from "./external-directory"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Log } from "@nikcli-ai/util/log"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 100_000

function runLSP<A, E>(effect: Effect.Effect<A, E, LSP.Service>) {
  return runPromiseWithLayer(LSP.defaultLayer, withCurrentInstance(effect))
}

const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "The absolute path to the file or directory to read",
  }),
  offset: Schema.optional(Schema.NumberFromString).annotate({
    description: "The line or directory entry to start reading from (1-based)",
  }),
  limit: Schema.optional(Schema.NumberFromString).annotate({
    description: "The maximum number of lines or directory entries to read (defaults to 2000)",
  }),
})

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: zod(Parameters),
  async execute(params, ctx) {
    if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 1)) {
      throw new Error("offset must be a positive integer")
    }
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
      throw new Error("limit must be a positive integer")
    }
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      // The instance, not `process.cwd()`: the background service runs every
      // project from one process, so its cwd is none of them. `write` and
      // `edit` already resolve this way.
      filepath = path.join(ctx.instance.directory, filepath)
    }
    const title = path.relative(ctx.instance.worktree, filepath)

    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
    })

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    const stat = await fs.promises.stat(filepath).catch(() => undefined)
    if (!stat) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      // The parent may not exist either. Reading it unguarded surfaced a raw
      // ENOENT for the *directory*, which reads as an unrelated failure; fall
      // back to the plain not-found message for the path the model asked for.
      let dirEntries: string[] = []
      try {
        dirEntries = fs.readdirSync(dir)
      } catch {
        throw new Error(`File not found: ${filepath}`)
      }
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    if (stat.isDirectory()) {
      return readDirectory(filepath, title, params.offset, params.limit)
    }

    const file = Bun.file(filepath)

    const isImage =
      file.type.startsWith("image/") && file.type !== "image/svg+xml" && file.type !== "image/vnd.fastbidsheet"
    const isPdf = file.type === "application/pdf"
    if (isImage || isPdf) {
      if (stat.size > MAX_MEDIA_INGEST_BYTES) {
        throw new Error(`Media exceeds ${MAX_MEDIA_INGEST_BYTES} byte ingestion limit: ${filepath}`)
      }
      const media = await file.slice(0, MAX_MEDIA_INGEST_BYTES + 1).bytes()
      if (media.byteLength > MAX_MEDIA_INGEST_BYTES) {
        throw new Error(`Media exceeds ${MAX_MEDIA_INGEST_BYTES} byte ingestion limit: ${filepath}`)
      }
      const mime = file.type
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
        },
        attachments: [
          {
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(media).toString("base64")}`,
          },
        ],
      }
    }

    const isBinary = await isBinaryFile(filepath, file)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const limit = Math.min(params.limit ?? DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT)
    const offset = params.offset ?? 1
    const page = await readTextPage(filepath, file, offset, limit)
    const raw = page.lines

    const content = raw.map((line, index) => {
      return `${index + offset}: ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    const lastReadLine = offset + raw.length - 1
    const truncated = page.hasMore
    const heading =
      raw.length === 0 ? `Read file ${filepath}, 0 lines` : `Read file ${filepath}, lines ${offset}-${lastReadLine}`

    let output = "<file>\n"
    output += heading
    output += "\n"
    output += content.join("\n")

    if (page.truncatedByBytes) {
      output += `\n\n[Output truncated at ${MAX_BYTES} bytes. Continue reading with offset: ${lastReadLine + 1}]`
    } else if (page.hasMore) {
      output += `\n\n[Output truncated. Continue reading with offset: ${lastReadLine + 1}]`
    } else {
      output += `\n\n(End of file - total ${page.totalLines} lines)`
    }
    output += "\n</file>"

    void runLSP(
      Effect.gen(function* () {
        const lsp = yield* LSP.Service
        yield* lsp.touchFile(filepath, false)
      }),
    ).catch((error) => {
      // Opencode #27895: LSP warm-up is best-effort. A failed warm-up must
      // not break an otherwise successful file read. Carry the InstanceRef
      // into the fork so the Effect resolves the LSP service in the right
      // instance scope (otherwise `withCurrentInstance` falls back to a
      // detached scope and silently no-ops).
      Log.Default.warn("lsp warmup failed", { filepath, error })
    })
    await FileTime.read(ctx.sessionID, filepath)

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
      },
    }
  },
})

async function readDirectory(filepath: string, title: string, requestedOffset?: number, requestedLimit?: number) {
  const offset = requestedOffset ?? 1
  const limit = Math.min(requestedLimit ?? DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT)
  const entries: Array<{ name: string; directory: boolean }> = []
  const directory = await fs.promises.opendir(filepath)
  for await (const entry of directory) {
    if (!(entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())) continue
    if (entries.length >= MAX_DIRECTORY_ENTRIES) {
      throw new Error(`Directory exceeds ${MAX_DIRECTORY_ENTRIES} entry read limit: ${filepath}`)
    }
    entries.push({
      name: entry.name + (entry.isDirectory() ? path.sep : ""),
      directory: entry.isDirectory(),
    })
  }
  entries.sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1))

  const start = offset - 1
  if (start >= entries.length && !(start === 0 && entries.length === 0)) {
    throw new Error(`Offset ${offset} is out of range for this directory (${entries.length} entries)`)
  }

  const selected: string[] = []
  let bytes = Buffer.byteLength(`Read directory ${filepath}, entries ${offset}-${offset + limit - 1}\n`)
  for (let index = start; index < entries.length && selected.length < limit; index++) {
    const name = entries[index]!.name
    const size = Buffer.byteLength(name, "utf-8") + 1
    const continuationReserve = Buffer.byteLength(
      `[Output truncated. Continue reading with offset: ${offset + selected.length + 1}]`,
    )
    if (bytes + size + continuationReserve > MAX_BYTES) break
    selected.push(name)
    bytes += size
  }
  const next = offset + selected.length
  const truncated = start + selected.length < entries.length
  const heading =
    selected.length === 0
      ? `Read directory ${filepath}, 0 entries`
      : `Read directory ${filepath}, entries ${offset}-${offset + selected.length - 1}`
  const continuation = truncated ? `\n[Output truncated. Continue reading with offset: ${next}]` : ""
  const output = [heading, ...selected].join("\n") + continuation

  return {
    title,
    output,
    metadata: {
      preview: selected.slice(0, 20).join("\n"),
      truncated,
    },
  }
}

async function readTextPage(filepath: string, file: Bun.BunFile, offset: number, limit: number) {
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const lines: string[] = []
  let pending = ""
  let discardPending = false
  let lineNumber = 1
  let bytes = 0
  let hasMore = false
  let truncatedByBytes = false
  let reachedEnd = false

  const append = (input: string) => {
    if (lineNumber < offset) {
      lineNumber++
      return true
    }
    if (lines.length >= limit) {
      hasMore = true
      return false
    }

    const line = input.length > MAX_LINE_LENGTH ? input.substring(0, MAX_LINE_LENGTH) + "..." : input
    const size = Buffer.byteLength(line, "utf-8") + (lines.length > 0 ? 1 : 0)
    if (bytes + size > MAX_BYTES) {
      hasMore = true
      truncatedByBytes = true
      return false
    }
    lines.push(line)
    bytes += size
    lineNumber++
    return true
  }

  const consume = (input: string) => {
    let text = input
    while (true) {
      const newline = text.indexOf("\n")
      if (newline === -1) {
        if (!discardPending) {
          pending += text
          if (pending.length > MAX_LINE_LENGTH) {
            pending = pending.slice(0, MAX_LINE_LENGTH + 1)
            discardPending = true
          }
        }
        return true
      }

      const line = pending + (discardPending ? "" : text.slice(0, newline))
      pending = ""
      discardPending = false
      text = text.slice(newline + 1)
      if (!append(line.endsWith("\r") ? line.slice(0, -1) : line)) return false
    }
  }

  try {
    read: while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        reachedEnd = true
        break
      }
      if (chunk.value.includes(0)) throw new Error(`Cannot read binary file: ${filepath}`)
      if (!consume(decoder.decode(chunk.value, { stream: true }))) break read
    }
    if (reachedEnd) {
      consume(decoder.decode())
      if (!append(pending.endsWith("\r") ? pending.slice(0, -1) : pending)) hasMore = true
    } else {
      await reader.cancel()
    }
  } finally {
    reader.releaseLock()
  }

  const totalLines = lineNumber - 1
  if (lines.length === 0 && offset > totalLines) {
    throw new Error(`Offset ${offset} is out of range for this file (${totalLines} lines)`)
  }
  return { lines, hasMore, truncatedByBytes, totalLines }
}

async function isBinaryFile(filepath: string, file: Bun.BunFile): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const stat = await file.stat()
  const fileSize = stat.size
  if (fileSize === 0) return false

  const bufferSize = Math.min(4096, fileSize)
  const buffer = await file.slice(0, bufferSize).arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer.slice(0, bufferSize))

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  return nonPrintableCount / bytes.length > 0.3
}

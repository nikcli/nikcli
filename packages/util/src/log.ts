import path from "path"
import fs from "fs/promises"
import { openSync, writeSync } from "fs"
import { Global } from "./global"
import { zod } from "./effect-zod"
import { isRedactedKey, REDACTED, redactString, safeStringify } from "./redact"
import { Schema } from "effect"

export namespace Log {
  const LevelSchema = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
    identifier: "LogLevel",
    description: "Log level",
  })
  export const Level = zod(LevelSchema)
  export type Level = Schema.Schema.Type<typeof LevelSchema>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"

  /** Exposes internal log level at runtime */
  export function currentLevel(): Level {
    return level
  }

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  export type Logger = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  export const Default = create({ service: "default" })

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
    /**
     * Join this existing log file instead of starting one: it is appended to,
     * never truncated. The TUI's server worker passes the main process's file
     * here (via `FILE_ENV`) — opening its own truncated the main process's log,
     * which is why every stalled start in `specs/effect-tui/00-startup-hang.md`
     * left an empty `dev.log` behind.
     */
    file?: string
  }

  /** Environment variable carrying the main process's log file to its worker. */
  export const FILE_ENV = "NIKCLI_LOG_FILE"

  let logpath = ""
  export function file() {
    return logpath
  }
  let write = (msg: any) => {
    process.stderr.write(msg)
    return msg.length
  }

  export async function init(options: Options) {
    if (options.level) level = options.level
    cleanup(Global.Path.log)
    if (options.print) return
    if (options.file) {
      logpath = options.file
    } else {
      logpath = path.join(
        Global.Path.log,
        options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
      )
      await fs.truncate(logpath).catch(() => {})
    }
    // Append mode, for every writer: a file two threads write to — the TUI and
    // its server worker — must not have each overwrite the other from its own
    // offset. O_APPEND makes every write land at the current end.
    const fd = openSync(logpath, "a")
    write = (msg: any) => {
      writeSync(fd, msg)
      return msg.length
    }
  }

  async function cleanup(dir: string) {
    const glob = new Bun.Glob("????-??-??T??????.log")
    // The log dir may not exist yet; scanning a missing dir throws ENOENT
    // (surfacing as an unhandled rejection since cleanup runs in the background).
    const files = await Array.fromAsync(
      glob.scan({
        cwd: dir,
        absolute: true,
      }),
    ).catch(() => [] as string[])
    if (files.length <= 5) return

    const filesToDelete = files.slice(0, -10)
    await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})))
  }

  function formatError(error: Error, depth = 0): string {
    // Run the message through `redactString` so URLs and token-shaped
    // substrings in error chains (e.g. OAuth callbacks) are masked
    // before they hit the log buffer.
    const result = safeStringify(error.message)
    return error.cause instanceof Error && depth < 10
      ? result + " Caused by: " + formatError(error.cause, depth + 1)
      : result
  }

  let last = Date.now()
  export function create(tags?: Record<string, any>) {
    tags = tags || {}

    const service = tags["service"]
    if (service && typeof service === "string") {
      const cached = loggers.get(service)
      if (cached) {
        return cached
      }
    }

    function build(message: any, extra?: Record<string, any>) {
      // Redaction policy: keys named in `REDACT_KEYS` get replaced with
      // "[REDACTED]"; URLs get their query credentials stripped; token/
      // key/JWT-shaped substrings are masked. `safeStringify` also
      // breaks cycles and caps depth/leaf so a single log line stays
      // bounded. The flag is consulted per-write so flipping it in
      // production does not require a restart.
      const redact = process.env.NIKCLI_LOG_REDACT !== "0"
      const stringify = (value: unknown) => (redact ? safeStringify(value) : JSON.stringify(value))
      const prefix = Object.entries({
        ...tags,
        ...extra,
      })
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const prefix = `${key}=`
          if (value instanceof Error) return prefix + formatError(value)
          if (typeof value === "object") return prefix + stringify(value)
          // Scalars are written without JSON quoting, which used to mean they
          // skipped redaction entirely: a flat `{ token: "…" }` or an OAuth
          // `state` reached the buffer verbatim while the same pair nested one
          // level deep was masked. Apply the object walk's own rule here.
          if (!redact) return prefix + value
          if (isRedactedKey(key)) return prefix + REDACTED
          return prefix + (typeof value === "string" ? redactString(value) : value)
        })
        .join(" ")
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
    }
    const result: Logger = {
      debug(message?: any, extra?: Record<string, any>) {
        if (shouldLog("DEBUG")) {
          write("DEBUG " + build(message, extra))
        }
      },
      info(message?: any, extra?: Record<string, any>) {
        if (shouldLog("INFO")) {
          write("INFO  " + build(message, extra))
        }
      },
      error(message?: any, extra?: Record<string, any>) {
        if (shouldLog("ERROR")) {
          write("ERROR " + build(message, extra))
        }
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (shouldLog("WARN")) {
          write("WARN  " + build(message, extra))
        }
      },
      tag(key: string, value: string) {
        if (tags) tags[key] = value
        return result
      },
      clone() {
        return Log.create({ ...tags })
      },
      time(message: string, extra?: Record<string, any>) {
        const now = Date.now()
        result.info(message, { status: "started", ...extra })
        function stop() {
          result.info(message, {
            status: "completed",
            duration: Date.now() - now,
            ...extra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }

    if (service && typeof service === "string") {
      loggers.set(service, result)
    }

    return result
  }
}

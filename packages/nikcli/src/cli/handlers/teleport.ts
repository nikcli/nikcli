import { Option } from "effect"
import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { Effect } from "effect"
import os from "os"
import path from "path"
import * as prompts from "@clack/prompts"
import { Session } from "@/session"
import { Config } from "@/config/config"
import { Global } from "@nikcli-ai/util/global"
import { bootstrap } from "@/cli/bootstrap"
import { UI } from "@/cli/ui"
import { ExitCode } from "@/cli/exit-code"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { createWorkspaceArchive, uploadWorkspaceArchive } from "@nikcli-ai/util/teleport-archive"
import type { MessageV2 } from "@/session/message-v2"

export function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
  return runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))
}

export function configGet() {
  return runPromiseWithLayer(
    Config.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.get()
      }),
    ),
  )
}

/**
 * Normalize a user-entered server URL into a base origin we can append
 * `/mobile/teleport` to. Accepts values with or without a scheme/trailing slash.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let value = raw.trim()
  if (!value) return null
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  try {
    const url = new URL(value)
    return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/mobile(\/teleport)?$/, "")
  } catch {
    return null
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

export async function saveTeleportDefaults(url: string, token: string) {
  const configPath = path.join(Global.Path.config, "nikcli.json")
  const current = await Bun.file(configPath)
    .text()
    .catch(() => "{}")
  const parsed = JSON.parse(current || "{}")
  parsed.teleport = { url, token }
  await Bun.write(configPath, JSON.stringify(parsed, null, 2))
}

export default Runtime.handler(Commands.commands["teleport"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    sessionID: Option.getOrUndefined(input["sessionID"]),
    url: Option.getOrUndefined(input["url"]),
    token: Option.getOrUndefined(input["token"]),
    content: input["content"],
    git: input["git"],
    save: input["save"],
  }
  await bootstrap(process.cwd(), async () => {
    const config = await configGet().catch(() => undefined)
    const saved = (config as { teleport?: { url?: string; token?: string } } | undefined)?.teleport

    // Resolve target: flag → env → saved config → interactive prompt.
    let url = (args.url as string | undefined) ?? process.env.NIKCLI_TELEPORT_URL ?? saved?.url
    let token = (args.token as string | undefined) ?? process.env.NIKCLI_TELEPORT_TOKEN ?? saved?.token

    if (!url && process.stderr.isTTY) {
      const answer = await prompts.text({
        message: "Remote server URL",
        placeholder: "https://my-app.up.railway.app",
        output: process.stderr,
      })
      if (prompts.isCancel(answer)) throw new UI.CancelledError()
      url = answer as string
    }
    const base = url ? normalizeBaseUrl(url) : null
    if (!base) {
      throw ExitCode.fail("A valid --url (or NIKCLI_TELEPORT_URL) is required", ExitCode.Usage)
    }

    if (!token && process.stderr.isTTY) {
      const answer = await prompts.password({
        message: "Mobile auth token",
        output: process.stderr,
      })
      if (prompts.isCancel(answer)) throw new UI.CancelledError()
      token = answer as string
    }
    token = token?.trim()
    if (!token) {
      throw ExitCode.fail("A --token (or NIKCLI_TELEPORT_TOKEN) is required", ExitCode.Usage)
    }

    // Resolve which session to teleport.
    let sessionID = args.sessionID as string | undefined
    if (!sessionID) {
      const sessions = await runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const iterable = yield* session.list()
          return yield* Effect.promise(() => Array.fromAsync(iterable))
        }),
      )
      if (sessions.length === 0) {
        throw ExitCode.fail("No sessions found to teleport")
      }
      sessions.sort((a: Session.Info, b: Session.Info) => b.time.updated - a.time.updated)

      if (!process.stderr.isTTY) {
        sessionID = sessions[0]!.id
      } else {
        const selected = await prompts.autocomplete({
          message: "Select session to teleport",
          maxItems: 10,
          options: sessions.map((session: Session.Info) => ({
            label: session.title,
            value: session.id,
            hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
          })),
          output: process.stderr,
        })
        if (prompts.isCancel(selected)) throw new UI.CancelledError()
        sessionID = selected as string
      }
    }

    let info: Session.Info
    let messages: MessageV2.WithParts[]
    try {
      const result = await runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.get(sessionID!)
          const messages = yield* session.messages({ sessionID: sessionID! })
          return { info, messages }
        }),
      )
      info = result.info
      messages = result.messages
    } catch {
      throw ExitCode.fail(`Session not found: ${sessionID}`)
    }

    // Archive only what's needed to keep coding: non-ignored source/text files,
    // skipping binaries and (by default) the heavy .git history. Streamed in
    // chunks so it never blows the request body limit. Opt out with --no-content.
    let archive: Awaited<ReturnType<typeof createWorkspaceArchive>> = null
    let uploadID: string | undefined
    if (args.content !== false) {
      process.stderr.write(`Archiving working directory ${info.directory}...${os.EOL}`)
      archive = await createWorkspaceArchive(info.directory, { includeGit: Boolean(args.git) }).catch((error) => {
        process.stderr.write(
          `Could not archive working directory: ${error instanceof Error ? error.message : String(error)}${os.EOL}`,
        )
        return null
      })
      if (archive) {
        process.stderr.write(
          `Workspace archive: ${formatBytes(archive.bytes)} — ${archive.fileCount} files${archive.skipped ? `, ${archive.skipped} binary/large skipped` : ""}${archive.includedGit ? ", incl. .git" : ""}${os.EOL}`,
        )
        try {
          uploadID = await uploadWorkspaceArchive({
            base,
            token,
            archivePath: archive.path,
            onProgress: (sent, total) => {
              const pct = total ? Math.floor((sent / total) * 100) : 100
              process.stderr.write(
                `\rUploading workspace… ${pct}% (${(sent / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB)`,
              )
            },
          })
          process.stderr.write(os.EOL)
        } catch (error) {
          await archive.cleanup()
          throw ExitCode.fail(`Workspace upload failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          await archive.cleanup()
        }
      }
    }

    const payload = JSON.stringify({
      title: info.title,
      name: path.basename(info.directory),
      origin: `${os.hostname()}:${info.directory}`,
      permission: info.permission,
      messages,
      uploadID,
    })

    process.stderr.write(
      `Teleporting "${info.title}" (${messages.length} messages${uploadID ? " + workspace" : ""}) to ${new URL(base).host}...${os.EOL}`,
    )

    let response: Response
    try {
      response = await fetch(`${base}/mobile/teleport`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: payload,
      })
    } catch (error) {
      throw ExitCode.fail(
        `Failed to reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
        ExitCode.Unavailable,
      )
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw ExitCode.fail(
        response.status === 401
          ? "Unauthorized — check the auth token"
          : `Server error ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      )
    }

    const result = (await response.json().catch(() => null)) as {
      sessionID?: string
      messageCount?: number
      directory?: string
      workspace?: boolean
    } | null

    if (args.save !== false) {
      await saveTeleportDefaults(base, token).catch(() => undefined)
    }

    UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Session teleported" + UI.Style.TEXT_NORMAL)
    if (result?.sessionID) {
      UI.println(`  remote session: ${result.sessionID}`)
    }
    UI.println(`  messages:       ${result?.messageCount ?? messages.length}`)
    UI.println(`  workspace:      ${result?.workspace ? `cloned → ${result.directory ?? "(remote)"}` : "not sent"}`)
    UI.println(`  server:         ${base}`)
    UI.println("")
    UI.println(UI.Style.TEXT_DIM + "  Open the nikcli mobile app to continue this session." + UI.Style.TEXT_NORMAL)
  })
})

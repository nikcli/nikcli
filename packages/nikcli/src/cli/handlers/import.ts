import { Runtime } from "../framework/runtime"
import { Effect } from "effect"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { Session } from "@/session"
import { bootstrap } from "@/cli/bootstrap"
import { SessionRepo } from "@/session/repo"
import { SessionV2Write } from "@/session/v2/write"
import { EOL } from "os"

export const SHARE_ID = /^[a-zA-Z0-9_-]+$/

export function resolveEnterpriseOrigin(hostname: string) {
  if (hostname === "nikcli-ai.dev") return "https://s.nikcli-ai.dev"
  if (hostname === "dev.nikcli-ai.dev") return "https://dev.s.nikcli-ai.dev"
  if (hostname.endsWith(".dev.nikcli-ai.dev")) {
    const stage = hostname.slice(0, -".dev.nikcli-ai.dev".length)
    if (stage) return `https://${stage}.dev.s.nikcli-ai.dev`
  }
}

export function parseShareURL(input: string) {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return
  }
  const parts = parsed.pathname.split("/").filter(Boolean)
  if (parts.length !== 2) return

  const [prefix, shareID] = parts
  if (prefix !== "share" && prefix !== "s") return
  if (!SHARE_ID.test(shareID)) return

  const origins = new Set<string>()

  const enterpriseOrigin = resolveEnterpriseOrigin(parsed.hostname)
  if (enterpriseOrigin) origins.add(enterpriseOrigin)
  origins.add(parsed.origin)

  return {
    shareID,
    origins: Array.from(origins),
  }
}

export async function fetchSharePayload(origins: string[], shareID: string) {
  const urls = origins.flatMap((origin) => [`${origin}/api/share/${shareID}/data`, `${origin}/api/share/${shareID}`])

  for (const url of urls) {
    const response = await fetch(url).catch(() => undefined)
    if (!response?.ok) continue
    return response.json().catch(() => undefined)
  }
}

export function normalizeSharePayload(payload: any):
  | {
      info: Session.Info
      messages: Array<{
        info: any
        parts: any[]
      }>
    }
  | undefined {
  if (Array.isArray(payload)) {
    let info: Session.Info | undefined
    const messages = new Map<string, { info?: any; parts: any[] }>()

    for (const item of payload) {
      if (!item || typeof item !== "object") continue
      if (item.type === "session") {
        info = item.data
        continue
      }
      if (item.type === "message") {
        const messageID = item.data?.id
        if (!messageID) continue
        const existing = messages.get(messageID)
        messages.set(messageID, {
          info: item.data,
          parts: existing?.parts ?? [],
        })
        continue
      }
      if (item.type === "part") {
        const messageID = item.data?.messageID
        if (!messageID) continue
        const existing = messages.get(messageID)
        if (existing) {
          existing.parts.push(item.data)
        } else {
          messages.set(messageID, {
            parts: [item.data],
          })
        }
      }
    }

    if (!info) return

    return {
      info,
      messages: Array.from(messages.values())
        .filter((item): item is { info: any; parts: any[] } => Boolean(item.info))
        .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
        .map((item) => ({
          info: item.info,
          parts: item.parts,
        })),
    }
  }

  if (!payload?.info || !payload?.messages) return

  return {
    info: payload.info,
    messages: Object.values(payload.messages).map((msg: any) => {
      const { parts, ...info } = msg
      return {
        info,
        parts,
      }
    }),
  }
}

export default Runtime.handler(Commands.commands["import"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    file: input["file"],
  }
  await bootstrap(process.cwd(), async (instance) => {
    let exportData:
      | {
          info: Session.Info
          messages: Array<{
            info: any
            parts: any[]
          }>
        }
      | undefined

    const isUrl = args.file.startsWith("http://") || args.file.startsWith("https://")

    if (isUrl) {
      const parsed = parseShareURL(args.file)
      if (!parsed) {
        process.stdout.write(
          `Invalid URL format. Expected: https://nikcli-ai.dev/s/<slug> or https://s.nikcli-ai.dev/share/<slug>`,
        )
        process.stdout.write(EOL)
        return
      }

      const payload = await fetchSharePayload(parsed.origins, parsed.shareID)
      const normalized = normalizeSharePayload(payload)

      if (!normalized) {
        process.stdout.write(`Share not found: ${parsed.shareID}`)
        process.stdout.write(EOL)
        return
      }

      exportData = normalized
    } else {
      const file = Bun.file(args.file)
      exportData = await file.json().catch(() => {})
      if (!exportData) {
        process.stdout.write(`File not found: ${args.file}`)
        process.stdout.write(EOL)
        return
      }
    }

    if (!exportData) {
      process.stdout.write(`Failed to read session data`)
      process.stdout.write(EOL)
      return
    }

    // Import into the current project regardless of where the export came from
    Effect.runSync(
      SessionRepo.upsert({
        ...exportData.info,
        projectID: instance.project.id,
      }),
    )

    const projectID = instance.project.id
    for (const msg of exportData.messages) {
      const info = { ...msg.info, sessionID: exportData.info.id }
      const parts = msg.parts.map((part) => ({
        ...part,
        sessionID: exportData.info.id,
        messageID: msg.info.id,
      }))
      // Entry-first persist: a projection throw cannot commit v1 rows the
      // entry table cannot represent.
      SessionV2Write.persist({
        prepared: { info, parts },
        promptData: "",
        projectID,
      })
    }

    process.stdout.write(`Imported session: ${exportData.info.id}`)
    process.stdout.write(EOL)
  })
})

import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ulid } from "ulid"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Log } from "@nikcli-ai/util/log"
import type * as SDK from "@nikcli-ai/sdk/httpapi"
import { Context, Effect, Layer } from "effect"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Database } from "@/database/database"
import { ShareRepo } from "./repo"

export namespace ShareNext {
  const log = Log.create({ service: "share-next" })

  type Data =
    | {
        type: "session"
        data: SDK.Session
      }
    | {
        type: "message"
        data: SDK.Message
      }
    | {
        type: "part"
        data: SDK.Part
      }
    | {
        type: "session_diff"
        data: SDK.FileDiff[]
      }
    | {
        type: "model"
        data: SDK.Model[]
      }

  type StoredShare = Session.ShareInfo

  type LocalShare = {
    id: string
    sessionID: string
    url: string
    time: {
      created: number
      updated: number
    }
    items: Record<string, Data>
  }

  export interface Interface {
    url(): Effect.Effect<string, unknown>
    init(): Effect.Effect<void, unknown>
    create(sessionID: string, input?: { baseUrl?: string }): Effect.Effect<StoredShare, unknown>
    remove(sessionID: string): Effect.Effect<void, unknown>
    publicData(shareID: string): Effect.Effect<Data[] | undefined, unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("ShareNext.Service") {}

  function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
    return runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))
  }

  function configGet() {
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

  function providerGetModel(providerID: string, modelID: string) {
    return runPromiseWithLayer(
      Provider.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          return yield* provider.getModel(providerID, modelID)
        }),
      ),
    )
  }

  async function urlImpl() {
    return configGet().then((x) => x.enterprise?.url ?? "https://s.nikcli-ai.dev")
  }

  function isDisabled() {
    const value = process.env["NIKCLI_DISABLE_SHARE"]
    return value === "true" || value === "1"
  }

  async function initImpl() {
    if (isDisabled()) return
    Bus.subscribe(Session.Event.Updated, async (evt) => {
      await sync(evt.properties.info.id, [
        {
          type: "session",
          data: evt.properties.info,
        },
      ])
    })
    Bus.subscribe(MessageV2.Event.Updated, async (evt) => {
      await sync(evt.properties.info.sessionID, [
        {
          type: "message",
          data: evt.properties.info,
        },
      ])
      if (evt.properties.info.role === "user") {
        await sync(evt.properties.info.sessionID, [
          {
            type: "model",
            // SDK Model.api.url is still required until OpenAPI/SDK regen; runtime models may omit it.
            data: [
              (await providerGetModel(
                evt.properties.info.model.providerID,
                evt.properties.info.model.modelID,
              )) as SDK.Model,
            ],
          },
        ])
      }
    })
    Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
      await sync(evt.properties.part.sessionID, [
        {
          type: "part",
          data: evt.properties.part,
        },
      ])
    })
    Bus.subscribe(Session.Event.Diff, async (evt) => {
      await sync(evt.properties.sessionID, [
        {
          type: "session_diff",
          data: evt.properties.diff,
        },
      ])
    })
  }

  function errorMessage(error: unknown) {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    return String(error)
  }

  function normalizeBaseURL(input: string) {
    const url = new URL(input)
    url.pathname = ""
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  }

  function responseDetail(body: string) {
    const trimmed = body.trim()
    if (!trimmed) return ""

    try {
      const parsed = JSON.parse(trimmed) as any
      const detail =
        parsed?.message ?? parsed?.error?.message ?? parsed?.error ?? parsed?.data?.message ?? parsed?.title
      if (typeof detail === "string" && detail.trim()) return detail.trim()
    } catch {
      // fall back to plain text / html parsing
    }

    const title = trimmed.match(/<title>(.*?)<\/title>/i)?.[1]?.trim()
    if (title) return title

    return trimmed.replace(/\s+/g, " ").slice(0, 200)
  }

  async function requestText(input: string, init: RequestInit) {
    let response: Response
    try {
      response = await fetch(input, init)
    } catch (error) {
      throw new Error(`Share service unreachable: ${errorMessage(error)}`)
    }

    const body = await response.text().catch(() => "")
    if (!response.ok) {
      const detail = responseDetail(body)
      throw new Error(
        detail ? `Share service error (${response.status}): ${detail}` : `Share service error (${response.status})`,
      )
    }

    return body
  }

  async function requestJSON<T>(input: string, init: RequestInit) {
    const body = await requestText(input, init)
    if (!body.trim()) {
      throw new Error("Share service returned an empty response")
    }

    try {
      return JSON.parse(body) as T
    } catch {
      throw new Error("Share service returned invalid JSON")
    }
  }

  function key(item: Data) {
    switch (item.type) {
      case "session":
        return "session"
      case "message":
        return `message:${item.data.id}`
      case "part":
        return `part:${item.data.id}`
      case "session_diff":
        return "session_diff"
      case "model":
        return item.data.length
          ? item.data.map((model) => `model:${model.providerID}:${model.id}`).join(",")
          : `model:${ulid()}`
    }
  }

  function toItemMap(data: Data[]) {
    return Object.fromEntries(data.map((item) => [key(item), item]))
  }

  async function get(sessionID: string) {
    return Effect.runSync(ShareRepo.get(sessionID))
  }

  async function getLocal(shareID: string) {
    return Effect.runSync(ShareRepo.getLocal(shareID)) as LocalShare | undefined
  }

  async function payload(sessionID: string): Promise<Data[]> {
    const { session, diffs } = await runSession(
      Effect.gen(function* () {
        const sessionService = yield* Session.Service
        const session = yield* sessionService.get(sessionID)
        const diffs = yield* sessionService.diff(sessionID).pipe(Effect.catch(() => Effect.succeed([])))
        return { session, diffs }
      }),
    )
    const messages = await Array.fromAsync(MessageV2.stream(sessionID))
    const modelMap = new Map<string, SDK.Model>()

    for (const message of messages) {
      if (message.info.role !== "user") continue
      const model = (message.info as SDK.UserMessage).model
      const id = `${model.providerID}:${model.modelID}`
      if (modelMap.has(id)) continue
      const resolved = await providerGetModel(model.providerID, model.modelID).catch(() => undefined)
      if (!resolved) continue
      // SDK Model.api.url still required until OpenAPI/SDK regen with optional url.
      modelMap.set(id, resolved as SDK.Model)
    }

    return [
      {
        type: "session",
        data: session,
      },
      ...messages.map((x) => ({
        type: "message" as const,
        data: x.info,
      })),
      ...messages.flatMap((x) => x.parts.map((y) => ({ type: "part" as const, data: y }))),
      {
        type: "session_diff",
        data: diffs,
      },
      {
        type: "model",
        data: Array.from(modelMap.values()),
      },
    ]
  }

  async function updateLocal(sessionID: string, share: StoredShare, data: Data[]) {
    const shareID = share.id
    if (!shareID) throw new Error("Local share is missing an id")

    const existing = await getLocal(shareID)

    Effect.runSync(
      ShareRepo.putLocal({
        id: shareID,
        sessionID: existing?.sessionID ?? sessionID,
        url: share.url,
        time: {
          created: existing?.time.created ?? Date.now(),
          updated: Date.now(),
        },
        items: {
          ...existing?.items,
          ...toItemMap(data),
        },
      }),
    )
  }

  async function syncRemote(share: StoredShare, data: Data[]) {
    if (!share.id || !share.secret) {
      throw new Error("Stored share is missing id or secret")
    }

    await requestText(`${await urlImpl()}/api/share/${share.id}/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        secret: share.secret,
        data,
      }),
    })
  }

  async function syncNow(sessionID: string, data: Data[]) {
    const share = await get(sessionID)
    if (!share) return

    if (share.mode === "local") {
      await updateLocal(sessionID, share, data)
      return
    }

    await syncRemote(share, data)
  }

  async function createLocal(sessionID: string, baseUrl: string) {
    const id = ulid().toLowerCase()
    const share: StoredShare = {
      id,
      mode: "local",
      url: `${normalizeBaseURL(baseUrl)}/share/${encodeURIComponent(id)}`,
    }
    const data = await payload(sessionID)
    Effect.runSync(
      Database.transaction((tx) =>
        Effect.gen(function* () {
          yield* ShareRepo.put(sessionID, share, tx)
          yield* ShareRepo.putLocal(
            {
              id,
              sessionID,
              url: share.url,
              time: {
                created: Date.now(),
                updated: Date.now(),
              },
              items: toItemMap(data),
            },
            tx,
          )
        }),
      ),
    )
    return share
  }

  async function createImpl(sessionID: string, input?: { baseUrl?: string }) {
    if (isDisabled()) {
      throw new Error("Sharing is disabled by NIKCLI_DISABLE_SHARE")
    }

    log.info("creating share", { sessionID })

    try {
      const result = await requestJSON<{
        id: string
        url: string
        secret: string
      }>(`${await urlImpl()}/api/share`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionID }),
      })

      const share: StoredShare = {
        id: result.id,
        mode: "remote",
        secret: result.secret,
        url: result.url,
      }

      Effect.runSync(ShareRepo.put(sessionID, share))
      await fullSync(sessionID)
      return share
    } catch (error) {
      if (!input?.baseUrl) throw error

      log.warn("remote share failed, using local fallback", {
        sessionID,
        error: errorMessage(error),
      })
      return createLocal(sessionID, input.baseUrl)
    }
  }

  const queue = new Map<string, { timeout: NodeJS.Timeout; data: Map<string, Data> }>()
  async function sync(sessionID: string, data: Data[]) {
    if (isDisabled()) return

    const existing = queue.get(sessionID)
    if (existing) {
      for (const item of data) {
        existing.data.set(key(item), item)
      }
      return
    }

    const dataMap = new Map<string, Data>()
    for (const item of data) {
      dataMap.set(key(item), item)
    }

    const timeout = setTimeout(async () => {
      const queued = queue.get(sessionID)
      if (!queued) return
      queue.delete(sessionID)
      await syncNow(sessionID, Array.from(queued.data.values())).catch((error) => {
        log.warn("share sync failed", {
          sessionID,
          error: errorMessage(error),
        })
      })
    }, 1000)

    queue.set(sessionID, { timeout, data: dataMap })
  }

  async function removeImpl(sessionID: string) {
    if (isDisabled()) return

    log.info("removing share", { sessionID })

    const queued = queue.get(sessionID)
    if (queued) {
      clearTimeout(queued.timeout)
      queue.delete(sessionID)
    }

    const share = await get(sessionID)
    if (!share) return

    if (share.mode === "local") {
      Effect.runSync(
        Database.transaction((tx) =>
          Effect.gen(function* () {
            if (share.id) yield* ShareRepo.removeLocal(share.id, tx)
            yield* ShareRepo.remove(sessionID, tx)
          }),
        ),
      )
      return
    }

    if (share.id && share.secret) {
      await requestText(`${await urlImpl()}/api/share/${share.id}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          secret: share.secret,
        }),
      }).catch((error) => {
        const message = errorMessage(error)
        if (message.includes("(404)")) return
        throw error
      })
    }

    Effect.runSync(ShareRepo.remove(sessionID))
  }

  async function fullSync(sessionID: string) {
    log.info("full sync", { sessionID })
    await syncNow(sessionID, await payload(sessionID))
  }

  async function publicDataImpl(shareID: string) {
    const share = await getLocal(shareID)
    if (!share) return
    return Object.values(share.items)
  }

  const layer = Layer.succeed(
    Service,
    Service.of({
      url: () => Effect.tryPromise(() => urlImpl()),
      init: () => Effect.tryPromise(() => initImpl()),
      create: (sessionID, input) => Effect.tryPromise(() => createImpl(sessionID, input)),
      remove: (sessionID) => Effect.tryPromise(() => removeImpl(sessionID)),
      publicData: (shareID) => Effect.tryPromise(() => publicDataImpl(shareID)),
    }),
  )

  export const defaultLayer = layer
}

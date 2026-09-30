import { Context, Data, Effect, Layer } from "effect"
import { errorText, native, type ApiResponse } from "./native"

/**
 * Transport to the local nikcli service and the agent session API, as Effect services.
 *
 * - `Gateway` is the only thing that knows how a request leaves the webview (the Rust proxy that
 *   attaches the channel password). Callers above it see typed failures.
 * - `Agent` is the nikcli session API: create a session, prompt it, read it back, abort, delete.
 *
 * Both are ports: tests and other hosts swap the layer without touching callers.
 */
export class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly message: string
  readonly status?: number
}> {}

export type GatewayRequest = {
  readonly method: string
  readonly path: string
  readonly body?: unknown
  /** Instance directory (`x-nikcli-directory`). */
  readonly directory?: string
  readonly timeoutSecs?: number
}

export class Gateway extends Context.Service<
  Gateway,
  {
    readonly raw: (req: GatewayRequest) => Effect.Effect<ApiResponse, GatewayError>
    readonly json: <A = unknown>(req: GatewayRequest) => Effect.Effect<A, GatewayError>
  }
>()("devhub/Gateway") {}

export const gatewayLayer = (serviceUrl: () => string | undefined) => {
  const raw = (req: GatewayRequest): Effect.Effect<ApiResponse, GatewayError> =>
    Effect.suspend(() => {
      const url = serviceUrl()
      if (!url) return Effect.fail(new GatewayError({ message: "No local nikcli service is registered" }))
      const headers: Record<string, string> = {}
      // GET/HEAD never carry a body, and `null` (what a model writes for "no body") means none.
      const hasBody = req.body !== undefined && req.body !== null && !/^(GET|HEAD)$/i.test(req.method)
      if (hasBody) headers["content-type"] = "application/json"
      if (req.directory)
        headers["x-nikcli-directory"] = /[^\x00-\x7F]/.test(req.directory)
          ? encodeURIComponent(req.directory)
          : req.directory
      return Effect.tryPromise({
        try: () =>
          native.api({
            serviceUrl: url,
            method: req.method,
            path: req.path,
            headers,
            body: hasBody ? JSON.stringify(req.body) : undefined,
            timeoutSecs: req.timeoutSecs,
          }),
        catch: (e) => new GatewayError({ message: errorText(e) }),
      })
    })

  const json = <A>(req: GatewayRequest): Effect.Effect<A, GatewayError> =>
    Effect.gen(function* () {
      const res = yield* raw(req)
      if (res.status < 200 || res.status >= 300)
        return yield* new GatewayError({
          status: res.status,
          message: `${req.method} ${req.path} → ${res.status} ${res.body.slice(0, 300)}`,
        })
      if (!res.body.trim()) return undefined as A
      return yield* Effect.try({
        try: () => JSON.parse(res.body) as A,
        catch: () => new GatewayError({ status: res.status, message: `${req.path} did not return JSON` }),
      })
    })

  return Layer.succeed(Gateway, Gateway.of({ raw, json }))
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export type Part = {
  readonly id: string
  readonly type: string
  readonly text?: string
  readonly tool?: string
  readonly state?: {
    readonly status?: string
    readonly title?: string
    readonly input?: unknown
    readonly output?: string
  }
  readonly [k: string]: unknown
}

export type MessageInfo = {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly time: { readonly created: number; readonly completed?: number }
  readonly modelID?: string
  readonly providerID?: string
  readonly cost?: number
  readonly tokens?: {
    readonly total?: number
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly error?: { readonly name?: string; readonly data?: { readonly message?: string } }
  readonly finish?: string
}

export type ChatMessage = { readonly info: MessageInfo; readonly parts: readonly Part[] }
export type ModelRef = { readonly providerID: string; readonly modelID: string }

export type PromptInput = {
  readonly sessionID: string
  readonly text: string
  readonly system?: string
  readonly model?: ModelRef
  readonly agent?: string
  /** Per-tool switches for this turn (`{ bash: false }` withholds the shell). */
  readonly tools?: Readonly<Record<string, boolean>>
}

export class Agent extends Context.Service<
  Agent,
  {
    readonly createSession: (title: string) => Effect.Effect<string, GatewayError>
    readonly exists: (sessionID: string) => Effect.Effect<boolean>
    /** Blocks until the turn is finished; poll `messages` meanwhile to show progress. */
    readonly prompt: (input: PromptInput) => Effect.Effect<ChatMessage, GatewayError>
    readonly messages: (sessionID: string) => Effect.Effect<readonly ChatMessage[], GatewayError>
    readonly abort: (sessionID: string) => Effect.Effect<void, GatewayError>
    readonly remove: (sessionID: string) => Effect.Effect<void, GatewayError>
    /** One-off question in a throw-away session that is always cleaned up. */
    readonly ask: (
      input: Omit<PromptInput, "sessionID"> & { readonly title?: string },
    ) => Effect.Effect<ChatMessage, GatewayError>
  }
>()("devhub/Agent") {}

export const textOf = (m: Pick<ChatMessage, "parts">) =>
  m.parts
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => p.text ?? "")
    .join("")

export const agentLayer = (directory: () => string | undefined) =>
  Layer.effect(
    Agent,
    Effect.gen(function* () {
      const gw = yield* Gateway
      const dir = () => directory()
      const createSession = (title: string) =>
        gw
          .json<{ id: string }>({ method: "POST", path: "/session", body: { title }, directory: dir() })
          .pipe(Effect.map((s) => s.id))
      const remove = (id: string) =>
        gw.json({ method: "DELETE", path: `/session/${encodeURIComponent(id)}`, directory: dir() }).pipe(Effect.asVoid)
      const prompt = (input: PromptInput) =>
        gw.json<ChatMessage>({
          method: "POST",
          path: `/session/${encodeURIComponent(input.sessionID)}/message`,
          directory: dir(),
          timeoutSecs: 900,
          body: {
            ...(input.model ? { model: input.model } : {}),
            ...(input.agent ? { agent: input.agent } : {}),
            ...(input.system ? { system: input.system } : {}),
            ...(input.tools ? { tools: input.tools } : {}),
            parts: [{ type: "text", text: input.text }],
          },
        })
      return Agent.of({
        createSession,
        remove,
        prompt,
        exists: (id) =>
          gw.raw({ method: "GET", path: `/session/${encodeURIComponent(id)}`, directory: dir() }).pipe(
            Effect.map((r) => r.status === 200),
            Effect.orElseSucceed(() => false),
          ),
        messages: (id) =>
          gw.json<ChatMessage[]>({
            method: "GET",
            path: `/session/${encodeURIComponent(id)}/message`,
            directory: dir(),
          }),
        abort: (id) =>
          gw
            .json({ method: "POST", path: `/session/${encodeURIComponent(id)}/abort`, directory: dir() })
            .pipe(Effect.asVoid),
        ask: ({ title, ...input }) =>
          Effect.acquireUseRelease(
            createSession(title ?? "[devhub] ask"),
            (sessionID) => prompt({ ...input, sessionID }),
            (sessionID) => remove(sessionID).pipe(Effect.ignore),
          ),
      })
    }),
  )

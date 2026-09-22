import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Effect, Layer, Option, Schema } from "effect"
import { Config } from "@/config/config"
import { ConnectorAuth } from "@/connectors/auth"
import { InstanceState } from "@/effect"
import { Auth } from "./auth"

/**
 * Discord Gateway bot manager, as a declared group.
 *
 * The Gateway process lives in `@nikcli-ai/discord`. This group is ordinary
 * JSON for the TUI `/discord` wizard: status, token setup, start, stop.
 * The package is loaded on demand — `public.ts` imports this file to declare
 * the group, so a top-level import would drag discord.js into every process
 * that merely serves HTTP.
 */
export namespace DiscordHttpApi {
  const Status = Schema.Struct({
    configured: Schema.Boolean,
    running: Schema.Boolean,
    username: Schema.optionalKey(Schema.String),
    clientId: Schema.optionalKey(Schema.String),
    inviteUrl: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }).annotate({ identifier: "DiscordStatus" })

  const SetupInput = Schema.Struct({
    botToken: Schema.String,
  }).annotate({ identifier: "DiscordSetupInput" })

  const SetupOutput = Schema.Struct({
    username: Schema.String,
    clientId: Schema.String,
    inviteUrl: Schema.String,
  }).annotate({ identifier: "DiscordSetupOutput" })

  const StartResult = Schema.Struct({
    running: Schema.Boolean,
    error: Schema.optionalKey(Schema.String),
  }).annotate({ identifier: "DiscordStartResult" })

  const StopResult = Schema.Struct({
    stopped: Schema.Boolean,
  }).annotate({ identifier: "DiscordStopResult" })

  const ValidationError = Schema.Struct({
    name: Schema.Literal("ValidationError"),
    data: Schema.Record(Schema.String, Schema.Unknown),
  }).annotate({ identifier: "DiscordValidationError", httpApiStatus: 400 })

  type ValidationErrorBody = typeof ValidationError.Type
  type StatusBody = typeof Status.Type
  type StartBody = typeof StartResult.Type

  type DiscordBotModule = typeof import("@nikcli-ai/discord")
  type DiscordInviteModule = typeof import("@nikcli-ai/discord/invite")

  const fromPromise = <A>(fn: () => Promise<A>) => Effect.promise(fn).pipe(Effect.orDie)

  const discordBot = () => import("@nikcli-ai/discord") as Promise<DiscordBotModule>
  const discordInvite = () => import("@nikcli-ai/discord/invite") as Promise<DiscordInviteModule>

  function validationError(message: string): ValidationErrorBody {
    return { name: "ValidationError", data: { message } }
  }

  function causeMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause)
  }

  export const Group = HttpApiGroup.make("discord")
    .add(HttpApiEndpoint.get("status", "/", { success: Status }).annotate(OpenApi.Identifier, "discord.status"))
    .add(
      HttpApiEndpoint.post("setup", "/setup", {
        payload: SetupInput,
        success: SetupOutput,
        error: ValidationError,
      }).annotate(OpenApi.Identifier, "discord.setup"),
    )
    .add(
      HttpApiEndpoint.post("start", "/start", { success: StartResult }).annotate(OpenApi.Identifier, "discord.start"),
    )
    .add(HttpApiEndpoint.post("stop", "/stop", { success: StopResult }).annotate(OpenApi.Identifier, "discord.stop"))
    .prefix("/discord")

  export const Api = HttpApi.make("nikcli").add(Group)
  export const ApiLive = HttpApiBuilder.layer(Api)

  export const handlers = {
    status: () =>
      Effect.gen(function* () {
        const auth = yield* ConnectorAuth.Service
        const entry = yield* auth.get("discord").pipe(Effect.orDie)
        const loaded = yield* fromPromise(async () => {
          try {
            const [bot, invite] = await Promise.all([discordBot(), discordInvite()])
            return { bot, invite }
          } catch (cause) {
            return { error: causeMessage(cause) }
          }
        })
        const hasToken = typeof entry?.botToken === "string" && entry.botToken.length > 0
        if ("error" in loaded) {
          return {
            configured: hasToken,
            running: false,
            ...(loaded.error ? { error: loaded.error } : undefined),
          } satisfies StatusBody
        }
        const botStatus = loaded.bot.getDiscordBotStatus()
        const clientId = botStatus.clientId ?? entry?.teamId
        return {
          configured: hasToken || botStatus.running,
          running: botStatus.running,
          ...(botStatus.username ? { username: botStatus.username } : undefined),
          ...(clientId ? { clientId, inviteUrl: loaded.invite.inviteUrl(clientId) } : undefined),
        } satisfies StatusBody
      }),

    setup: ({ payload }: { payload: typeof SetupInput.Type }) =>
      Effect.gen(function* () {
        const token = payload.botToken.trim()
        if (!token) {
          return yield* Effect.fail(validationError("Bot token is required"))
        }
        const invite = yield* Effect.tryPromise({
          try: () => discordInvite(),
          catch: (cause) => validationError(causeMessage(cause)),
        })
        const botUser = yield* Effect.tryPromise({
          try: () => invite.lookupBotUser(token),
          catch: (cause) => validationError(causeMessage(cause)),
        })
        const auth = yield* ConnectorAuth.Service
        yield* auth.updateBotToken(invite.CONNECTOR_NAME, token, botUser.id).pipe(Effect.orDie)
        const config = yield* Config.Service
        yield* config
          .updateGlobal({
            connectors: {
              discord: { type: "discord", enabled: true },
            },
          })
          .pipe(Effect.orDie)
        return {
          username: botUser.username,
          clientId: botUser.id,
          inviteUrl: invite.inviteUrl(botUser.id),
        }
      }),

    start: () =>
      Effect.gen(function* () {
        const auth = yield* ConnectorAuth.Service
        const entry = yield* auth.get("discord").pipe(Effect.orDie)
        const botToken = entry?.botToken
        if (!botToken) {
          const body: StartBody = {
            running: false,
            error: "Discord bot token is not configured. Run /discord to set it up.",
          }
          return body
        }
        const directory = yield* InstanceState.directory
        return yield* fromPromise(async (): Promise<StartBody> => {
          try {
            const [{ startDiscordBot }, { Server }] = await Promise.all([discordBot(), import("@/server/server")])
            // The bot reaches this server over HTTP like any client, so it
            // presents the password this server requires — the background
            // service always has one.
            const credentials = Auth.currentCredentials()
            const password = Option.getOrUndefined(credentials.password)
            const status = await startDiscordBot({
              botToken,
              nikcliUrl: Server.url().origin,
              directory,
              ...(password ? { nikcliUsername: credentials.username, nikcliPassword: password } : {}),
            })
            return {
              running: status.running,
              ...(!status.running ? { error: "Discord Gateway did not report running" } : undefined),
            } satisfies StartBody
          } catch (cause) {
            return { running: false, error: causeMessage(cause) }
          }
        })
      }),

    stop: () =>
      fromPromise(async () => {
        try {
          const { stopDiscordBot } = await discordBot()
          return { stopped: await stopDiscordBot() }
        } catch {
          return { stopped: false }
        }
      }),
  }

  export const HandlersLive = HttpApiBuilder.group(Api, "discord", (builder) =>
    builder
      .handle("status", handlers.status)
      .handle("setup", handlers.setup)
      .handle("start", handlers.start)
      .handle("stop", handlers.stop),
  )

  export const DependenciesLive = Layer.mergeAll(ConnectorAuth.defaultLayer, Config.defaultLayer)

  export const layer = ApiLive.pipe(Layer.provide(HandlersLive), Layer.provide(DependenciesLive))
}

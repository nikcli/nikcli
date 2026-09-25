import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Effect, Layer, Schema } from "effect"
import { PermissionNext } from "@/permission/next"

export namespace PermissionHttpApi {
  export const Reply = Schema.Literals(["once", "always", "reject"]).annotate({ identifier: "PermissionReply" })

  export const Request = Schema.Struct({
    id: Schema.String,
    sessionID: Schema.String,
    permission: Schema.String,
    patterns: Schema.Array(Schema.String),
    metadata: Schema.Record(Schema.String, Schema.Unknown),
    always: Schema.Array(Schema.String),
    tool: Schema.optional(
      Schema.Struct({
        messageID: Schema.String,
        callID: Schema.String,
      }),
    ),
  }).annotate({ identifier: "PermissionRequest" })

  export const ReplyInput = Schema.Struct({
    reply: Reply,
    message: Schema.optional(Schema.String),
  }).annotate({ identifier: "PermissionReplyInput" })

  const RequestPath = Schema.Struct({
    requestID: Schema.String,
  })

  export const Group = HttpApiGroup.make("permission")
    .add(HttpApiEndpoint.get("list", "/", { success: Schema.Array(Request) }))
    .add(HttpApiEndpoint.get("blocked", "/blocked", { success: Schema.Array(PermissionNext.BlockedInfoSchema) }))
    .add(
      HttpApiEndpoint.post("reply", "/:requestID/reply", {
        params: RequestPath,
        payload: ReplyInput,
        success: Schema.Boolean,
      }),
    )
    .prefix("/permission")

  export const Api = HttpApi.make("nikcli").add(Group)

  export const ApiLive = HttpApiBuilder.layer(Api)

  export const handlers = {
    list: () =>
      Effect.gen(function* () {
        const permission = yield* PermissionNext.Service
        return yield* permission.list()
      }),
    blocked: () =>
      Effect.gen(function* () {
        const permission = yield* PermissionNext.Service
        return yield* permission.blocked()
      }),
    reply: ({ params, payload }: { params: { requestID: string }; payload: typeof ReplyInput.Type }) =>
      Effect.gen(function* () {
        const permission = yield* PermissionNext.Service
        yield* permission.reply({
          requestID: params.requestID,
          reply: payload.reply,
          message: payload.message,
        })
        return true
      }),
  }

  export const HandlersLive = HttpApiBuilder.group(Api, "permission", (builder) =>
    builder.handle("list", handlers.list).handle("blocked", handlers.blocked).handle("reply", handlers.reply),
  )

  export const layer = ApiLive.pipe(Layer.provide(HandlersLive), Layer.provide(PermissionNext.defaultLayer))
}

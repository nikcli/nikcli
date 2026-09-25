import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { Identifier } from "@nikcli-ai/util/id"
import { Log } from "@nikcli-ai/util/log"
import { Wildcard } from "@/util/wildcard"
import { zod, zodObject, type DeepMutable } from "@nikcli-ai/util/effect-zod"
import { Context, Effect, Layer, Schema } from "effect"
import z from "zod"
import { PermissionRepo } from "./permission-repo"
import { PermissionRuleset } from "./ruleset"
import { AutoMode } from "./auto"
import { Flag } from "@nikcli-ai/util/flag"

export namespace PermissionNext {
  const log = Log.create({ service: "permission" })

  // Ruleset model + pure evaluator live in ./ruleset so light clients can use
  // them without this module's stateful service chain; re-exported here to
  // keep the PermissionNext API unchanged.
  export const ActionSchema = PermissionRuleset.ActionSchema
  export const Action = PermissionRuleset.Action
  export type Action = PermissionRuleset.Action

  export const RuleSchema = PermissionRuleset.RuleSchema
  export const Rule = PermissionRuleset.Rule
  export type Rule = PermissionRuleset.Rule

  export const RulesetSchema = PermissionRuleset.RulesetSchema
  export const Ruleset = PermissionRuleset.Ruleset
  export type Ruleset = PermissionRuleset.Ruleset

  export const fromConfig = PermissionRuleset.fromConfig
  export const merge = PermissionRuleset.merge
  export const fullAccess = PermissionRuleset.fullAccess
  export const autoApprove = PermissionRuleset.autoApprove

  const RequestSchema = Schema.Struct({
    id: Schema.String.pipe(Schema.check(Schema.isStartsWith("per"))),
    sessionID: Schema.String.pipe(Schema.check(Schema.isStartsWith("ses"))),
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
  export const Request = zodObject(RequestSchema)
  export type Request = DeepMutable<Schema.Schema.Type<typeof RequestSchema>>

  const ReplySchema = Schema.Literals(["once", "always", "reject"])
  export const Reply = zod(ReplySchema)
  export type Reply = Schema.Schema.Type<typeof ReplySchema>

  const BlockedSchema = Schema.Struct({
    id: Schema.String,
    sessionID: Schema.String,
    permission: Schema.String,
    patterns: Schema.Array(Schema.String),
    rule: Schema.String,
    reason: Schema.String,
    time: Schema.Number,
    tool: Schema.optional(
      Schema.Struct({
        messageID: Schema.String,
        callID: Schema.String,
      }),
    ),
  }).annotate({ identifier: "PermissionBlocked" })
  export const BlockedInfo = zodObject(BlockedSchema)
  export type Blocked = DeepMutable<Schema.Schema.Type<typeof BlockedSchema>>
  export const BlockedInfoSchema = BlockedSchema

  export const Approval = zodObject(
    Schema.Struct({
      projectID: Schema.String,
      patterns: Schema.Array(Schema.String),
    }),
  )

  export const Event = {
    // A prompt the user has to answer. Never coalesced with a different
    // request and never silently dropped: the alternative to delivering it is
    // an operation that waits forever on an answer nobody was asked for.
    Asked: BusEvent.schema("permission.asked", RequestSchema, { delivery: "decision" }),
    Replied: BusEvent.schema(
      "permission.replied",
      Schema.Struct({
        sessionID: Schema.String,
        requestID: Schema.String,
        reply: ReplySchema,
      }),
    ),
    /** The auto mode classifier denied an action. Notification only: nothing waits on it. */
    Blocked: BusEvent.schema("permission.blocked", BlockedSchema),
  }

  type PendingEntry = {
    info: Request
    resolve: () => void
    reject: (e: RejectedError | CorrectedError) => void
  }

  type State = {
    pending: Record<string, PendingEntry>
    approved: Ruleset
    /** Auto mode denial counters, per session. */
    denials: Record<string, AutoMode.Denials>
    /** Recent auto mode denials, newest last — the "Recently blocked" list. */
    blocked: Blocked[]
  }

  const MAX_BLOCKED = 50

  export const AskInput = Request.partial({ id: true }).extend({
    ruleset: Ruleset,
    /**
     * The agent making the request, when the caller knows it. Auto mode is a
     * per-agent setting; without this the agent is read from the transcript.
     */
    agent: z.string().optional(),
  })
  export type AskInput = z.infer<typeof AskInput>

  export const ReplyInput = z.object({
    requestID: Identifier.schema("permission"),
    reply: Reply,
    message: z.string().optional(),
  })
  export type ReplyInput = z.infer<typeof ReplyInput>

  export interface Interface {
    readonly ask: (input: AskInput) => Effect.Effect<void, DeniedError | RejectedError | CorrectedError | BlockedError>
    readonly reply: (input: ReplyInput) => Effect.Effect<void>
    readonly hydrateAsk: (request: Request) => Effect.Effect<void>
    readonly hydrateReply: (requestID: string) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Request[]>
    /** Recent auto mode denials, newest first. */
    readonly blocked: () => Effect.Effect<Blocked[]>
  }

  // `session/auto-mode.ts` reaches the session, agent and provider services,
  // all of which import this module; loading it on first use keeps the import
  // graph acyclic. Nothing loads it until a session is actually in auto mode
  // or a decision could depend on it.
  const autoRuntime = () => import("@/session/auto-mode").then((module) => module.SessionAutoMode)

  export class Service extends Context.Service<Service, Interface>()("@nikcli/PermissionNext") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make<State>((ctx) =>
        Effect.gen(function* () {
          // A ruleset that cannot be read is not recoverable here: the
          // synchronous version threw out of state construction too.
          const approved = PermissionRepo.get(ctx.project.id).pipe(Effect.orDie)
          return {
            pending: {},
            approved: yield* approved,
            denials: {},
            blocked: [],
          }
        }),
      )

      const getState = () => InstanceState.get(state)

      type Pending = Omit<AskInput, "ruleset" | "agent">
      type Evaluated = { pattern: string; rule: Rule }

      /** Publish a request and wait for the user's answer. */
      const prompt = (s: State, request: Pending) => {
        const id = request.id ?? Identifier.ascending("permission")
        return Effect.callback<void, RejectedError | CorrectedError>((resume) => {
          const info: Request = {
            id,
            ...request,
          }
          s.pending[id] = {
            info,
            resolve: () => resume(Effect.void),
            reject: (error: RejectedError | CorrectedError) => resume(Effect.fail(error)),
          }
          void Bus.publish(Event.Asked, info)
          return Effect.sync(() => {
            delete s.pending[id]
          })
        })
      }

      const denied = (ruleset: Ruleset, permission: string) =>
        new DeniedError({
          ruleset: ruleset.filter((r: Rule) => Wildcard.match(permission, r.permission)),
        })

      const autoActive = (sessionID: string, agent: string | undefined) =>
        Effect.promise(() =>
          autoRuntime()
            .then((runtime) => runtime.active({ sessionID, agent }))
            .catch((error) => {
              log.warn("auto mode resolution failed; using default mode", { error })
              return false
            }),
        )

      /**
       * The auto mode decision order (`permission/auto.ts`): denials first, then
       * explicit asks to the user, then the fast path, then the classifier.
       */
      const askAuto = Effect.fn("PermissionNext.askAuto")(function* (
        s: State,
        ruleset: Ruleset,
        request: Pending,
        evaluated: Evaluated[],
        agent: string | undefined,
      ) {
        if (evaluated.some((entry) => entry.rule.action === "deny")) {
          return yield* Effect.fail(denied(ruleset, request.permission))
        }
        const ctx = yield* InstanceState.context
        const runtime = yield* Effect.promise(autoRuntime)
        const classifyAllShell = yield* Effect.promise(() => runtime.classifyAllShell())
        const routes = evaluated.map((entry) =>
          AutoMode.route({
            permission: request.permission,
            pattern: entry.pattern,
            rule: entry.rule,
            worktree: ctx.worktree,
            directory: ctx.directory,
            classifyAllShell,
          }),
        )
        log.info("auto mode routed", { permission: request.permission, routes })
        if (routes.includes("ask")) return yield* prompt(s, request)
        if (!routes.includes("classify")) return

        const verdict = yield* Effect.promise((signal) =>
          runtime.classify({
            sessionID: request.sessionID,
            permission: request.permission,
            patterns: request.patterns,
            metadata: request.metadata,
            tool: request.tool,
            abort: signal,
          }),
        )

        // The mode changed while the classifier was thinking: a verdict the new
        // mode would never have asked for is discarded, and the request gets
        // exactly the treatment the default mode gives it.
        if (!(yield* autoActive(request.sessionID, agent))) {
          if (evaluated.some((entry) => entry.rule.action === "ask")) return yield* prompt(s, request)
          return
        }

        const denials = (s.denials[request.sessionID] ??= AutoMode.emptyDenials())
        if (verdict.kind === "allow") {
          AutoMode.recordAllowed(denials)
          return
        }
        if (verdict.kind === "unavailable") {
          // No verdict is never a pass. It is not counted toward the fallback
          // thresholds either: the classifier did not judge the action.
          log.warn("auto mode classifier unavailable", { permission: request.permission, reason: verdict.reason })
          return yield* Effect.fail(
            new BlockedError({
              rule: "Unavailable",
              reason: verdict.reason,
              detail: AutoMode.unavailableMessage(verdict.reason),
            }),
          )
        }

        const entry: Blocked = {
          id: Identifier.ascending("permission"),
          sessionID: request.sessionID,
          permission: request.permission,
          patterns: [...request.patterns],
          rule: verdict.rule,
          reason: verdict.reason,
          time: Date.now(),
          ...(request.tool ? { tool: request.tool } : {}),
        }
        s.blocked.push(entry)
        if (s.blocked.length > MAX_BLOCKED) s.blocked.splice(0, s.blocked.length - MAX_BLOCKED)
        void Bus.publish(Event.Blocked, entry)

        if (AutoMode.recordBlocked(denials)) {
          // Three in a row or twenty in the session: auto mode pauses and the
          // user decides. Approving resumes auto mode from a clean streak.
          log.info("auto mode paused at denial limit", { sessionID: request.sessionID })
          yield* prompt(s, {
            ...request,
            metadata: {
              ...request.metadata,
              auto_mode: { fallback: true, rule: verdict.rule, reason: verdict.reason },
            },
          })
          AutoMode.recordApproved(denials)
          return
        }
        return yield* Effect.fail(
          new BlockedError({ rule: verdict.rule, reason: verdict.reason, detail: AutoMode.blockedMessage(verdict) }),
        )
      })

      const ask = Effect.fn("PermissionNext.ask")(function* (input: AskInput) {
        const parsed = AskInput.parse(input)
        const s = yield* getState()
        const { ruleset, agent, ...request } = parsed
        const evaluated: Evaluated[] = (request.patterns ?? []).map((pattern) => {
          const rule = evaluate(request.permission, pattern, ruleset, s.approved)
          log.info("evaluated", {
            permission: request.permission,
            pattern,
            action: rule,
          })
          return { pattern, rule }
        })

        // Auto mode only matters when a decision could change under it; a safe
        // tool the ruleset already allows never pays for the mode lookup.
        if (
          !Flag.NIKCLI_DANGEROUSLY_SKIP_PERMISSIONS &&
          evaluated.some((entry) => AutoMode.relevant(request.permission, entry.rule)) &&
          (yield* autoActive(request.sessionID, agent))
        ) {
          return yield* askAuto(s, ruleset, request, evaluated, agent)
        }

        for (const { pattern, rule } of evaluated) {
          if (rule.action === "deny") {
            return yield* Effect.fail(denied(ruleset, request.permission))
          }
          if (rule.action === "ask") {
            // Opencode #22047: --dangerously-skip-permissions auto-approves `ask` rules
            // after the deny check. Deny rules still throw DeniedError (above).
            if (Flag.NIKCLI_DANGEROUSLY_SKIP_PERMISSIONS) {
              log.warn("dangerously skipping ask rule", {
                permission: request.permission,
                pattern,
              })
              continue
            }
            return yield* prompt(s, request)
          }
          if (rule.action === "allow") continue
        }
      })

      const reply = Effect.fn("PermissionNext.reply")(function* (input: ReplyInput) {
        const parsed = ReplyInput.parse(input)
        const s = yield* getState()
        const existing = s.pending[parsed.requestID]
        if (!existing) return
        delete s.pending[parsed.requestID]
        yield* Effect.promise(() =>
          Bus.publish(Event.Replied, {
            sessionID: existing.info.sessionID,
            requestID: existing.info.id,
            reply: parsed.reply,
          }),
        )
        if (parsed.reply === "reject") {
          existing.reject(parsed.message ? new CorrectedError({ feedback: parsed.message }) : new RejectedError({}))
          const sessionID = existing.info.sessionID
          for (const [id, pending] of Object.entries(s.pending)) {
            if (pending.info.sessionID === sessionID) {
              delete s.pending[id]
              yield* Effect.promise(() =>
                Bus.publish(Event.Replied, {
                  sessionID: pending.info.sessionID,
                  requestID: pending.info.id,
                  reply: "reject",
                }),
              )
              pending.reject(new RejectedError({}))
            }
          }
          return
        }
        if (parsed.reply === "once") {
          existing.resolve()
          return
        }
        if (parsed.reply === "always") {
          for (const pattern of existing.info.always) {
            const rule: Rule = {
              permission: existing.info.permission,
              pattern,
              action: "allow",
            }
            s.approved.push(rule)
          }
          const ctx = yield* InstanceState.context
          Effect.runSync(PermissionRepo.upsert(ctx.project.id, s.approved))

          existing.resolve()

          const sessionID = existing.info.sessionID
          for (const [id, pending] of Object.entries(s.pending)) {
            if (pending.info.sessionID !== sessionID) continue
            const ok = pending.info.patterns.every(
              (pattern: string) => evaluate(pending.info.permission, pattern, s.approved).action === "allow",
            )
            if (!ok) continue
            delete s.pending[id]
            yield* Effect.promise(() =>
              Bus.publish(Event.Replied, {
                sessionID: pending.info.sessionID,
                requestID: pending.info.id,
                reply: "always",
              }),
            )
            pending.resolve()
          }
        }
      })

      const hydrateAsk = Effect.fn("PermissionNext.hydrateAsk")(function* (request: Request) {
        const s = yield* getState()
        s.pending[request.id] = {
          info: request,
          resolve: () => {},
          reject: () => {},
        }
      })

      const hydrateReply = Effect.fn("PermissionNext.hydrateReply")(function* (requestID: string) {
        const s = yield* getState()
        delete s.pending[requestID]
      })

      const list = Effect.fn("PermissionNext.list")(function* () {
        const s = yield* getState()
        return Object.values(s.pending).map((x) => x.info)
      })

      const blocked = Effect.fn("PermissionNext.blocked")(function* () {
        const s = yield* getState()
        return s.blocked.toReversed()
      })

      return Service.of({
        ask,
        reply,
        hydrateAsk,
        hydrateReply,
        list,
        blocked,
      })
    }),
  )

  export const defaultLayer = layer

  export const evaluate = PermissionRuleset.evaluate
  export const disabled = PermissionRuleset.disabled

  export class RejectedError extends Schema.TaggedError<RejectedError>()("PermissionRejectedError", {}) {
    override get message() {
      return "The user rejected permission to use this specific tool call."
    }
  }

  export class CorrectedError extends Schema.TaggedError<CorrectedError>()("PermissionCorrectedError", {
    feedback: Schema.String,
  }) {
    override get message() {
      return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
    }
  }

  /**
   * The auto mode classifier denied the action (or could not judge it). Unlike
   * {@link RejectedError} it does not end the turn: the agent reads the reason
   * and continues with a safer approach, the way it does after a denial rule.
   */
  export class BlockedError extends Schema.TaggedError<BlockedError>()("PermissionBlockedError", {
    rule: Schema.String,
    reason: Schema.String,
    detail: Schema.String,
  }) {
    override get message() {
      return this.detail
    }
  }

  export class DeniedError extends Schema.TaggedError<DeniedError>()("PermissionDeniedError", {
    ruleset: Schema.Any,
  }) {
    override get message() {
      return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
    }
  }
}

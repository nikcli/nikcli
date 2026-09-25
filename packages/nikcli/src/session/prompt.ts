import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "@nikcli-ai/util/id"
import { MessageV2 } from "./message-v2"
import { Log } from "@nikcli-ai/util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { SessionCompaction } from "./compaction"
import { Bus } from "../bus"
import { InstructionSync } from "./instruction-sync"
import { Plugin } from "../plugin"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "@nikcli-ai/util/defer"
import { clone } from "remeda"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { ListTool } from "../tool/ls"
import { FileTime } from "../file/time"
import { ulid } from "ulid"
import { Command } from "../command"
import { fileURLToPath } from "bun"
import { Config } from "../config/config"
import { SessionSummary } from "./summary"
import { Snapshot } from "@/snapshot"
import { SessionGoal } from "./goal"
import { EventError } from "./event-error"
import { fn } from "@/util/fn"
import { setOptional } from "@/util/optional-key"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { Context, Effect, Layer } from "effect"
import { Instance } from "@/project/instance"
import { InstanceState, locallyInstance, runPromiseWithLayer, type InstanceContext } from "@/effect"
import { errorMessage } from "@nikcli-ai/util/error-format"
import { resolveTools, createStructuredOutputTool } from "./tools"
import { PromptParts } from "./prompt-parts"
import { PromptState } from "./prompt-state"
import { PromptCommands } from "./prompt-commands"
import { PromptTitle } from "./prompt-title"
import { Database } from "@/database/database"
import { MessageRepo } from "./message-repo"
import { SessionRepo } from "./repo"
import { SessionSync } from "./projectors"
import { SyncEvent } from "@/sync/sync-event"
import { SessionPending } from "./pending"
import { SessionV2Write } from "./v2/write"

globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })

  export function isUserInitiatedStop(error: unknown) {
    if (error === undefined) return true
    if (MessageV2.AbortedError.isInstance(error)) return true
    if (error instanceof DOMException && error.name === "AbortError") return true
    if (errorMessage(error) === "RunnerCancelled") return true
    return error instanceof Error && error.name === "AbortError"
  }

  function askPermission(input: PermissionNext.AskInput) {
    return runPromiseWithLayer(
      PermissionNext.defaultLayer,
      locallyInstance(
        currentContext(),
        Effect.gen(function* () {
          const permission = yield* PermissionNext.Service
          return yield* permission.ask(input)
        }),
      ),
    )
  }

  function configGet() {
    return runPromiseWithLayer(
      Config.defaultLayer,
      locallyInstance(
        currentContext(),
        Effect.gen(function* () {
          const config = yield* Config.Service
          return yield* config.get()
        }),
      ),
    )
  }

  function commandGet(name: string) {
    return runPromiseWithLayer(
      Command.defaultLayer,
      locallyInstance(
        currentContext(),
        Effect.gen(function* () {
          const command = yield* Command.Service
          return yield* command.get(name)
        }),
      ),
    )
  }

  function agentGet(name: string) {
    return runPromiseWithLayer(
      Agent.defaultLayer,
      locallyInstance(
        currentContext(),
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          return yield* agent.get(name)
        }),
      ),
    )
  }

  async function agentRequired(name: string) {
    const agent = await agentGet(name)
    if (!agent) throw new Agent.NotFoundError({ name })
    return agent
  }

  function agentList() {
    return runPromiseWithLayer(
      Agent.defaultLayer,
      locallyInstance(
        currentContext(),
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          return yield* agent.list()
        }),
      ),
    )
  }

  function defaultAgent() {
    return runPromiseWithLayer(
      Agent.defaultLayer,
      locallyInstance(
        currentContext(),
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          return yield* agent.defaultAgent()
        }),
      ),
    )
  }

  function runSummary<A, E>(effect: Effect.Effect<A, E, SessionSummary.Service | Session.Service | Snapshot.Service>) {
    return runPromiseWithLayer(SessionSummary.runnerLayer, locallyInstance(currentContext(), effect))
  }

  function runRevert<A, E>(effect: Effect.Effect<A, E, SessionRevert.Service>) {
    return runPromiseWithLayer(SessionRevert.defaultLayer, locallyInstance(currentContext(), effect))
  }

  function runCompaction<A, E>(effect: Effect.Effect<A, E, SessionCompaction.Service>) {
    return runPromiseWithLayer(SessionCompaction.defaultLayer, locallyInstance(currentContext(), effect))
  }

  function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
    return runPromiseWithLayer(Session.layer, locallyInstance(currentContext(), effect))
  }

  function runGoal<A, E>(effect: Effect.Effect<A, E, SessionGoal.Service>) {
    return runPromiseWithLayer(SessionGoal.defaultLayer, effect)
  }

  function sessionGet(sessionID: string) {
    return runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.get(sessionID)
      }),
    )
  }

  function sessionUpdate(sessionID: string, editor: (session: Session.Info) => void, options?: { touch?: boolean }) {
    return runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.update(sessionID, editor, options)
      }),
    )
  }

  function sessionUpdateMessage(message: MessageV2.Info) {
    return runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.updateMessage(message)
      }),
    )
  }

  function sessionUpdatePart(part: MessageV2.Part) {
    return runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.updatePart(part)
      }),
    )
  }

  function sessionPlan(info: Session.Info) {
    return runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.plan(info)
      }),
    )
  }

  function tokenTotal(tokens: MessageV2.Assistant["tokens"]) {
    return tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  }

  async function accountGoalTurn(sessionID: string, assistant: MessageV2.Assistant) {
    const seconds =
      assistant.time.completed === undefined
        ? 0
        : Math.max(0, Math.round((assistant.time.completed - assistant.time.created) / 1000))
    return runGoal(
      Effect.gen(function* () {
        const goal = yield* SessionGoal.Service
        return yield* goal.accountUsage(sessionID, tokenTotal(assistant.tokens), seconds)
      }),
    )
  }

  async function nextGoalPrompt(sessionID: string) {
    return runGoal(
      Effect.gen(function* () {
        const goal = yield* SessionGoal.Service
        const current = yield* goal.get(sessionID)
        if (!current || !goal.isGoalContinueNeeded(current)) return undefined

        const updated = yield* goal.incrementIteration(sessionID)
        if (!updated) return undefined

        if (updated.status === "budget_limited") {
          yield* goal.usageLimit(sessionID)
          return {
            text: goal.budgetLimitPrompt(updated),
            activeCommand: undefined,
          }
        }

        if (goal.isIterationLimitReached(updated)) {
          yield* goal.usageLimit(sessionID)
          return {
            text: goal.iterationLimitPrompt(updated),
            activeCommand: undefined,
          }
        }

        return {
          text: goal.continuationPrompt(updated),
          activeCommand: "goal",
        }
      }),
    )
  }

  function runPlugin<A, E>(effect: Effect.Effect<A, E, Plugin.Service>) {
    return runPromiseWithLayer(Plugin.defaultLayer, locallyInstance(currentContext(), effect))
  }

  function runProvider<A, E>(effect: Effect.Effect<A, E, Provider.Service>) {
    return runPromiseWithLayer(Provider.defaultLayer, locallyInstance(currentContext(), effect))
  }

  function providerGetModel(providerID: string, modelID: string) {
    return runProvider(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.getModel(providerID, modelID)
      }),
    )
  }

  function providerGetSmallModel(providerID: string) {
    return runProvider(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.getSmallModel(providerID)
      }),
    )
  }

  function providerDefaultModel() {
    return runProvider(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.defaultModel()
      }),
    )
  }

  function runLSP<A, E>(effect: Effect.Effect<A, E, LSP.Service>) {
    return runPromiseWithLayer(LSP.defaultLayer, locallyInstance(currentContext(), effect))
  }

  function runMCP<A, E>(effect: Effect.Effect<A, E, MCP.Service>) {
    return runPromiseWithLayer(MCP.defaultLayer, locallyInstance(currentContext(), effect))
  }

  function setStatus(sessionID: string, status: SessionStatus.Info) {
    return runPromiseWithLayer(
      SessionStatus.defaultLayer,
      locallyInstance(
        currentContext(),
        Effect.gen(function* () {
          const sessionStatus = yield* SessionStatus.Service
          return yield* sessionStatus.set(sessionID, status)
        }),
      ),
    )
  }

  /**
   * The instance this service call is running in.
   *
   * Every entry point into this module is a `Service` method that goes through
   * `withInstanceContext`, which resolves an `InstanceContext` and re-enters
   * `Instance.provide` with it. The ambient scope read here is therefore not an
   * accident of whoever called us — it is the context this module installed one
   * frame up, so reading it is equivalent to threading that context through the
   * ~40 signatures between here and there, and cannot disagree with it.
   *
   * `test/session/prompt-instance-scope.test.ts` pins the premise: a service
   * method that reaches these helpers without installing the scope fails there.
   */
  function currentContext(): InstanceContext {
    return InstanceState.ambient()
  }

  function runInInstanceContext<A>(ctx: InstanceContext, fn: () => Promise<A>): Effect.Effect<A, Error> {
    return Effect.tryPromise({
      try: async () => await Instance.provide({ directory: ctx.directory, fn }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
  }

  function withInstanceContext<A>(fn: () => Promise<A>): Effect.Effect<A, Error> {
    return InstanceState.context.pipe(Effect.flatMap((ctx) => runInInstanceContext(ctx, fn)))
  }

  export const PromptInput = SessionPending.PromptInput
  export type PromptInput = SessionPending.PromptInput

  export const SteerPendingInput = z.object({
    sessionID: Identifier.schema("session"),
    pendingID: Identifier.schema("pending"),
  })

  export type Admission = {
    messageID: string
    message?: MessageV2.WithParts
    pending?: SessionPending.Info
    controller?: AbortController
    retry: boolean
  }

  export interface Interface {
    /**
     * Fails with `Session.BusyError` when the session already has a running
     * turn. Declared on the typed channel (E8.1): a busy session is an
     * expected 409, not a defect, so every caller — Effect-side or through
     * the Promise bridge — sees it without a `catchDefect` arm.
     */
    assertNotBusy(sessionID: string): Effect.Effect<void, Session.BusyError>
    /**
     * Persist the user message (and optional tool permissions) without starting
     * the model loop. Used by `prompt_async` so clients can observe the message
     * immediately after the 204.
     */
    admit(input: PromptInput): Effect.Effect<Awaited<ReturnType<typeof admit>>, unknown>
    steerPending(input: z.infer<typeof SteerPendingInput>): Effect.Effect<SessionPending.Info, unknown>
    prompt(input: PromptInput): Effect.Effect<Awaited<ReturnType<typeof prompt>>, unknown>
    resolvePromptParts(template: string): Effect.Effect<PromptInput["parts"], unknown>
    cancel(sessionID: string): Effect.Effect<void>
    loop(
      sessionID: string,
      options?: {
        controller?: AbortController
        messageID?: string
        waitFor?: "reply" | "promotion"
      },
    ): Effect.Effect<MessageV2.WithParts, unknown>
    shell(input: ShellInput): Effect.Effect<Awaited<ReturnType<typeof PromptCommands.shell>>, unknown>
    command(input: CommandInput): Effect.Effect<Awaited<ReturnType<typeof PromptCommands.command>>, unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("SessionPrompt.Service") {}

  function permissions(input: PromptInput): PermissionNext.Ruleset {
    return Object.entries(input.tools ?? {}).map(([tool, enabled]) => ({
      permission: tool,
      action: enabled ? "allow" : "deny",
      pattern: "*",
    }))
  }

  function persistPrepared(ctx: InstanceContext, prepared: MessageV2.WithParts, promptData: string): void {
    SessionV2Write.persist({
      prepared,
      promptData,
      projectID: ctx.project.id,
    })
  }

  function touchForBatch(ctx: InstanceContext, session: Session.Info, inputs: PromptInput[]): void {
    const updated = structuredClone(session)
    updated.time.updated = Date.now()
    for (const input of inputs) {
      const ruleset = permissions(input)
      if (ruleset.length > 0) updated.permission = ruleset
    }
    SessionSync.install()
    SyncEvent.run(SessionSync.Updated, { sessionID: updated.id, info: updated }, { projectID: ctx.project.id })
  }

  function existingAdmission(sessionID: string, messageID: string, promptData: string) {
    const existing = Effect.runSync(MessageRepo.getMessageWithParts(sessionID, messageID))
    if (!existing) return undefined
    if (Effect.runSync(MessageRepo.getPromptData(sessionID, messageID)) !== promptData) {
      throw new SessionPending.ConflictError(sessionID, messageID)
    }
    return existing
  }

  /** Durably admit input without starting a model request. */
  const admit = fn(PromptInput, async (input) => {
    if (input.delivery === "steer" && PromptState.owned(input.sessionID)) {
      await PromptState.cancel(input.sessionID)
      await PromptState.waitUntilIdle(input.sessionID)
    }
    const controller = input.noReply === true ? undefined : PromptState.reserve(input.sessionID)
    try {
      const session = await sessionGet(input.sessionID)
      await runRevert(
        Effect.gen(function* () {
          const revert = yield* SessionRevert.Service
          yield* revert.cleanup(session)
        }),
      )

      const admitted = PromptInput.parse({
        ...input,
        messageID: input.messageID ?? Identifier.ascending("message"),
      })
      const messageID = admitted.messageID!
      const promptData = SessionPending.canonical(admitted)

      const existingPending = Effect.runSync(SessionPending.getByMessage(admitted.sessionID, messageID))
      if (existingPending) {
        if (SessionPending.canonical(existingPending.data) !== promptData) {
          throw new SessionPending.ConflictError(admitted.sessionID, messageID)
        }
        if (input.noReply === true && !PromptState.owned(admitted.sessionID)) {
          const promoted = await promote(admitted.sessionID, existingPending.delivery)
          return {
            messageID,
            message: promoted.find((message) => message.info.id === messageID),
            controller,
            retry: true,
          } satisfies Admission
        }
        return {
          messageID,
          pending: existingPending,
          controller,
          retry: true,
        } satisfies Admission
      }

      const existing = existingAdmission(admitted.sessionID, messageID, promptData)
      if (existing)
        return {
          messageID,
          message: existing,
          controller,
          retry: true,
        } satisfies Admission

      if (!controller && PromptState.owned(admitted.sessionID)) {
        const pending = Effect.runSync(
          Database.transaction((tx) =>
            Effect.sync(() => {
              const raced = Effect.runSync(SessionPending.getByMessage(admitted.sessionID, messageID, tx))
              if (raced) {
                if (SessionPending.canonical(raced.data) !== promptData) {
                  throw new SessionPending.ConflictError(admitted.sessionID, messageID)
                }
                return raced
              }
              const promoted = existingAdmission(admitted.sessionID, messageID, promptData)
              if (promoted) return undefined
              return Effect.runSync(
                SessionPending.insert(
                  {
                    sessionID: admitted.sessionID,
                    messageID,
                    // Omit delivery → queue. Queue absorbs at the next safe step
                    // (the old steer path). Explicit steer aborts the turn first.
                    delivery: admitted.delivery ?? "queue",
                    data: promptData,
                  },
                  tx,
                ),
              )
            }),
          ),
        )
        if (!pending) {
          return {
            messageID,
            message: Effect.runSync(MessageRepo.getMessageWithParts(admitted.sessionID, messageID)),
            controller,
            retry: true,
          } satisfies Admission
        }
        return {
          messageID,
          pending,
          controller,
          retry: false,
        } satisfies Admission
      }

      const ctx = currentContext()
      const prepared = await prepareUserMessage(admitted)
      const result = Effect.runSync(
        Database.transaction(() =>
          Effect.sync(() => {
            const raced = existingAdmission(admitted.sessionID, messageID, promptData)
            if (raced) return raced
            const current = Effect.runSync(SessionRepo.get(admitted.sessionID))
            if (!current)
              throw new Session.NotFoundError({
                message: `Session not found: ${admitted.sessionID}`,
              })
            persistPrepared(ctx, prepared, promptData)
            touchForBatch(ctx, current, [admitted])
            return prepared
          }),
        ),
      )
      return {
        messageID,
        message: result,
        controller,
        retry: result !== prepared,
      } satisfies Admission
    } catch (error) {
      if (controller) await PromptState.finish(input.sessionID, controller)
      throw error
    }
  })

  const prompt = fn(PromptInput, async (input) => {
    const admission = await admit(input)

    if (input.noReply === true) {
      if (admission.message) return admission.message
      return loop(input.sessionID, admission.controller, admission.messageID, "promotion")
    }

    if (admission.retry && admission.message) {
      const reply = Effect.runSync(MessageRepo.listMessages(input.sessionID))
        .filter((message): message is MessageV2.Assistant => message.role === "assistant")
        .findLast((message) => message.parentID === admission.messageID && !!message.finish)
      if (reply) {
        if (admission.controller) {
          await PromptState.finish(input.sessionID, admission.controller)
        }
        return Effect.runSync(MessageRepo.getMessageWithParts(input.sessionID, reply.id))!
      }
    }

    return loop(input.sessionID, admission.controller, admission.messageID)
  })

  const steerPending = fn(SteerPendingInput, async (input) => {
    await sessionGet(input.sessionID)
    const running = PromptState.running(input.sessionID)
    if (running) {
      await PromptState.cancel(input.sessionID)
      await PromptState.waitUntilIdle(input.sessionID)
    }
    const pending = Effect.runSync(
      Database.transaction((tx) => SessionPending.steer(input.sessionID, input.pendingID, tx)),
    )
    if (!pending) {
      throw new Session.NotFoundError({
        message: `Pending input not found: ${input.pendingID}`,
      })
    }
    if (running || !PromptState.owned(input.sessionID)) {
      await promote(input.sessionID, "steer")
    }
    void loop(input.sessionID, undefined, pending.messageID).catch((error) => {
      if (MessageV2.AbortedError.isInstance(error)) return
      log.error("failed to wake steered pending input", {
        sessionID: input.sessionID,
        error,
      })
    })
    return pending
  })

  async function promote(sessionID: string, delivery: SessionPending.Delivery): Promise<MessageV2.WithParts[]> {
    const rows = Effect.runSync(SessionPending.list(sessionID, delivery))
    if (rows.length === 0) return []

    const current = Effect.runSync(SessionRepo.get(sessionID))
    if (!current) {
      Effect.runSync(
        Database.transaction((tx) =>
          Effect.sync(() =>
            Effect.runSync(
              SessionPending.remove(
                rows.map((row) => row.id),
                tx,
              ),
            ),
          ),
        ),
      )
      return []
    }

    const prepared: {
      row: SessionPending.Info
      message: MessageV2.WithParts
      promptData: string
    }[] = []
    for (const row of rows) {
      prepared.push({
        row,
        message: await prepareUserMessage(row.data),
        promptData: SessionPending.canonical(row.data),
      })
    }
    const ctx = currentContext()

    const promoted = Effect.runSync(
      Database.transaction((tx) =>
        Effect.sync(() => {
          const available = new Map(
            Effect.runSync(SessionPending.list(sessionID, delivery, tx)).map((row) => [row.id, row]),
          )
          const active = prepared.filter((item) => available.has(item.row.id))
          if (active.length === 0) return { messages: [] as MessageV2.WithParts[], pendingIDs: [] as string[] }

          const session = Effect.runSync(SessionRepo.get(sessionID))
          if (!session) {
            Effect.runSync(
              SessionPending.remove(
                active.map((item) => item.row.id),
                tx,
              ),
            )
            return { messages: [] as MessageV2.WithParts[], pendingIDs: [] as string[] }
          }

          const messages: MessageV2.WithParts[] = []
          for (const item of active) {
            const existing = existingAdmission(sessionID, item.row.messageID, item.promptData)
            if (existing) messages.push(existing)
            else {
              persistPrepared(ctx, item.message, item.promptData)
              messages.push(item.message)
            }
          }
          touchForBatch(
            ctx,
            session,
            active.map((item) => item.row.data),
          )
          Effect.runSync(
            SessionPending.remove(
              active.map((item) => item.row.id),
              tx,
            ),
          )
          return {
            messages,
            pendingIDs: active.map((item) => item.row.id),
          }
        }),
      ),
    )

    if (promoted.messages.length > 0) {
      PromptState.promoted(sessionID, promoted.messages)
      await Bus.publish(Session.Event.PendingPromoted, {
        sessionID,
        pendingIDs: promoted.pendingIDs,
        messageIDs: promoted.messages.map((message) => message.info.id),
      })
    }
    return promoted.messages
  }

  async function loop(
    sessionID: string,
    reserved?: AbortController,
    messageID?: string,
    waitFor: "reply" | "promotion" = "reply",
  ): Promise<MessageV2.WithParts> {
    Identifier.schema("session").parse(sessionID)
    const controller = PromptState.start(sessionID, reserved)
    if (!controller) return PromptState.wait(sessionID, messageID, waitFor)

    const result = PromptState.wait(sessionID, messageID, waitFor)
    void runLoop(sessionID, controller).catch((error) => {
      log.error("prompt loop failed", { sessionID, error })
    })
    return result
  }

  async function runLoop(sessionID: string, controller: AbortController) {
    const abort = controller.signal

    await using _ = defer(() => PromptState.finish(sessionID, controller))
    const ctx = currentContext()

    // Instruction deltas emitted by earlier turns have been delivered by now.
    // Fold them into the epoch prefix so they stop being replayed, in full, on
    // every request for the rest of the session. Done before the step loop so
    // the prefix stays byte-stable across the steps of this turn.
    InstructionSync.foldDelivered(sessionID)

    // Structured output state
    // Note: On session resumption, state is reset but format is preserved
    // on the user message and will be retrieved from lastUser below
    let structuredOutput: unknown | undefined
    let structuredOutputUserID: string | undefined
    let structuredOutputRetries = 0

    let step = 0
    while (true) {
      await setStatus(sessionID, { type: "busy", since: Date.now() })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      const session = await sessionGet(sessionID)
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) {
        const steered = await promote(sessionID, "steer")
        const queued = await promote(sessionID, "queue")
        if (steered.length > 0 || queued.length > 0) {
          step = 0
          continue
        }
        throw new Error("No user message found in stream. This should never happen.")
      }
      if (structuredOutputUserID !== lastUser.id) {
        structuredOutputUserID = lastUser.id
        structuredOutputRetries = 0
        structuredOutput = undefined
      }

      const boundaryTask = tasks[tasks.length - 1]
      const turnFinished =
        !!lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastAssistant.parentID === lastUser.id
      if (!boundaryTask && !turnFinished && lastFinished && lastFinished.summary !== true) {
        const boundaryModel = await providerGetModel(lastUser.model.providerID, lastUser.model.modelID)
        const overflow = await runCompaction(
          Effect.gen(function* () {
            const compaction = yield* SessionCompaction.Service
            return yield* compaction.isOverflow({
              tokens: lastFinished.tokens,
              model: boundaryModel,
            })
          }),
        )
        if (overflow) {
          await runCompaction(
            Effect.gen(function* () {
              const compaction = yield* SessionCompaction.Service
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
              })
            }),
          )
          continue
        }
      }
      if (boundaryTask?.type !== "compaction") {
        const steered = await promote(sessionID, "steer")
        const queued = await promote(sessionID, "queue")
        if (steered.length > 0 || queued.length > 0) {
          step = 0
          continue
        }
      }

      // Opencode #21365: prefer parentID over ID ordering. Timestamp-based
      // IDs from independent generators (e.g. web UI client-side) can skew.
      if (turnFinished) {
        // Check if new messages arrived while we were running
        // This handles the race condition in prompt where messages can arrive
        // while the runner is transitioning between states
        const latestMsgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
        const newUserMsg = latestMsgs.findLast((m) => m.info.role === "user" && m.info.id > lastAssistant!.id)

        // If a new user message arrived, continue the loop to process it
        if (newUserMsg) {
          log.info("detected new message during exit, continuing loop", {
            sessionID,
            lastAssistantId: lastAssistant!.id,
            newMsgId: newUserMsg.info.id,
          })
          step = 0
          continue
        }

        const completed = latestMsgs.find((message) => message.info.id === lastAssistant!.id)
        if (completed) PromptState.resolve(sessionID, completed)

        const queued = await promote(sessionID, "queue")
        if (queued.length > 0) {
          step = 0
          continue
        }

        log.info("exiting loop", { sessionID })
        break
      }

      step++
      if (step === 1)
        PromptTitle.ensure(titleDeps, {
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      const model = await providerGetModel(lastUser.model.providerID, lastUser.model.modelID)
      const task = tasks.pop()

      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await providerGetModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await sessionUpdateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        const part = (await sessionUpdatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
              background: true,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart

        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
          background: true,
        }
        // Before hook - errors are non-fatal, log and continue
        await runPlugin(
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.trigger(
              "tool.execute.before",
              {
                tool: "task",
                sessionID,
                agent: task.agent,
                messageID: assistantMessage.id,
                callID: part.callID,
              },
              { args: taskArgs },
            )
          }),
        ).catch((err) => {
          log.debug("plugin trigger failed", {
            error: String(err),
            tool: "task",
          })
        })
        let executionError: Error | undefined
        const taskAgent = await agentRequired(task.agent)
        const taskCtx: Tool.Context = {
          instance: currentContext(),
          agent: lastUser.agent ?? task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: {
            bypassAgentCheck: true,
            backgroundSource: "model-subtask",
            parentModel: lastUser.model,
          },
          async metadata(input) {
            if (part.state.status !== "running") return
            part.state = {
              ...part.state,
              ...input,
            }
            await sessionUpdatePart({
              ...part,
              type: "tool",
              state: part.state,
            } satisfies MessageV2.ToolPart)
          },
          async progress(update) {
            if (part.state.status !== "running") return
            part.state = {
              ...part.state,
              structured: { ...update.structured },
              content: [...(update.content ?? [])],
            }
            await sessionUpdatePart({
              ...part,
              state: part.state,
            } satisfies MessageV2.ToolPart)
          },
          async ask(req) {
            await askPermission({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        const result = await taskTool.executeAsync(taskArgs, taskCtx).catch((error: unknown) => {
          executionError = error instanceof Error ? error : new Error(String(error))
          log.error("subtask execution failed", {
            error,
            agent: task.agent,
            description: task.description,
          })
          return undefined
        })
        await runPlugin(
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.trigger(
              "tool.execute.after",
              {
                tool: "task",
                sessionID,
                agent: task.agent,
                messageID: assistantMessage.id,
                callID: part.callID,
              },
              result,
            )
          }),
        ).catch((err) => {
          // Plugin errors are non-fatal, log and continue
          log.debug("plugin trigger failed", {
            error: String(err),
            tool: "task",
          })
        })
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await sessionUpdateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          await sessionUpdatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments: result.attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await sessionUpdatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          const summaryUserMsg: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: lastUser.model,
          }
          await sessionUpdateMessage(summaryUserMsg)
          await sessionUpdatePart({
            id: Identifier.ascending("part"),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      if (task?.type === "compaction") {
        const result = await runCompaction(
          Effect.gen(function* () {
            const compaction = yield* SessionCompaction.Service
            return yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              abort,
              sessionID,
              auto: task.auto,
            })
          }),
        )
        if (result === "stop") break
        continue
      }

      const agent = await agentRequired(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })

      const processor = SessionProcessor.create({
        instance: ctx,
        assistantMessage: (await sessionUpdateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })

      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
      })

      // Inject StructuredOutput tool if JSON schema mode is enabled
      if (lastUser.format?.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: lastUser.format.schema,
          onSuccess(output) {
            structuredOutput = output
          },
        })
      }

      if (step === 1) {
        void runSummary(
          Effect.gen(function* () {
            const summary = yield* SessionSummary.Service
            yield* summary.summarize({
              sessionID: sessionID,
              messageID: lastUser.id,
            })
          }),
        )
      }

      // Clone only for plugin transforms — do not mutate text for reminders.
      // Queued-user wrapping is applied in toModelMessages so stored parts (and
      // therefore prompt-cache prefixes) stay stable across turns.
      const sessionMessages = clone(msgs)
      const remindAfter = step > 1 && lastFinished ? lastFinished.id : undefined
      // Default off: wrapping mid-turn user text in "continue with your tasks"
      // made steer/wake absorption weaker than the pre-queue path. Opt in via
      // experimental.queued_message_wrap.
      const config = await configGet()
      const wrap = (config.experimental?.queued_message_wrap ?? false) as
        | { header: string; footer: string }
        | "default"
        | boolean
        | null

      await runPlugin(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })
        }),
      )

      const assembled = await InstructionSync.assemble({
        sessionID,
        projectID: session.projectID,
        skills: session.skills ?? [],
        disabled: session.disabledInstructions ?? [],
      })

      // Build system prompt, adding structured output instructions if needed
      const system = [...assembled.system]
      const format: MessageV2.OutputFormat = lastUser.format ?? {
        type: "text",
      }
      if (format.type === "json_schema") {
        system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      }

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system,
        messages: [
          ...assembled.skillMessages.map((content) => ({
            role: "user" as const,
            content,
          })),
          ...MessageV2.toModelMessages(sessionMessages, model, {
            remindAfter,
            wrap,
          }),
          ...assembled.updates,
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools,
        model,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
      })

      await accountGoalTurn(sessionID, processor.message)

      // If structured output was captured, save it and exit immediately.
      // This takes priority because the StructuredOutput tool was called successfully.
      if (structuredOutput !== undefined) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await sessionUpdateMessage(processor.message)
        break
      }

      // If the model stopped without the StructuredOutput tool, return a structured output error.
      const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)
      if (modelFinished && !processor.message.error && format.type === "json_schema") {
        if (structuredOutputRetries < format.retryCount) {
          structuredOutputRetries++
          const retryMsg = await sessionUpdateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID,
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: lastUser.model,
            system: lastUser.system,
            tools: lastUser.tools,
            format: lastUser.format,
            variant: lastUser.variant,
          })
          await sessionUpdatePart({
            id: Identifier.ascending("part"),
            messageID: retryMsg.id,
            sessionID,
            type: "text",
            synthetic: true,
            text: "The previous response did not call the StructuredOutput tool. Retry and call StructuredOutput exactly once with valid JSON matching the requested schema.",
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          })
          structuredOutputUserID = retryMsg.id
          step = 0
          continue
        }
        processor.message.error = {
          name: "StructuredOutputError" as const,
          data: {
            message: "Model did not produce structured output",
            retries: structuredOutputRetries,
          },
        }
        await sessionUpdateMessage(processor.message)
        break
      }

      const goalFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)
      if (goalFinished && !processor.message.error && result !== "stop" && result !== "compact") {
        const continuation = await nextGoalPrompt(sessionID)
        if (continuation) {
          await sessionUpdate(sessionID, (draft) => {
            setOptional(draft, "activeCommand", continuation.activeCommand)
          })
          const continueMsg: MessageV2.User = {
            id: Identifier.ascending("message"),
            role: "user",
            sessionID,
            time: { created: Date.now() },
            agent: lastUser.agent,
            model: lastUser.model,
            system: lastUser.system,
            tools: lastUser.tools,
            variant: lastUser.variant,
          }
          await sessionUpdateMessage(continueMsg)
          await sessionUpdatePart({
            id: Identifier.ascending("part"),
            messageID: continueMsg.id,
            sessionID,
            type: "text",
            text: continuation.text,
            synthetic: true,
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          } satisfies MessageV2.TextPart)
          step = 0
          continue
        }
      }

      if (result === "stop") break
      if (result === "compact") {
        await runCompaction(
          Effect.gen(function* () {
            const compaction = yield* SessionCompaction.Service
            yield* compaction.create({
              sessionID,
              agent: lastUser.agent,
              model: lastUser.model,
              auto: true,
            })
          }),
        )
      }
      continue
    }

    // When the turn is interrupted (double-ESC / session.abort), the loop can
    // break between steps — after a step already finished cleanly, or after a
    // tool absorbed the abort and the stream ended normally — so no message
    // carries MessageAbortedError. Mark the most recent assistant message as
    // interrupted (unless the stream processor already set an error) so the UI
    // shows the "· interrupted" indicator instead of a normal completion.
    if (abort.aborted) {
      for await (const item of MessageV2.stream(sessionID)) {
        if (item.info.role !== "assistant") continue
        const info = item.info
        if (!info.error) {
          await sessionUpdateMessage({
            ...info,
            error: {
              name: "MessageAbortedError",
              data: { message: "Interrupted by user" },
            },
            time: {
              ...info.time,
              completed: info.time.completed ?? Date.now(),
            },
          })
        }
        break
      }
    }

    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      PromptState.resolve(sessionID, item)
      if (!abort.aborted) {
        const steered = await promote(sessionID, "steer")
        if (steered.length > 0) return runLoop(sessionID, controller)
        const queued = await promote(sessionID, "queue")
        if (queued.length > 0) return runLoop(sessionID, controller)
      }
      void runCompaction(
        Effect.gen(function* () {
          const compaction = yield* SessionCompaction.Service
          yield* compaction.prune({ sessionID })
        }),
      )
      return item
    }
    throw new Error("Impossible")
  }

  async function lastModel(sessionID: string) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return providerDefaultModel()
  }

  /**
   * Resolve the model that a worker should use when it has no messages of its
   * own yet. Walks through:
   *
   *  1. `sessionID`'s persisted `Session.Info.lastModel` (fast indexed column)
   *  2. the messages stream of `sessionID` (covers sessions whose first model
   *     was set but never re-persisted, e.g. before this feature shipped)
   *  3. the caller's `Session.Info.lastModel` when `parentSessionID` is given —
   *     this is the path a mission worker hits, since the mission session has
   *     no messages but the session that fired `/mission/.../start` does
   *  4. the global provider default (last resort)
   *
   * Implemented as a synchronous read against `SessionRepo` first so we do
   * not have to scan messages for every prompt turn.
   */
  async function inheritedModel(
    sessionID: string,
    parentSessionID?: string,
  ): Promise<{ providerID: string; modelID: string }> {
    const own = Effect.runSync(SessionRepo.get(sessionID))
    if (own?.lastModel) return own.lastModel
    const ownFromMessages = await lastModel(sessionID).catch(() => undefined)
    // `lastModel` already includes the global fallback, so distinguish "found
    // a real model" from "fell back to default" by re-reading the column: if
    // it's still empty the message stream had nothing usable either.
    if (ownFromMessages && Effect.runSync(SessionRepo.get(sessionID))?.lastModel) return ownFromMessages
    if (parentSessionID && parentSessionID !== sessionID) {
      const parent = Effect.runSync(SessionRepo.get(parentSessionID))
      if (parent?.lastModel) return parent.lastModel
    }
    return providerDefaultModel()
  }

  async function prepareUserMessage(input: PromptInput) {
    // Opencode #28816: an inline `@agent` mention lives on input.parts as an
    // AgentPart; fall back to it when the top-level agent field is absent.
    const inlineAgentName = input.parts.find((p): p is MessageV2.AgentPart => p.type === "agent")?.name
    const agent = await agentRequired(input.agent ?? inlineAgentName ?? (await defaultAgent()))

    const model = input.model ?? agent.model ?? (await inheritedModel(input.sessionID, input.parentSessionID))
    const full =
      !input.variant && agent.variant
        ? await providerGetModel(model.providerID, model.modelID).catch(() => undefined)
        : undefined
    // Opencode #25363: when switching to an agent with a configured variant, prefer the
    // agent's variant over the session's. Without this, an agent like `plan` with
    // variant="max-thinking" would still inherit the session's default variant.
    const variant = input.variant ?? (agent.variant && full?.variants?.[agent.variant] ? agent.variant : undefined)

    const info: MessageV2.Info = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model,
      system: input.system,
      format: input.format,
      variant,
    }

    // Persist the resolved model on the session so subsequent prompts and any
    // worker spawned from this session inherit it without re-resolving. Cheap
    // indexed column write, skipped when the value is unchanged.
    Effect.runSync(SessionRepo.setLastModel(input.sessionID, model))

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<MessageV2.Part[]> => {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: MessageV2.Part[] = [
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await runMCP(
                Effect.gen(function* () {
                  const mcp = yield* MCP.Service
                  return yield* mcp.readResource(clientName, uri)
                }),
              )
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                id: part.id ?? Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", {
                error,
                clientName,
                uri,
              })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                const commaIndex = part.url.indexOf(",")
                const metadata = commaIndex === -1 ? part.url : part.url.slice(0, commaIndex)
                const payload = commaIndex === -1 ? "" : part.url.slice(commaIndex + 1)
                const text = decodeDataUrlTextPayload(metadata, payload)
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text,
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              // Non-text, non-media data: attachments cannot be ingested by the model.
              // Degrade to a synthetic notice instead of forwarding a mime the provider rejects.
              if (!isModelMediaMime(part.mime)) {
                const label = part.filename ? `"${part.filename}"` : "attachment"
                return [
                  {
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Attachment omitted: ${label} (${part.mime}) is not a media type the model can ingest. Extract text with tools if needed.]`,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const stat = await Bun.file(filepath).stat()

              if (stat.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = await runLSP(
                      Effect.gen(function* () {
                        const lsp = yield* LSP.Service
                        return yield* lsp.documentSymbol(filePathURI)
                      }),
                    )
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) {
                    limit = end - (offset - 1)
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: MessageV2.Part[] = [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                try {
                  const tool = await ReadTool.init()
                  const model = await providerGetModel(info.model.providerID, info.model.modelID)
                  const readCtx: Tool.Context = {
                    instance: currentContext(),
                    sessionID: input.sessionID,
                    abort: new AbortController().signal,
                    agent: input.agent!,
                    messageID: info.id,
                    callID: part.id ?? info.id,
                    extra: { bypassCwdCheck: true, model },
                    metadata: async () => {},
                    progress: async () => {},
                    ask: async () => {},
                  }
                  const result = await tool.executeAsync(args, readCtx)
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((attachment) => ({
                        ...attachment,
                        synthetic: true,
                        filename: attachment.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({
                      ...part,
                      id: part.id ?? Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                    })
                  }
                } catch (error) {
                  log.error("failed to read file", { error: String(error) })
                  const message = error instanceof Error ? error.message : String(error)
                  Bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: EventError.unknown(message),
                  })
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { path: filepath }
                const listCtx: Tool.Context = {
                  instance: currentContext(),
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  callID: part.id ?? info.id,
                  extra: { bypassCwdCheck: true },
                  metadata: async () => {},
                  progress: async () => {},
                  ask: async () => {},
                }
                const result = await ListTool.init().then((t) => t.executeAsync(args, listCtx))
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the list tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              // Images/PDFs: forward as model media. Everything else points the
              // agent at the on-disk path so bash/read/python can open it instead
              // of hard-failing the whole send on an unsupported mime.
              if (!isModelMediaMime(part.mime)) {
                const label = part.filename ? `"${part.filename}"` : filepath
                return [
                  {
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Attachment omitted: ${label} (${part.mime}) is not a media type the model can ingest. The file is available at ${filepath} — use bash/read/python tools to inspect it.]`,
                  },
                ]
              }

              const file = Bun.file(filepath)
              await FileTime.read(input.sessionID, filepath)
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  synthetic: true,
                },
                {
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + Buffer.from(await file.bytes()).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          const perm = PermissionNext.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              id: Identifier.ascending("part"),
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            id: Identifier.ascending("part"),
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat())

    await runPlugin(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        yield* plugin.trigger(
          "chat.message",
          {
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            messageID: input.messageID,
            variant: input.variant,
          },
          {
            message: info,
            parts,
          },
        )
      }),
    )

    return {
      info,
      parts,
    }
  }

  /**
   * Tell the agent when auto mode turns on or off. Inserted on transitions
   * only, like the plan-mode reminders below: the last reminder in the
   * history is the mode the agent believes it is in.
   */
  async function insertAutoModeReminder(input: {
    messages: MessageV2.WithParts[]
    userMessage: MessageV2.WithParts
    agent: Agent.Info
    session: Session.Info
  }) {
    const { SessionAutoMode } = await import("./auto-mode")
    const active = await SessionAutoMode.active({ sessionID: input.session.id, agent: input.agent.name }).catch(
      () => false,
    )
    let last: "on" | "off" | undefined
    for (const message of input.messages.toReversed()) {
      for (const part of message.parts.toReversed()) {
        if (part.type !== "text" || !part.synthetic) continue
        if (part.text === SessionAutoMode.REMINDER_ON) last = "on"
        else if (part.text === SessionAutoMode.REMINDER_OFF) last = "off"
        if (last) break
      }
      if (last) break
    }
    const text =
      active && last !== "on"
        ? SessionAutoMode.REMINDER_ON
        : !active && last === "on"
          ? SessionAutoMode.REMINDER_OFF
          : undefined
    if (!text) return
    const part = await sessionUpdatePart({
      id: Identifier.ascending("part"),
      messageID: input.userMessage.info.id,
      sessionID: input.userMessage.info.sessionID,
      type: "text",
      text,
      synthetic: true,
    })
    input.userMessage.parts.push(part)
  }

  async function insertReminders(input: { messages: MessageV2.WithParts[]; agent: Agent.Info; session: Session.Info }) {
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages

    await insertAutoModeReminder({ ...input, userMessage })

    // The plan-file workflow below is the only plan mode. The older path — a
    // `plan.txt` preamble pushed onto the last user message, with no plan file
    // and no `plan_exit` — sat behind `NIKCLI_EXPERIMENTAL_PLAN_MODE`, a
    // constant that was hardcoded `true`, so it had already been dead in every
    // build that shipped. Removing it removes a branch nothing could reach.
    // `prompt/plan.txt` is kept on disk deliberately; nothing imports it now.
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const plan = await sessionPlan(input.session)
      const exists = await Bun.file(plan).exists()
      if (exists) {
        const part = await sessionUpdatePart({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            BUILD_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
      }
      return input.messages
    }

    if (input.agent.name === "plan" && assistantMessage?.info.agent !== "plan") {
      const plan = await sessionPlan(input.session)
      const exists = await Bun.file(plan).exists()
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await sessionUpdatePart({
        id: Identifier.ascending("part"),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    }
    return input.messages
  }

  export const ShellInput = PromptCommands.ShellInput
  export type ShellInput = PromptCommands.ShellInput

  export const CommandInput = PromptCommands.CommandInput
  export type CommandInput = PromptCommands.CommandInput

  /** Media types the model request path can ingest as file/image parts. */
  function isModelMediaMime(mime: string): boolean {
    return mime.startsWith("image/") || mime === "application/pdf"
  }

  function decodeDataUrlTextPayload(metadata: string, payload: string) {
    if (!metadata.includes(";base64")) {
      try {
        return decodeURIComponent(payload)
      } catch {
        return payload
      }
    }

    const normalized = payload.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")
    const unpadded = normalized.replace(/=+$/, "")
    if (!unpadded || unpadded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      try {
        return decodeURIComponent(payload)
      } catch {
        return payload
      }
    }

    const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=")
    const bytes = Buffer.from(padded, "base64")
    const roundTrip = bytes.toString("base64").replace(/=+$/, "")
    if (roundTrip !== unpadded) {
      try {
        return decodeURIComponent(payload)
      } catch {
        return payload
      }
    }

    return bytes.toString()
  }

  const commandDeps: PromptCommands.Deps = {
    commandGet,
    agentGet,
    agentRequired,
    agentList,
    defaultAgent,
    lastModel,
    inheritedModel,
    providerGetModel,
    sessionGet,
    sessionUpdate,
    sessionUpdateMessage,
    sessionUpdatePart,
    currentContext,
    runRevert,
    runGoal,
    runPlugin,
    prompt,
  }

  const titleDeps: PromptTitle.Deps = {
    agentGet,
    providerGetModel,
    providerGetSmallModel,
    sessionUpdate,
  }

  export const layer = Layer.succeed(
    Service,
    Service.of({
      assertNotBusy: (sessionID) =>
        Effect.gen(function* () {
          const match = (yield* PromptState.getServiceStateEffect())[sessionID]
          if (match)
            return yield* Effect.fail(
              new Session.BusyError({
                sessionID,
                message: "Session is busy",
              }),
            )
        }),
      admit: (input) => withInstanceContext(() => admit(input)),
      steerPending: (input) => withInstanceContext(() => steerPending(input)),
      prompt: (input) => withInstanceContext(() => prompt(input)),
      resolvePromptParts: (template) =>
        InstanceState.context.pipe(
          Effect.flatMap((ctx) => Effect.tryPromise(() => PromptParts.resolve(ctx, template))),
        ),
      cancel: (sessionID) => Effect.promise(() => PromptState.cancel(sessionID)),
      loop: (sessionID, options) =>
        withInstanceContext(() => loop(sessionID, options?.controller, options?.messageID, options?.waitFor)),
      shell: (input) => withInstanceContext(() => PromptCommands.shell(commandDeps, input, PromptState)),
      command: (input) => withInstanceContext(() => PromptCommands.command(commandDeps, input)),
    }),
  )

  export const defaultLayer = layer
}

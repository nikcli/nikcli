import { MessageV2 } from "./message-v2"
import { Log } from "@nikcli-ai/util/log"
import { Identifier } from "@nikcli-ai/util/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { DeltaCoalescer } from "./delta-coalescer"
import { SessionSync } from "./projectors"
import { SyncEvent } from "@/sync/sync-event"
import { ContentLoop } from "@/util/content-loop"
import { Context, Effect, Layer } from "effect"
import { stripDanglingXmlArtifacts } from "@/util/dangling-xml"
import { runPromiseWithLayer, withCurrentInstance, type InstanceContext } from "@/effect"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type CreateInput = {
    /** The instance this response belongs to. */
    instance: InstanceContext
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }

  export interface Interface {
    create(input: CreateInput): Effect.Effect<Info>
  }

  export class Service extends Context.Service<Service, Interface>()("SessionProcessor.Service") {}

  export type Info = ReturnType<typeof createImpl>
  export type Result = Awaited<ReturnType<Info["process"]>>

  function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError"
  }

  function askPermission(input: PermissionNext.AskInput) {
    return runPromiseWithLayer(
      PermissionNext.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const permission = yield* PermissionNext.Service
          return yield* permission.ask(input)
        }),
      ),
    )
  }

  function setStatus(sessionID: string, status: SessionStatus.Info) {
    return runPromiseWithLayer(
      SessionStatus.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const sessionStatus = yield* SessionStatus.Service
          return yield* sessionStatus.set(sessionID, status)
        }),
      ),
    )
  }

  function runSnapshot<A, E>(effect: Effect.Effect<A, E, Snapshot.Service>) {
    return runPromiseWithLayer(Snapshot.defaultLayer, withCurrentInstance(effect))
  }

  function runSummary<A, E>(effect: Effect.Effect<A, E, SessionSummary.Service | Session.Service | Snapshot.Service>) {
    return runPromiseWithLayer(SessionSummary.runnerLayer, withCurrentInstance(effect))
  }

  function runCompaction<A, E>(effect: Effect.Effect<A, E, SessionCompaction.Service>) {
    return runPromiseWithLayer(SessionCompaction.defaultLayer, withCurrentInstance(effect))
  }

  function runPlugin<A, E>(effect: Effect.Effect<A, E, Plugin.Service>) {
    return runPromiseWithLayer(Plugin.defaultLayer, withCurrentInstance(effect))
  }

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

  function agentGet(name: string) {
    return runPromiseWithLayer(
      Agent.defaultLayer,
      withCurrentInstance(
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

  // Doom-loop detection: returns PermissionNext.ask call if pattern detected
  function detectDoomLoop(
    buffer: Array<{ tool: string; input: unknown }>,
    toolName: string,
    toolInput: unknown,
    sessionID: string,
    agent: Agent.Info,
  ): Promise<void> | void {
    const entry = { tool: toolName, input: toolInput }
    buffer.push(entry)
    if (buffer.length > DOOM_LOOP_THRESHOLD) {
      buffer.shift()
    }

    if (buffer.length === DOOM_LOOP_THRESHOLD) {
      const lastThree = buffer.slice(-DOOM_LOOP_THRESHOLD)
      if (lastThree.every((p) => p.tool === toolName && Bun.deepEquals(p.input, toolInput))) {
        buffer.length = 0
        return askPermission({
          permission: "doom_loop",
          patterns: [toolName],
          sessionID,
          metadata: {
            tool: toolName,
            input: toolInput,
          },
          always: [toolName],
          ruleset: agent.permission,
          agent: agent.name,
        })
      }
    }
  }

  function createImpl(input: CreateInput) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    // Last raw length we published a live generative-TUI update for, per tool call.
    // Throttles `opentui` tool-input streaming so we don't republish every token.
    const vizPublishedLen: Record<string, number> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    // Ring buffer for doom-loop detection - avoids repeated storage I/O
    const doomLoopBuffer: Array<{ tool: string; input: unknown }> = []

    // Coalesce streaming delta writes to disk — publish Bus events immediately
    // for UI responsiveness, but batch disk writes to reduce ~500 writes/response
    // down to ~10-20 coalesced flushes.
    const coalescer = DeltaCoalescer

    const updateMessage = (msg: MessageV2.Info) =>
      runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.updateMessage(msg)
        }),
      )

    const updatePart = (part: MessageV2.Part) =>
      runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.updatePart(part)
        }),
      )

    const removePart = (input: { sessionID: string; messageID: string; partID: string }) =>
      runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.removePart(input)
        }),
      )

    const getUsage = (input: Parameters<typeof Session.getUsage>[0]) =>
      runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.getUsage(input)
        }),
      )

    // For streaming deltas: publish Bus event immediately but coalesce the disk write.
    // This avoids ~500 SQL writes per response while keeping the UI responsive.
    //
    // The delta path is the one place that publishes ahead of the write
    // instead of through the event system — a `SyncEvent.run` per token would
    // be a transaction per token. The coalesced flush still goes through the
    // projector (with `publish: false`, since the bus already heard every
    // delta) so the row is written in exactly one place.
    async function updatePartCoalesced(part: MessageV2.TextPart | MessageV2.ReasoningPart, delta: string) {
      Bus.publish(MessageV2.Event.PartUpdated, { part, delta })
      const key = ["part", part.messageID, part.id]
      coalescer.schedule(key, part, async (_k, content) => {
        const flushed = content as MessageV2.Part
        SessionSync.install()
        SyncEvent.run(
          SessionSync.PartUpdated,
          { sessionID: flushed.sessionID, part: flushed },
          { publish: false, projectID: input.instance.project.id },
        )
      })
    }

    // Hoisted: cleanup function used across retry iterations
    const cleanupRetryAttempt = async (attemptPartIDs: Set<string>) => {
      for (const partID of attemptPartIDs) {
        coalescer.discard(["part", input.assistantMessage.id, partID])
        await removePart({
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          partID,
        }).catch(() => {})
      }
      for (const key of Object.keys(toolcalls)) {
        delete toolcalls[key]
      }
      snapshot = undefined
    }

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await configGet()).experimental?.continue_loop_on_deny !== true
        while (true) {
          const attemptPartIDs = new Set<string>()
          const trackPart = <T extends { id: string }>(part: T) => {
            attemptPartIDs.add(part.id)
            return part
          }
          let currentText: MessageV2.TextPart | undefined
          const reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
          // Opencode #21112: reasoning-text doom loop detection state.
          const reasoningLoop: ContentLoop.State = ContentLoop.initial()

          const finishOpenReasoning = async () => {
            for (const [id, part] of Object.entries(reasoningMap)) {
              part.text = part.text.trimEnd()
              part.time = {
                ...part.time,
                end: Date.now(),
              }
              Bus.publish(MessageV2.Event.PartUpdated, {
                part,
                delta: "",
              })
              await coalescer.flushNow(["part", part.messageID, part.id]).catch(() => {})
              delete reasoningMap[id]
            }
          }
          try {
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  await setStatus(input.sessionID, {
                    type: "busy",
                    since: Date.now(),
                  })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = trackPart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  })
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await updatePartCoalesced(part, value.text)
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    // Opencode #21112: detect reasoning-text doom loops (Kimi
                    // K2.5 / GLM-5 sometimes repeat the same reasoning verbatim).
                    const verdict = ContentLoop.check(reasoningLoop, part.text)
                    reasoningLoop.ring = verdict.state.ring
                    reasoningLoop.repeatStreak = verdict.state.repeatStreak
                    reasoningLoop.nudges = verdict.state.nudges
                    if (verdict.action === "abort") {
                      // Mark the abort reason so the UI surfaces it. The
                      // stream loop checks `input.abort.aborted` and breaks.
                      input.assistantMessage.error = {
                        name: "MessageAbortedError",
                        data: {
                          message: "Reasoning entered a doom loop — aborting",
                        },
                      }
                      // Throw to break out of the loop; the outer runner
                      // observes the assistantMessage.error and surfaces it.
                      throw new Error("Reasoning entered a doom loop — aborting")
                    }
                    if (verdict.action === "nudge") {
                      // Append a system-reminder synthetic part to nudge the model.
                      const reminder: MessageV2.TextPart = {
                        id: Identifier.ascending("part"),
                        messageID: part.messageID,
                        sessionID: part.sessionID,
                        type: "text",
                        text:
                          "<system-reminder>\n" +
                          "Your previous reasoning repeated itself. Stop re-stating the same thoughts and take the next action now (call a tool or produce a final answer).\n" +
                          "</system-reminder>",
                        synthetic: true,
                      }
                      await updatePart(reminder)
                    }

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    // Flush and publish update so UI can stop spinner
                    Bus.publish(MessageV2.Event.PartUpdated, {
                      part,
                      delta: "",
                    })
                    await coalescer.flushNow(["part", part.messageID, part.id]).catch(() => {})
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start": {
                  const part = await updatePart(
                    trackPart({
                      id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                      messageID: input.assistantMessage.id,
                      sessionID: input.assistantMessage.sessionID,
                      type: "tool" as const,
                      tool: value.toolName,
                      callID: value.id,
                      state: {
                        status: "pending" as const,
                        input: {},
                        raw: "",
                      },
                    }),
                  )
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break
                }

                case "tool-input-delta": {
                  // Real-time generative TUI: stream the partial JSON of the
                  // `opentui` tool args so the UI can render components as they
                  // complete. Strictly gated to that one tool — every other tool
                  // keeps the cheap no-op path, so normal streaming is untouched.
                  // We clone (never mutate the live part), skip the disk write
                  // entirely (the v2 projector only persists tool parts on status
                  // changes, so all "pending"-state publishes ride the bus without
                  // hitting the DB), and throttle publishes to avoid a per-token
                  // storm.
                  const existing = toolcalls[value.id]
                  if (existing && existing.tool === "opentui" && existing.state.status === "pending") {
                    const raw = (existing.state.raw ?? "") + (value.delta ?? "")
                    const next = {
                      ...existing,
                      state: { ...existing.state, raw },
                    } as MessageV2.ToolPart
                    toolcalls[value.id] = next
                    // Publish at most once per ~24 chars of growth — smooth enough
                    // for incremental rendering, cheap enough to never thrash.
                    if (raw.length - (vizPublishedLen[value.id] ?? 0) >= 24) {
                      vizPublishedLen[value.id] = raw.length
                      Bus.publish(MessageV2.Event.PartUpdated, {
                        part: next,
                        delta: "",
                      })
                    }
                  }
                  break
                }

                case "tool-input-end": {
                  // Flush the final partial state for the opentui tool so the
                  // last few streamed components are visible before the tool
                  // transitions to "running" — the throttled publish above only
                  // fires on ~24-char boundaries, so a short tail can otherwise
                  // be swallowed and the user sees a static snapshot freeze.
                  const existing = toolcalls[value.id]
                  if (
                    existing &&
                    existing.tool === "opentui" &&
                    existing.state.status === "pending" &&
                    (vizPublishedLen[value.id] ?? 0) < existing.state.raw.length
                  ) {
                    vizPublishedLen[value.id] = existing.state.raw.length
                    Bus.publish(MessageV2.Event.PartUpdated, {
                      part: existing,
                      delta: "",
                    })
                  }
                  break
                }

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    // Use helper for doom-loop detection
                    const agent = await agentRequired(input.assistantMessage.agent)
                    await detectDoomLoop(
                      doomLoopBuffer,
                      value.toolName,
                      value.input,
                      input.assistantMessage.sessionID,
                      agent,
                    )
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        metadata: match.state.metadata,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    const errTag = (value.error as { _tag?: string } | undefined)?._tag
                    if (
                      errTag === "PermissionRejectedError" ||
                      errTag === "QuestionRejectedError" ||
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await runSnapshot(
                    Effect.gen(function* () {
                      const snapshot = yield* Snapshot.Service
                      return yield* snapshot.track()
                    }),
                  )
                  await updatePart(
                    trackPart({
                      id: Identifier.ascending("part"),
                      messageID: input.assistantMessage.id,
                      sessionID: input.sessionID,
                      snapshot,
                      type: "step-start" as const,
                    }),
                  )
                  break

                case "finish-step": {
                  const usage = await getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await updatePart(
                    trackPart({
                      id: Identifier.ascending("part"),
                      reason: value.finishReason,
                      snapshot: await runSnapshot(
                        Effect.gen(function* () {
                          const snapshot = yield* Snapshot.Service
                          return yield* snapshot.track()
                        }),
                      ),
                      messageID: input.assistantMessage.id,
                      sessionID: input.assistantMessage.sessionID,
                      type: "step-finish" as const,
                      tokens: usage.tokens,
                      cost: usage.cost,
                    }),
                  )
                  await updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const snapshotHash = snapshot
                    const patch = await runSnapshot(
                      Effect.gen(function* () {
                        const snapshotService = yield* Snapshot.Service
                        return yield* snapshotService.patch(snapshotHash)
                      }),
                    )
                    if (patch.files.length) {
                      await updatePart(
                        trackPart({
                          id: Identifier.ascending("part"),
                          messageID: input.assistantMessage.id,
                          sessionID: input.sessionID,
                          type: "patch" as const,
                          hash: patch.hash,
                          files: patch.files,
                        }),
                      )
                    }
                    snapshot = undefined
                  }
                  void runSummary(
                    Effect.gen(function* () {
                      const summary = yield* SessionSummary.Service
                      yield* summary.summarize({
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.parentID,
                      })
                    }),
                  )
                  if (
                    await runCompaction(
                      Effect.gen(function* () {
                        const compaction = yield* SessionCompaction.Service
                        return yield* compaction.isOverflow({
                          tokens: usage.tokens,
                          model: input.model,
                        })
                      }),
                    )
                  ) {
                    needsCompaction = true
                  }
                  break
                }

                case "text-start":
                  currentText = trackPart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text" as const,
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  })
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += stripDanglingXmlArtifacts(value.text)
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text) await updatePartCoalesced(currentText, value.text)
                  }
                  break

                case "text-end":
                  if (currentText) {
                    const textPart = currentText
                    textPart.text = textPart.text.trimEnd()
                    const textOutput = await runPlugin(
                      Effect.gen(function* () {
                        const plugin = yield* Plugin.Service
                        return yield* plugin.trigger(
                          "experimental.text.complete",
                          {
                            sessionID: input.sessionID,
                            messageID: input.assistantMessage.id,
                            partID: textPart.id,
                          },
                          { text: textPart.text },
                        )
                      }),
                    )
                    textPart.text = textOutput.text
                    textPart.time = {
                      start: textPart.time?.start ?? Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) textPart.metadata = value.providerMetadata
                    // Flush and publish update so UI can update stats
                    Bus.publish(MessageV2.Event.PartUpdated, {
                      part: textPart,
                      delta: "",
                    })
                    await coalescer.flushNow(["part", textPart.messageID, textPart.id]).catch(() => {})
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
          } catch (e: any) {
            const error = MessageV2.fromError(e, {
              providerID: input.model.providerID,
            })
            if (input.abort.aborted || isAbortError(e)) {
              input.assistantMessage.error = error
              break
            }

            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            // Context overflow is handled through retryable provider error classification below.
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              const nextAttempt = attempt + 1
              if (nextAttempt <= SessionRetry.RETRY_MAX_ATTEMPTS) {
                attempt = nextAttempt
                const delay = SessionRetry.delay(
                  attempt,
                  MessageV2.APIError.isInstance(error) ? new MessageV2.APIError(error.data) : undefined,
                )
                for (const id of Object.keys(reasoningMap)) {
                  delete reasoningMap[id]
                }
                await cleanupRetryAttempt(attemptPartIDs)
                await setStatus(input.sessionID, {
                  type: "retry",
                  attempt,
                  message: retry,
                  next: Date.now() + delay,
                })
                try {
                  await SessionRetry.sleep(delay, input.abort)
                  input.abort.throwIfAborted()
                } catch (sleepError) {
                  input.assistantMessage.error = MessageV2.fromError(sleepError, {
                    providerID: input.model.providerID,
                  })
                  Bus.publish(Session.Event.Error, {
                    sessionID: input.assistantMessage.sessionID,
                    error: input.assistantMessage.error,
                  })
                  break
                }
                continue
              }
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          } finally {
            await finishOpenReasoning()
          }
          if (snapshot) {
            const snapshotHash = snapshot
            const patch = await runSnapshot(
              Effect.gen(function* () {
                const snapshotService = yield* Snapshot.Service
                return yield* snapshotService.patch(snapshotHash)
              }),
            )
            if (patch.files.length) {
              await updatePart(
                trackPart({
                  id: Identifier.ascending("part"),
                  messageID: input.assistantMessage.id,
                  sessionID: input.sessionID,
                  type: "patch" as const,
                  hash: patch.hash,
                  files: patch.files,
                }),
              )
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          // Opencode #27895: distinguish tool states during cleanup.
          // - `running`: the tool may still produce a real result; let its
          //   promise settle rather than hard-erroring it.
          // - `pending`: the stream/runtime never finished assembling input;
          //   mark as interrupted so the message carries MessageAbortedError
          //   instead of waiting forever on an empty tool part.
          let pendingInterruptCount = 0
          for (const part of p) {
            if (part.type !== "tool") continue
            if (part.state.status === "completed" || part.state.status === "error") continue
            if (part.state.status === "running") continue // tool will resolve itself
            // pending (or any non-terminal state) — mark interrupted
            pendingInterruptCount++
            await updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: "Tool execution interrupted before completion",
                time: {
                  start: Date.now(),
                  end: Date.now(),
                },
              },
            })
          }
          if (pendingInterruptCount > 0) {
            log.info("marked pending tools as interrupted", {
              count: pendingInterruptCount,
              messageID: input.assistantMessage.id,
            })
          }
          // If the turn was interrupted but the stream ended without throwing
          // (e.g. a tool absorbed the abort and the stream finished normally),
          // the catch above never set an error. Mark it here so the message
          // carries MessageAbortedError and the UI shows "· interrupted".
          if (input.abort.aborted && !input.assistantMessage.error) {
            input.assistantMessage.error = {
              name: "MessageAbortedError",
              data: { message: "Interrupted by user" },
            }
          }
          log.info("interrupt-mark", {
            aborted: input.abort.aborted,
            messageID: input.assistantMessage.id,
            error: input.assistantMessage.error?.name,
          })
          input.assistantMessage.time.completed = Date.now()
          await updateMessage(input.assistantMessage)
          // Flush any remaining coalesced delta writes before returning
          try {
            await coalescer.flushAll()
          } finally {
            // Clear pending state to prevent memory leak across messages
            coalescer.clear()
          }
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }

  export const layer = Layer.succeed(
    Service,
    Service.of({
      create: (input) => Effect.sync(() => createImpl(input)),
    }),
  )

  export const defaultLayer = layer

  export function create(input: CreateInput) {
    return createImpl(input)
  }
}

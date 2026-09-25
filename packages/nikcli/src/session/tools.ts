import { Identifier } from "@nikcli-ai/util/id"
import { MessageV2 } from "./message-v2"
import { Log } from "@nikcli-ai/util/log"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions } from "ai"
import { ProviderTransform } from "@/provider/transform"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "@/mcp"
import { PermissionNext } from "@/permission/next"
import { Flag } from "@nikcli-ai/util/flag"
import { Truncate } from "@/tool/truncation"
import { Tool } from "@/tool/tool"
import { Config } from "@/config/config"
import { Effect } from "effect"
import { InstanceState, runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Session } from "."
import z from "zod"

const log = Log.create({ service: "session.tools" })

/** Default outer bounds when config leaves timeouts unset. */
const DEFAULT_TOOL_TIMEOUT_MS = 600_000
const DEFAULT_TASK_TIMEOUT_MS = 1_800_000

function runConfig<A, E>(effect: Effect.Effect<A, E, Config.Service>) {
  return runPromiseWithLayer(Config.defaultLayer, withCurrentInstance(effect))
}

export function resolveToolTimeoutCategory(toolID: string, source: "registry" | "mcp"): "task" | "tool" {
  return source === "registry" && toolID === "task" ? "task" : "tool"
}

async function resolveToolTimeoutMs(toolID: string, source: "registry" | "mcp"): Promise<number | undefined> {
  const cfg = await runConfig(
    Effect.gen(function* () {
      const config = yield* Config.Service
      return yield* config.get()
    }),
  )
  const experimental = cfg.experimental
  if (resolveToolTimeoutCategory(toolID, source) === "task") {
    const value = experimental?.task_timeout
    if (value === false) return undefined
    return value ?? DEFAULT_TASK_TIMEOUT_MS
  }
  const value = experimental?.tool_timeout
  if (value === false) return undefined
  return value ?? DEFAULT_TOOL_TIMEOUT_MS
}

/**
 * Run a tool under an outer deadline. On timeout the linked AbortSignal fires so
 * cooperative tools (bash, network) can stop; the promise also rejects if the
 * tool ignores abort (hard outer bound).
 */
export async function executeWithTimeout<T>(
  toolID: string,
  run: (ctx: Tool.Context) => Promise<T>,
  ctx: Tool.Context,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return run(ctx)

  const ac = new AbortController()
  const onParentAbort = () => ac.abort()
  if (ctx.abort.aborted) ac.abort()
  else ctx.abort.addEventListener("abort", onParentAbort, { once: true })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutError = () => new Error(`Tool "${toolID}" timed out after ${timeoutMs}ms`)

  const linked: Tool.Context = {
    ...ctx,
    abort: ac.signal,
  }

  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        ac.abort()
        reject(timeoutError())
      }, timeoutMs)

      void run(linked).then(
        (result) => {
          if (!timedOut) resolve(result)
        },
        (error) => {
          if (timedOut) {
            reject(timeoutError())
            return
          }
          reject(error)
        },
      )
    })
  } finally {
    if (timer) clearTimeout(timer)
    ctx.abort.removeEventListener("abort", onParentAbort)
  }
}

export function executeMcpWithTimeout<T>(input: {
  toolID: string
  execute: (args: unknown, options: ToolCallOptions) => Promise<T>
  args: unknown
  options: ToolCallOptions
  context: Tool.Context
  timeoutMs: number | undefined
}) {
  return executeWithTimeout<T>(
    input.toolID,
    (linkedCtx) =>
      input.execute(input.args, {
        ...input.options,
        abortSignal: linkedCtx.abort,
      }),
    input.context,
    input.timeoutMs,
  )
}

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

function truncateOutput(text: string, options: Truncate.Options = {}, agent?: Agent.Info) {
  return runPromiseWithLayer(
    Truncate.defaultLayer,
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      return yield* truncate.output(text, options, agent)
    }),
  )
}

function toolRegistryTools(model: { providerID: string; modelID: string }, agent?: Agent.Info) {
  return runPromiseWithLayer(
    ToolRegistry.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.tools(model, agent)
      }),
    ),
  )
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

function runPlugin<A, E>(effect: Effect.Effect<A, E, Plugin.Service>) {
  return runPromiseWithLayer(Plugin.defaultLayer, withCurrentInstance(effect))
}

function runMCP<A, E>(effect: Effect.Effect<A, E, MCP.Service>) {
  return runPromiseWithLayer(MCP.defaultLayer, withCurrentInstance(effect))
}

function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
  return runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))
}

function sessionUpdatePart(part: MessageV2.Part) {
  return runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.updatePart(part)
    }),
  )
}

export async function resolveTools(input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  tools?: Record<string, boolean>
  processor: {
    message: MessageV2.Assistant
    partFromToolCall(toolCallID: string): MessageV2.ToolPart | undefined
  }
  bypassAgentCheck: boolean
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}

  // Tools the user disabled for this session are dropped entirely: the model
  // never sees their schema and the permission rule is never registered. The
  // same map also carries the opt-in tools, which are dropped until it says
  // otherwise — see `ToolRegistry.enabled`.
  const disabledTools = input.session.disabledTools ?? {}

  // Wholly-denied tools (`{ tool: { "name*": "deny" } }` with pattern "*") are
  // hidden from the model entirely: advertising them wastes context and the
  // model can't invoke them anyway. Resource-scoped denies (pattern != "*")
  // are kept so the tool still appears in the model schema. See opencode #38060.
  // Single choke point for the effective ruleset, so `--auto`/`--yolo` applies uniformly to every
  // agent instead of having to be threaded through each of their permission definitions.
  const effectiveRuleset = () => {
    const merged = PermissionNext.merge(input.agent.permission, input.session.permission ?? [])
    return Flag.autoApprove() ? PermissionNext.autoApprove(merged) : merged
  }

  const permissionRuleset = effectiveRuleset()

  const context = (args: Record<string, unknown>, options: ToolCallOptions): Tool.Context => ({
    sessionID: input.session.id,
    instance: InstanceState.ambient(),
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
    agent: input.agent.name,
    metadata: async (val: { title?: string; metadata?: Record<string, unknown> }) => {
      const match = input.processor.partFromToolCall(options.toolCallId)
      if (match && match.state.status === "running") {
        match.state = {
          ...match.state,
          title: val.title,
          metadata: val.metadata,
        }
        await sessionUpdatePart({
          ...match,
          state: match.state,
        })
      }
    },
    progress: async (update) => {
      const match = input.processor.partFromToolCall(options.toolCallId)
      if (match && match.state.status === "running") {
        match.state = {
          ...match.state,
          structured: { ...update.structured },
          content: [...(update.content ?? [])],
        }
        await sessionUpdatePart({
          ...match,
          state: match.state,
        })
      }
    },
    async ask(req: PermissionNext.AskInput) {
      await askPermission({
        ...req,
        sessionID: input.session.id,
        tool: {
          messageID: input.processor.message.id,
          callID: options.toolCallId,
        },
        ruleset: effectiveRuleset(),
        agent: input.agent.name,
      })
    },
  })

  for (const item of await toolRegistryTools(
    { modelID: input.model.api.id, providerID: input.model.providerID },
    input.agent,
  )) {
    if (!ToolRegistry.visible(item.id, { disabledTools, ruleset: permissionRuleset })) continue
    const schema = ProviderTransform.schema(
      input.model,
      z.toJSONSchema(item.parameters) as import("@ai-sdk/provider").JSONSchema7,
    )
    tools[item.id] = tool({
      id: String(item.id) as `${string}.${string}`,
      description: item.description,
      inputSchema: jsonSchema(schema),
      async execute(args, options) {
        const ctx = context(args, options)
        // Before hook - errors are non-fatal, log and continue
        await runPlugin(
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.trigger(
              "tool.execute.before",
              {
                tool: item.id,
                sessionID: ctx.sessionID,
                agent: ctx.agent,
                messageID: ctx.messageID,
                callID: ctx.callID,
              },
              {
                args,
              },
            )
          }),
        ).catch((err) => {
          log.debug("plugin trigger failed", {
            error: String(err),
            tool: item.id,
          })
        })
        const timeoutMs = await resolveToolTimeoutMs(item.id, "registry")
        const result = await executeWithTimeout(
          item.id,
          (linkedCtx) => item.executeAsync(args, linkedCtx),
          ctx,
          timeoutMs,
        )
        // After hook - errors are non-fatal, log and continue
        await runPlugin(
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.trigger(
              "tool.execute.after",
              {
                tool: item.id,
                sessionID: ctx.sessionID,
                agent: ctx.agent,
                messageID: ctx.messageID,
                callID: ctx.callID,
              },
              result,
            )
          }),
        ).catch((err) => {
          log.debug("plugin trigger failed", {
            error: String(err),
            tool: item.id,
          })
        })
        return result
      },
      toModelOutput(result) {
        return {
          type: "text",
          value: result.output,
        }
      },
    })
  }

  const mcpTools = await runMCP(
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      return yield* mcp.tools()
    }),
  )
  for (const [key, item] of Object.entries(mcpTools)) {
    if (!ToolRegistry.visible(key, { disabledTools, ruleset: permissionRuleset })) continue
    const execute = item.execute
    if (!execute) continue

    item.execute = async (args, opts) => {
      const ctx = context(args, opts)

      await runPlugin(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.trigger(
            "tool.execute.before",
            {
              tool: key,
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              messageID: ctx.messageID,
              callID: opts.toolCallId,
            },
            {
              args,
            },
          )
        }),
      ).catch((err) => {
        log.debug("plugin trigger failed", { error: String(err), tool: key })
      })

      await ctx.ask({
        permission: key,
        metadata: {},
        patterns: ["*"],
        always: ["*"],
      })

      const timeoutMs = await resolveToolTimeoutMs(key, "mcp")
      const result = await executeMcpWithTimeout<Awaited<ReturnType<typeof execute>>>({
        toolID: key,
        execute,
        args,
        options: opts,
        context: ctx,
        timeoutMs,
      })

      await runPlugin(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.trigger(
            "tool.execute.after",
            {
              tool: key,
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              messageID: ctx.messageID,
              callID: opts.toolCallId,
            },
            result,
          )
        }),
      ).catch((err) => {
        log.debug("plugin trigger failed", { error: String(err), tool: key })
      })

      const textParts: string[] = []
      const attachments: MessageV2.FilePart[] = []

      for (const contentItem of result.content) {
        if (contentItem.type === "text") {
          textParts.push(contentItem.text)
        } else if (contentItem.type === "image") {
          attachments.push({
            id: Identifier.ascending("part"),
            sessionID: input.session.id,
            messageID: input.processor.message.id,
            type: "file",
            mime: contentItem.mimeType,
            url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
          })
        } else if (contentItem.type === "resource") {
          const { resource } = contentItem
          if (resource.text) {
            textParts.push(resource.text)
          }
          if (resource.blob) {
            attachments.push({
              id: Identifier.ascending("part"),
              sessionID: input.session.id,
              messageID: input.processor.message.id,
              type: "file",
              mime: resource.mimeType ?? "application/octet-stream",
              url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
              filename: resource.uri,
            })
          }
        }
      }

      const truncated = await truncateOutput(textParts.join("\n\n"), {}, input.agent)
      const metadata = {
        ...result.metadata,
        truncated: truncated.truncated,
        ...(truncated.truncated && { outputPath: truncated.outputPath }),
      }

      return {
        title: "",
        metadata,
        output: truncated.content,
        attachments,
        content: result.content,
      }
    }
    item.toModelOutput = (result) => {
      return {
        type: "text",
        value: result.output,
      }
    }
    tools[key] = item
  }

  const { Connectors } = await import("@/connectors")
  for (const [key, item] of Object.entries(await Connectors.tools())) {
    // Same visibility rule as registry and MCP tools. Connector tools used to
    // honour permission denials but ignore `disabledTools`, so switching one off
    // did nothing the moment the toggle surfaces them.
    if (!ToolRegistry.visible(key, { disabledTools, ruleset: permissionRuleset })) continue
    const execute = item.execute
    if (!execute) continue

    item.execute = async (args, opts) => {
      const ctx = context(args, opts)

      await runPlugin(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.trigger(
            "tool.execute.before",
            {
              tool: key,
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              messageID: ctx.messageID,
              callID: opts.toolCallId,
            },
            {
              args,
            },
          )
        }),
      ).catch((err) => {
        log.debug("plugin trigger failed", { error: String(err), tool: key })
      })

      await ctx.ask({
        permission: key,
        metadata: {},
        patterns: ["*"],
        always: ["*"],
      })

      const result = await execute(args, opts)

      await runPlugin(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.trigger(
            "tool.execute.after",
            {
              tool: key,
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              messageID: ctx.messageID,
              callID: opts.toolCallId,
            },
            result,
          )
        }),
      ).catch((err) => {
        log.debug("plugin trigger failed", { error: String(err), tool: key })
      })

      const textOutput = typeof result === "string" ? result : JSON.stringify(result, null, 2)
      const truncated = await truncateOutput(textOutput, {}, input.agent)

      return {
        title: "",
        metadata: { truncated: truncated.truncated },
        output: truncated.content,
        content: [{ type: "text", text: truncated.content }],
      }
    }
    item.toModelOutput = (result) => {
      return {
        type: "text",
        value: result.output,
      }
    }
    tools[key] = item
  }

  // Emit tools in canonical name order so semantically equivalent sets produce
  // byte-identical tool arrays regardless of registration order. Registry, MCP
  // and connector tools are collected by insertion order above, and MCP servers
  // connect in a nondeterministic order — without this sort the provider tool
  // array shifts between runs. Tool definitions sit ahead of system and message
  // blocks in the provider cache prefix, so any reordering invalidates every
  // downstream prompt-cache breakpoint. See opencode #38590.
  return Object.fromEntries(Object.entries(tools).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
}

export function createStructuredOutputTool(input: {
  schema: Record<string, unknown>
  onSuccess: (output: unknown) => void
}): AITool {
  const { $schema: _$schema, ...toolSchema } = input.schema

  return tool({
    id: "StructuredOutput" as `${string}.${string}`,
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as Parameters<typeof jsonSchema>[0]),
    async execute(args) {
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput(result) {
      return {
        type: "text",
        value: result.output,
      }
    },
  })
}

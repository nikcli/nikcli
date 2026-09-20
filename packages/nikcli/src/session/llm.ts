import os from "os"
import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@nikcli-ai/util/log"
import {
  convertToModelMessages,
  modelMessageSchema,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  type UIMessage,
  extractReasoningMiddleware,
  tool,
  jsonSchema,
} from "ai"
import { LLMCore, Runtime as LLMRuntime, ToolChoice, type ProviderOptions } from "@nikcli-ai/llm"
import type { JsonValue } from "@/util/json"
import z from "zod"
import {
  Message as LLMMessage,
  type ModelRef,
  type ContentPart,
  type ToolDefinition,
  LLMRequest as LLMRequestClass,
  SystemPart,
  GenerationOptions,
  HttpOptions,
} from "@nikcli-ai/llm"
import { clone, mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { CacheDiagnostics } from "@/provider/cache-diagnostics"
import { Config } from "@/config/config"
import { features } from "@nikcli-ai/util/features"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@nikcli-ai/util/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { Effect } from "effect"
import { InstanceState, runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { suppressEmptyTextResult, toProcessorStream } from "./llm/llm-event-adapter"
import * as LLMCoverage from "./llm/coverage"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  // Only allocated when the flag is on, so the default path keeps no snapshots.
  const cacheDiagnostics = Flag.NIKCLI_PROMPT_CACHE_DIAGNOSTICS ? new CacheDiagnostics.Tracker() : undefined
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  function runAuth<A, E>(effect: Effect.Effect<A, E, Auth.Service>) {
    return runPromiseWithLayer(Auth.defaultLayer, effect)
  }

  function runPlugin<A, E>(effect: Effect.Effect<A, E, Plugin.Service>) {
    return runPromiseWithLayer(Plugin.defaultLayer, withCurrentInstance(effect))
  }

  function runProvider<A, E>(effect: Effect.Effect<A, E, Provider.Service>) {
    return runPromiseWithLayer(Provider.defaultLayer, withCurrentInstance(effect))
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

  // Build request headers based on provider and model configuration
  function buildRequestHeaders(
    projectID: string,
    providerID: string,
    sessionID: string,
    userID: string,
    isCodex: boolean,
    _modelHeaders?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (isCodex) {
      return {
        originator: "nikcli",
        "User-Agent": `nikcli/${Installation.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        session_id: sessionID,
      }
    }

    if (providerID.startsWith("nikcli")) {
      return {
        "x-nikcli-project": projectID,
        "x-nikcli-session": sessionID,
        "x-nikcli-request": userID,
        "x-nikcli-client": Flag.NIKCLI_CLIENT,
      }
    }

    if (providerID !== "anthropic") {
      return {
        "User-Agent": `nikcli/${Installation.VERSION}`,
      }
    }

    // Return undefined for anthropic (no extra headers needed)
    return undefined
  }

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  type StreamMessageInput = ModelMessage | UIMessage | JsonValue

  interface ProviderCallOptions {
    [key: string]: JsonValue | undefined
  }

  const UIMessageEnvelope = z.object({
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.unknown()),
  })

  const PartsOnlyMessage = z.object({
    parts: z.array(z.unknown()),
    content: z.undefined(),
  })

  const RepairablePart = z
    .object({
      type: z.string().catch(""),
      text: z.string().catch(""),
    })
    .catch({ type: "", text: "" })

  const RepairableMessage = z.object({
    role: z.enum(["user", "assistant", "system"]).catch("user"),
    parts: z.array(RepairablePart).optional().catch(undefined),
    content: z.string().optional().catch(undefined),
  })

  function isModelMessage(message: StreamMessageInput): message is ModelMessage {
    return modelMessageSchema.safeParse(message).success
  }

  function isUIMessage(message: StreamMessageInput): message is UIMessage {
    return UIMessageEnvelope.safeParse(message).success
  }

  // Some messages reach `normalizeStreamMessages` shaped like UIMessages but
  // with roles outside `user`/`assistant` (e.g. a `system` carrying a `parts`
  // array, or an empty role). These slip past both `isModelMessage` and
  // `isUIMessage`, so the legacy cast pushed them straight to streamText and
  // triggered `AI_InvalidPromptError`. `looksLikeUIMessage` widens detection
  // so the normalizer can repair them.
  function looksLikeUIMessage(message: StreamMessageInput): boolean {
    return PartsOnlyMessage.safeParse(message).success
  }

  // Best-effort repair: collapse a malformed UI-shaped message into a single
  // string-content ModelMessage by concatenating any `text`/`reasoning` parts.
  // Returns undefined when there's nothing salvageable so the caller can drop
  // the message instead of forwarding garbage to the model.
  function repairMessage(message: StreamMessageInput): ModelMessage | undefined {
    const parsed = RepairableMessage.safeParse(message)
    if (!parsed.success) return undefined
    const { role, parts, content } = parsed.data
    if (parts) {
      const text = parts
        .filter((p) => p.type === "text" || p.type === "reasoning")
        .map((p) => p.text)
        .join("")
        .trim()
      if (text.length === 0) return undefined
      return { role, content: text } as ModelMessage
    }
    if (content !== undefined && content.length > 0) {
      return { role, content } as ModelMessage
    }
    return undefined
  }

  function uiToolOutput(output: JsonValue) {
    const asText = z.string().safeParse(output)
    if (asText.success) return { type: "text" as const, value: asText.data }
    return { type: "json" as const, value: output as never }
  }

  function uiMessageTools(messages: UIMessage[]) {
    const tools: Record<string, { toModelOutput: typeof uiToolOutput }> = {}
    for (const message of messages) {
      for (const part of message.parts) {
        if (!part.type.startsWith("tool-")) continue
        tools[part.type.slice("tool-".length)] = {
          toModelOutput: uiToolOutput,
        }
      }
    }
    return tools
  }

  export function normalizeStreamMessages(messages: StreamMessageInput[]): ModelMessage[] {
    const result: ModelMessage[] = []
    let uiRun: UIMessage[] = []

    const flushUIRun = () => {
      if (uiRun.length === 0) return
      result.push(
        ...convertToModelMessages(uiRun, {
          tools: uiMessageTools(uiRun) as unknown as ToolSet,
        }),
      )
      uiRun = []
    }

    for (const message of messages) {
      if (isModelMessage(message)) {
        flushUIRun()
        result.push(message)
        continue
      }
      if (isUIMessage(message)) {
        uiRun.push(message)
        continue
      }
      // Widened: anything UI-shaped (has `parts`) that isn't strictly a
      // UIMessage gets routed through the same convertToModelMessages path
      // by repairing the role to user.
      if (looksLikeUIMessage(message)) {
        const candidate = message as {
          role?: unknown
          parts: UIMessage["parts"]
        }
        const role: UIMessage["role"] = candidate.role === "assistant" ? "assistant" : "user"
        uiRun.push({ ...(message as object), role } as UIMessage)
        continue
      }
      // Last resort: try to recover a plain string-content ModelMessage from
      // arbitrary garbage. If that fails, drop the message with a warning so
      // it never reaches streamText (where it would throw the opaque
      // AI_InvalidPromptError).
      const repaired = repairMessage(message)
      if (repaired) {
        flushUIRun()
        result.push(repaired)
        continue
      }
      log.warn("dropping malformed message before streamText", {
        snapshot: JSON.stringify(message).slice(0, 200),
      })
    }

    flushUIRun()
    return result
  }

  export async function stream(input: StreamInput) {
    // One read at the entry, for the `x-nikcli-project` header built in two
    // places below. Reading it inside the header builder put it on whichever
    // fiber the request happened to be assembled on.
    const projectID = InstanceState.ambient().project.id
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [{ language, provider, modelRef }, cfg, auth] = await Promise.all([
      runProvider(
        Effect.gen(function* () {
          const service = yield* Provider.Service
          const language = yield* service.getLanguage(input.model)
          const provider = yield* service.getProvider(input.model.providerID)
          const modelRef = yield* service.getModelRef(input.model)
          return { language, provider, modelRef }
        }),
      ),
      configGet(),
      runAuth(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          return yield* auth.get(input.model.providerID)
        }),
      ),
    ])
    if (!provider) {
      throw new Provider.ModelNotFoundError({
        providerID: input.model.providerID,
        modelID: input.model.id,
      })
    }
    if (modelRef) {
      l.debug("model ref resolved", {
        route: modelRef.route,
        baseURL: modelRef.baseURL,
        modelID: modelRef.id,
        providerID: modelRef.provider,
      })
    } else {
      // `mapToModelRef` returned undefined. Safe — the AI SDK takes the turn —
      // and invisible until now: this is the branch `specs/v2/todo.md` calls
      // "coverage is invisible". See `session/llm/coverage.ts`.
      LLMCoverage.record({
        outcome: "unmapped",
        providerID: input.model.providerID,
        modelID: input.model.id,
      })
    }
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = SystemPrompt.header(input.model.providerID)
    system.push(
      [
        // use agent prompt otherwise provider prompt
        // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    const original = clone(system)
    await runPlugin(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        yield* plugin.trigger("experimental.chat.system.transform", { sessionID: input.sessionID }, { system })
      }),
    )
    if (system.length === 0) {
      system.push(...original)
    }
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const merged = pipe(base, mergeDeep(input.model.options), mergeDeep(input.agent.options), mergeDeep(variant))
    // SAFETY: the bag is assembled from zod-validated config/catalog/agent options and
    // JSON-shaped plugin payloads; the LLM boundary consumes it as JSON call options.
    const options = (isCodex ? { ...merged, instructions: SystemPrompt.instructions() } : merged) as ProviderCallOptions

    const params = await runPlugin(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return yield* plugin.trigger(
          "chat.params",
          {
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            provider,
            message: input.user,
          },
          {
            temperature: input.model.capabilities.temperature
              ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
              : undefined,
            topP: input.agent.topP ?? ProviderTransform.topP(input.model),
            topK: ProviderTransform.topK(input.model),
            options,
          },
        )
      }),
    )

    const nativeLlmEnabled = features(cfg).nativeLlm

    // Debug-only route compile when native runtime is off (AI SDK still handles HTTP).
    if (modelRef && !nativeLlmEnabled) {
      // A ModelRef exists and the flag is down, so this turn would have gone
      // native. Counting it is how the soak in EOT-11 runs without flipping
      // anything on.
      LLMCoverage.record({
        outcome: "disabled",
        providerID: modelRef.provider,
        modelID: modelRef.id,
      })
      try {
        const llmRequest = buildLLMRequest(
          input,
          modelRef,
          {
            temperature: params.temperature,
            topP: params.topP,
            topK: params.topK,
            options: params.options,
          },
          buildRequestHeaders(
            projectID,
            input.model.providerID,
            input.sessionID,
            input.user.id,
            isCodex,
            input.model.headers,
          ),
        )
        const prepared = await LLMRuntime.prepareRequest(llmRequest)
        l.debug("LLM request prepared via @nikcli-ai/llm route", {
          modelID: modelRef.id,
          providerID: modelRef.provider,
          route: prepared.route,
          protocol: prepared.protocol,
          msgCount: llmRequest.messages.length,
          toolCount: llmRequest.tools.length,
        })
      } catch (e) {
        l.warn("LLM request prepare failed (non-fatal)", { error: String(e) })
      }
    }

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    const resolvedTools = await resolveTools(input)
    // xAI multi-agent models reject client-side function tools ("Client-side tools
    // for multi-agent models require beta access") — they only run xAI's built-in
    // server-side tools. Drop client-side tools for them so the session doesn't 400.
    const tools = ProviderTransform.tools(input.model, resolvedTools)
    if (Object.keys(resolvedTools).length > 0 && Object.keys(tools).length === 0) {
      l.warn("dropping client-side tools (model does not support them)", {
        modelID: input.model.api.id,
        providerID: input.model.providerID,
        dropped: Object.keys(resolvedTools).length,
      })
    }
    const providerOptions = ProviderTransform.providerOptions(input.model, params.options)
    const openrouterOptions = providerOptions.openrouter
    const fusionPlugin = Array.isArray(openrouterOptions?.plugins)
      ? openrouterOptions.plugins.find((plugin: any) => plugin?.id === "fusion")
      : undefined
    if (fusionPlugin && process.env.NIKCLI_DEBUG_OPENROUTER_FUSION === "1") {
      l.info("openrouter fusion request options", {
        modelID: input.model.api.id,
        variant: input.user.variant,
        openrouterOptions,
      })
    }

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    const messages = normalizeStreamMessages([
      ...(isCodex
        ? [
            {
              role: "user",
              content: system.join("\n\n"),
            } as ModelMessage,
          ]
        : system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          )),
      ...input.messages,
    ])

    const requestHeaders = buildRequestHeaders(
      projectID,
      input.model.providerID,
      input.sessionID,
      input.user.id,
      isCodex,
      input.model.headers,
    )

    if (nativeLlmEnabled && modelRef) {
      const nativeStatus = LLMNativeRuntime.status({
        model: input.model,
        provider,
        auth,
        modelRef,
      })
      if (nativeStatus.type === "supported") {
        l.debug("llm.runtime", { runtime: "native", route: modelRef.route })
        try {
          const nativeResult = await streamNative({
            streamInput: input,
            modelRef,
            provider,
            auth,
            params,
            providerOptions,
            maxOutputTokens,
            messages,
            tools,
            headers: requestHeaders,
            isCodex,
            l,
          })
          // A falsy result is the late refusal inside `streamNative`, which
          // records `ineligible-late` itself — it is the only place the reason
          // exists.
          if (nativeResult) {
            LLMCoverage.record({
              outcome: "native",
              providerID: modelRef.provider,
              modelID: modelRef.id,
            })
            return nativeResult
          }
        } catch (e) {
          l.warn("native llm stream failed, falling back to ai-sdk", {
            error: String(e),
          })
          LLMCoverage.record({
            outcome: "fallback",
            providerID: modelRef.provider,
            modelID: modelRef.id,
          })
        }
      } else {
        l.debug("native llm ineligible, using ai-sdk", {
          reason: nativeStatus.reason,
        })
        LLMCoverage.record({
          outcome: "ineligible",
          providerID: modelRef.provider,
          modelID: modelRef.id,
          reason: nativeStatus.reason,
        })
      }
    }

    l.debug("llm.runtime", { runtime: "ai-sdk" })

    const result = LLMCore.stream({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        const repaired = Object.keys(tools).find((toolName) => toolName.toLowerCase() === lower)
        if (repaired && repaired !== failed.toolCall.toolName) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired,
          })
          return {
            ...failed.toolCall,
            toolName: repaired,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions,
      activeTools: Object.keys(tools).filter((x) => x !== "invalid" && x !== "_noop"),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      maxRetries: input.retries ?? 0,
      headers: requestHeaders,
      messages,
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                args.params.prompt = ProviderTransform.message(
                  args.params.prompt as unknown as ModelMessage[],
                  input.model,
                  options,
                ) as unknown as typeof args.params.prompt
              }
              // Snapshot after the transform: this is the wire-level request,
              // cache markers included, so the diff reflects what the provider
              // actually matches against.
              if (cacheDiagnostics) {
                const { comparison, snapshot } = cacheDiagnostics.record(input.sessionID, {
                  prompt: args.params.prompt as unknown as CacheDiagnostics.RequestLike["prompt"],
                  tools: args.params.tools as unknown as CacheDiagnostics.RequestLike["tools"],
                  settings: {
                    model: input.model.id,
                    providerID: input.model.providerID,
                    temperature: args.params.temperature,
                    topP: args.params.topP,
                    topK: args.params.topK,
                    maxOutputTokens: args.params.maxOutputTokens,
                    toolChoice: args.params.toolChoice,
                    providerOptions: args.params.providerOptions,
                  },
                })
                log.info("prompt cache prefix", {
                  sessionID: input.sessionID,
                  toolCount: snapshot.tools.length,
                  systemParts: snapshot.system.length,
                  messageCount: snapshot.messages.length,
                  ...comparison,
                })
              }
              return args.params
            },
          },
          extractReasoningMiddleware({
            tagName: "think",
            startWithReasoning: false,
          }),
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry ?? true,
      },
    })
    // Suppress unhandled NoContentGeneratedError when model produces only tool calls (no text).
    // processor.ts consumes fullStream only; stream.text rejects if no text is generated.
    return LLMCore.suppressNoContentText(result)
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const tools = { ...input.tools }
    const disabled = PermissionNext.disabled(Object.keys(tools), input.agent.permission)
    for (const tool of Object.keys(tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete tools[tool]
      }
    }
    return tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

  // ── @nikcli-ai/llm converters ──────────────────────────────────────────

  /**
   * Convert an AI SDK TextPart / ImagePart / FilePart into a @nikcli-ai/llm ContentPart.
   */
  const TextValue = z.string()

  function toLLMContentPart(part: ModelMessage["content"][number]): ContentPart | undefined {
    if (typeof part === "string") {
      return { type: "text" as const, text: part }
    }
    switch (part.type) {
      case "text":
        return { type: "text" as const, text: (part as any).text }
      case "image": {
        const p = part as any
        const image = TextValue.safeParse(p.image)
        if (image.success) {
          return {
            type: "media" as const,
            mediaType: p.mimeType ?? "image/png",
            data: image.data,
          }
        }
        return p.image instanceof Uint8Array
          ? {
              type: "media" as const,
              mediaType: p.mimeType ?? "image/png",
              data: p.image,
            }
          : undefined
      }
      case "file": {
        const p = part as any
        const inline = TextValue.safeParse(p.data)
        if (inline.success) {
          const match = /^data:([^;]+);/.exec(inline.data)
          return {
            type: "media" as const,
            mediaType: match?.[1] ?? p.mimeType ?? "application/octet-stream",
            data: inline.data,
          }
        }
        return p.data instanceof Uint8Array
          ? {
              type: "media" as const,
              mediaType: p.mimeType ?? "application/octet-stream",
              data: p.data,
            }
          : undefined
      }
      default:
        return undefined
    }
  }

  /**
   * Convert an AI SDK ModelMessage[] into @nikcli-ai/llm Message[].
   */
  function modelMessagesToLLMMessages(
    msgs: ModelMessage[],
  ): typeof LLMMessage extends new (...args: any[]) => infer I ? I[] : any[] {
    const result: any[] = []
    for (const msg of msgs) {
      switch (msg.role) {
        case "user": {
          const userText = TextValue.safeParse(msg.content)
          const parts: ContentPart[] = userText.success
            ? userText.data
              ? [{ type: "text" as const, text: userText.data }]
              : []
            : Array.isArray(msg.content)
              ? msg.content.map(toLLMContentPart).filter((p): p is ContentPart => p !== undefined)
              : []
          if (parts.length > 0) result.push(LLMMessage.user(parts))
          break
        }
        case "assistant": {
          const parts: ContentPart[] = []
          const assistantText = TextValue.safeParse(msg.content)
          if (assistantText.success) {
            if (assistantText.data) parts.push({ type: "text" as const, text: assistantText.data })
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              const p = part as any
              if (p.type === "text") {
                parts.push({ type: "text" as const, text: p.text })
              } else if (p.type === "reasoning") {
                parts.push({ type: "reasoning" as const, text: p.text })
              }
            }
          }
          // Map tool calls from the assistant message (AI SDK format varies by version)
          const toolCalls = (msg as any).tool_calls ?? (msg as any).parts?.filter((p: any) => p.type === "tool-call")
          if (toolCalls) {
            for (const tc of toolCalls) {
              try {
                parts.push({
                  type: "tool-call" as const,
                  id: tc.id ?? tc.toolCallId ?? `tc-${parts.length}`,
                  name: tc.function?.name ?? tc.toolName ?? "unknown",
                  input: tc.function?.arguments
                    ? TextValue.safeParse(tc.function.arguments).success
                      ? JSON.parse(tc.function.arguments)
                      : tc.function.arguments
                    : (tc.input ?? {}),
                } as ContentPart)
              } catch {
                parts.push({
                  type: "tool-call" as const,
                  id: tc.id ?? tc.toolCallId ?? `tc-${parts.length}`,
                  name: tc.function?.name ?? tc.toolName ?? "unknown",
                  input: {},
                } as ContentPart)
              }
            }
          }
          if (parts.length > 0) result.push(LLMMessage.assistant(parts))
          break
        }
        case "tool": {
          const toolText = TextValue.safeParse(msg.content)
          const text = toolText.success
            ? toolText.data
            : Array.isArray(msg.content)
              ? msg.content
                  .map((p: any) => {
                    const part = TextValue.safeParse(p)
                    return part.success ? part.data : (p.text ?? "")
                  })
                  .join("\n")
              : String((msg as any).content ?? "")
          result.push(
            LLMMessage.tool({
              type: "tool-result" as const,
              id: (msg as any).tool_call_id ?? `tr-${result.length}`,
              name: (msg as any).tool_call_name ?? "unknown",
              result: { type: "text" as const, value: text },
            }),
          )
          break
        }
      }
    }
    return result
  }

  /**
   * Convert an AI SDK Tool map into @nikcli-ai/llm ToolDefinition[].
   */
  function toLLMToolDefinitions(tools: Record<string, Tool>): ToolDefinition[] {
    return Object.entries(tools)
      .filter(([, t]) => !!t.description)
      .map(([name, t]) => ({
        name,
        description: t.description ?? "",
        inputSchema: (t as any).parameters ?? (t as any).inputSchema ?? {},
      })) as ToolDefinition[]
  }

  /**
   * Build an @nikcli-ai/llm LLMRequest from the stream input and resolved ModelRef.
   */
  export function buildLLMRequest(
    input: StreamInput,
    modelRef: ModelRef,
    genParams: {
      temperature?: number
      topP?: number
      topK?: number
      maxOutputTokens?: number
      providerOptions?: ProviderOptions
      options?: ProviderCallOptions
    },
    headers?: Record<string, string>,
    messagesOverride?: ModelMessage[],
  ): LLMRequestClass {
    // System parts
    const system = SystemPart.content(input.system.join("\n\n"))

    // Messages
    const messages = modelMessagesToLLMMessages(messagesOverride ?? input.messages)

    // Generation options
    const maxTokens = genParams.maxOutputTokens ?? (genParams.options?.["maxOutputTokens"] as number | undefined)
    const generation = new GenerationOptions({
      maxTokens,
      temperature: genParams.temperature,
      topP: genParams.topP,
      topK: genParams.topK,
    })
    const hasGen = Object.values(generation).some((v) => v !== undefined)

    // HTTP options
    const httpOptions = headers && Object.keys(headers).length > 0 ? new HttpOptions({ headers }) : undefined

    // Tool definitions
    const tools = toLLMToolDefinitions(input.tools)

    return new LLMRequestClass({
      model: modelRef,
      system,
      messages,
      tools,
      generation: hasGen ? generation : undefined,
      providerOptions: genParams.providerOptions,
      http: httpOptions,
      toolChoice:
        input.toolChoice === "required"
          ? ToolChoice.make("any")
          : input.toolChoice === "none"
            ? ToolChoice.make("none")
            : undefined,
    })
  }

  const ProviderOptionBag = z.record(z.string(), z.unknown())

  function providerOptionsForLLM(providerOptions: ProviderCallOptions): ProviderOptions {
    const out = new Map<string, ProviderOptions[string]>()
    for (const [key, value] of Object.entries(providerOptions)) {
      const parsed = ProviderOptionBag.safeParse(value)
      if (parsed.success) out.set(key, parsed.data)
    }
    return Object.fromEntries(out)
  }

  async function streamNative(input: {
    streamInput: StreamInput
    modelRef: ModelRef
    provider: Provider.Info
    auth: Auth.Info | undefined
    params: {
      temperature?: number
      topP?: number
      topK?: number
      options?: ProviderCallOptions
    }
    providerOptions: ProviderCallOptions
    maxOutputTokens: number | undefined
    messages: ModelMessage[]
    tools: Record<string, Tool>
    headers: Record<string, string> | undefined
    isCodex: boolean
    l: ReturnType<typeof log.clone>
  }) {
    const llmRequest = buildLLMRequest(
      { ...input.streamInput, tools: input.tools },
      input.modelRef,
      {
        temperature: input.params.temperature,
        topP: input.params.topP,
        topK: input.params.topK,
        maxOutputTokens: input.maxOutputTokens,
        providerOptions: providerOptionsForLLM(input.providerOptions),
        options: input.params.options,
      },
      input.headers,
      input.messages,
    )

    const native = LLMNativeRuntime.streamRequestOnly({
      model: input.streamInput.model,
      provider: input.provider,
      auth: input.auth,
      modelRef: input.modelRef,
      llmRequest,
      messages: input.messages,
      abort: input.streamInput.abort,
    })

    if (native.type === "unsupported") {
      input.l.debug("native llm unsupported, falling back to ai-sdk", {
        reason: native.reason,
      })
      // Distinct from the pre-flight `ineligible`: that one is a configuration
      // verdict, this one is the route refusing once it has been compiled. Same
      // user-visible outcome, different thing to fix.
      LLMCoverage.record({
        outcome: "ineligible-late",
        providerID: input.modelRef.provider,
        modelID: input.modelRef.id,
        reason: native.reason,
      })
      return undefined
    }

    const fullStream = toProcessorStream(native.events)
    return suppressEmptyTextResult({
      fullStream,
      text: Promise.resolve(""),
    }) as unknown as StreamOutput
  }
}

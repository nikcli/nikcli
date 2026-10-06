import { streamText, wrapLanguageModel, extractReasoningMiddleware, jsonSchema } from "./ai-sdk"
import type { LanguageModelV2, ModelMessage as SDKMessage, ToolSet } from "./ai-sdk"
import type { ModelMessage, Tool, StreamOutput } from "@/session/llm/types"
import { ProviderTransform } from "../transform"
import type { Provider } from "../provider"

export function streamLegacy(input: {
  language: LanguageModelV2
  model: Provider.Model
  messages: ModelMessage[]
  tools: Record<string, Tool>
  deferred?: ReadonlySet<string>
  options: Record<string, any>
  providerOptions: Record<string, any>
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  toolChoice?: "auto" | "required" | "none"
  abort: AbortSignal
  retries?: number
  headers?: Record<string, string>
}): StreamOutput {
  const tools: ToolSet = Object.fromEntries(
    Object.entries(input.tools).map(([name, definition]) => [
      name,
      {
        ...definition,
        inputSchema: jsonSchema(
          (definition.inputSchema?.jsonSchema ?? {
            type: "object",
            properties: {},
          }) as Parameters<typeof jsonSchema>[0],
          {
            validate: definition.inputSchema?.validate,
          },
        ),
      },
    ]),
  ) as ToolSet
  const result = streamText({
    model: wrapLanguageModel({
      model: input.language,
      middleware: [
        {
          async transformParams(args) {
            if (args.type === "stream")
              args.params.prompt = ProviderTransform.message(
                args.params.prompt as unknown as ModelMessage[],
                input.model,
                input.options,
              ) as unknown as typeof args.params.prompt
            return args.params
          },
        },
        extractReasoningMiddleware({
          tagName: "think",
          startWithReasoning: false,
        }),
      ],
    }),
    messages: input.messages as SDKMessage[],
    tools,
    activeTools: Object.keys(tools).filter(
      (name) => name !== "invalid" && name !== "_noop" && !input.deferred?.has(name),
    ),
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions: input.providerOptions,
    abortSignal: input.abort,
    maxRetries: input.retries ?? 0,
    headers: input.headers,
    async experimental_repairToolCall(failed) {
      const repaired = Object.keys(tools).find((name) => name.toLowerCase() === failed.toolCall.toolName.toLowerCase())
      if (repaired && repaired !== failed.toolCall.toolName) return { ...failed.toolCall, toolName: repaired }
      return {
        ...failed.toolCall,
        toolName: "invalid",
        input: JSON.stringify({
          tool: failed.toolCall.toolName,
          error: failed.error.message,
        }),
      }
    },
  })
  void result.text.catch(() => {})
  return result as unknown as StreamOutput
}

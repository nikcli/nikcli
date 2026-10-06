import { generateText, generateObject, jsonSchema } from "./ai-sdk"
import type { ModelMessage as SDKMessage } from "./ai-sdk"
import { Effect } from "effect"
import { Provider } from "../provider"
import { ProviderTransform } from "../transform"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import type { CallInput } from "@/session/llm/call"
import type { JSONSchema7, ModelMessage } from "@/session/llm/types"

async function options(input: CallInput) {
  input.abort?.throwIfAborted()
  const language = await runPromiseWithLayer(
    Provider.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        return yield* (yield* Provider.Service).getLanguage(input.model)
      }),
    ),
  )
  const system = typeof input.system === "string" ? [input.system] : [...(input.system ?? [])]
  const messages: ModelMessage[] = [
    ...system.filter(Boolean).map((content) => ({ role: "system" as const, content })),
    ...(input.messages ?? []),
    ...(input.prompt === undefined ? [] : [{ role: "user" as const, content: input.prompt }]),
  ]
  return {
    model: language,
    messages: ProviderTransform.message(messages, input.model, input.providerOptions ?? {}) as SDKMessage[],
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions: ProviderTransform.providerOptions(input.model, input.providerOptions ?? {}),
    abortSignal: input.abort,
    headers: input.headers,
    maxRetries: 0,
  }
}

export async function generateLegacyText(input: CallInput) {
  const result = await generateText(await options(input))
  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  }
}

export async function generateLegacyObject(input: CallInput & { schema: JSONSchema7 }) {
  const result = await generateObject({
    ...(await options(input)),
    schema: jsonSchema(input.schema as Parameters<typeof jsonSchema>[0]),
  })
  return { object: result.object }
}

import type { ModelMessage, ToolResultPart } from "ai"
import { mergeDeep } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Provider } from "./provider"
import * as CachePolicy from "./cache-policy"
import type { ModelsDev } from "./models"
import { iife } from "@nikcli-ai/util/iife"
import { Log } from "@nikcli-ai/util/log"

const log = Log.create({ service: "provider.transform" })

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export const OUTPUT_TOKEN_MAX = 32_000

// OpenAI Responses `include` value that returns the encrypted reasoning state
// needed for stateless multi-turn reasoning (store: false). Hoisted so every
// branch that requests it stays in lockstep.
const INCLUDE_ENCRYPTED_REASONING = ["reasoning.encrypted_content"] as const

const SURROGATE_RANGE = /[\uD800-\uDFFF]/
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function sanitizeSurrogates(content: string) {
  // Fast path: this runs over every string of every message on every request,
  // and the lookaround regex is much slower than a plain range test. Strings
  // without any surrogate-range chars (the overwhelmingly common case) bail
  // here and keep their identity, which also avoids churn in the in-place
  // message sanitization pass.
  if (!SURROGATE_RANGE.test(content)) return content
  return content.replace(LONE_SURROGATE, "\uFFFD")
}

// Maps npm package to the key the AI SDK expects for providerOptions
function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/github-copilot":
      return "copilot"
    case "@ai-sdk/azure":
      return "azure"
    case "@ai-sdk/openai":
      return "openai"
    case "@ai-sdk/amazon-bedrock":
      return "bedrock"
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return "anthropic"
    case "@ai-sdk/google-vertex":
      return "vertex"
    case "@ai-sdk/google":
      return "google"
    case "@ai-sdk/gateway":
      return "gateway"
    case "@openrouter/ai-sdk-provider":
      return "openrouter"
    case "ai-gateway-provider":
      // ai-gateway-provider/unified wraps createOpenAICompatible({ name: "Unified" }),
      // and @ai-sdk/openai-compatible parses compatibleOptions from one of
      // "openai-compatible" / "openaiCompatible" / "Unified" / "unified". The
      // "openai-compatible" key emits a deprecation warning at runtime, so we
      // pick the camelCase form the SDK now treats as canonical.
      return "openaiCompatible"
  }
  return undefined
}

// Several conditional passes, kept on purpose rather than by neglect.
//
// Measured 2026-08-24 on a 601-message / 2.4MB history — about the largest a
// 200k-token context can hold. `ProviderTransform.message` costs ~2.1ms, and
// ~72% of that is `sanitizeSurrogates` scanning characters: per-byte work that
// survives any restructuring of the passes. A single structural walk over every
// message and part costs 0.012ms, so the passes themselves are ~0.5ms of
// allocation, and `JSON.stringify` of the same payload — unavoidable, it is the
// request body — is 0.8x the cost of this entire function. Fusing the passes
// would buy under a millisecond on a request that then waits seconds for a
// model, while merging eight provider-specific rules (two of which reorder or
// split messages, and one of which returns early) into one walk.
//
// The one lever that would matter is not re-sanitizing history that previous
// turns already sanitized. That needs provenance on the message, which is a
// correctness change and not a refactor.
//
// The passes are pinned by `test/provider/transform-normalize.test.ts` and the
// numbers are reproducible from `test/provider/hot-paths.benchmark.test.ts`.
function normalizeMessages(
  msgs: ModelMessage[],
  model: Provider.Model,
  _options: Record<string, unknown>,
): ModelMessage[] {
  const sanitizeToolResultOutput = (content: ToolResultPart) => {
    if (content.output.type === "text" || content.output.type === "error-text") {
      content.output.value = sanitizeSurrogates(content.output.value)
    }
    if (content.output.type === "content") {
      content.output.value = content.output.value.map((item) => {
        if (item.type === "text") {
          item.text = sanitizeSurrogates(item.text)
        }
        return item
      })
    }
    return content
  }

  msgs = msgs.map((msg) => {
    switch (msg.role) {
      case "tool":
        if (!Array.isArray(msg.content)) return msg
        msg.content = msg.content.map((content) => {
          if (content.type === "tool-result") {
            return sanitizeToolResultOutput(content)
          }
          return content
        })
        return msg

      case "system":
        msg.content = sanitizeSurrogates(msg.content)
        return msg

      case "user":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text") {
              content.text = sanitizeSurrogates(content.text)
            }
            return content
          })
        }
        return msg

      case "assistant":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text" || content.type === "reasoning") {
              content.text = sanitizeSurrogates(content.text)
            }
            if (content.type === "tool-result") {
              return sanitizeToolResultOutput(content)
            }
            return content
          })
        }
        return msg
    }
  })

  // Anthropic rejects messages with empty content - filter out empty string messages
  // and remove empty text/reasoning parts from array content
  if (model.api.npm === "@ai-sdk/anthropic") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text") {
            return part.text !== ""
          }
          if (part.type === "reasoning") {
            return (
              part.text.trim().length > 0 ||
              part.providerOptions?.anthropic?.signature != null ||
              part.providerOptions?.anthropic?.redactedData != null
            )
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  // Bedrock specific transforms
  if (model.api.npm === "@ai-sdk/amazon-bedrock") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text") {
            return part.text !== ""
          }
          if (part.type === "reasoning") {
            return (
              part.text.trim().length > 0 ||
              part.providerOptions?.bedrock?.signature != null ||
              part.providerOptions?.bedrock?.redactedData != null
            )
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  if (model.api.id.includes("claude")) {
    const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
    msgs = msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-call" || part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      return msg
    })
  }
  if (["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"].includes(model.api.npm)) {
    // Anthropic rejects assistant turns where tool_use blocks are followed by non-tool
    // content, e.g. [tool_use, tool_use, text], with:
    // `tool_use` ids were found without `tool_result` blocks immediately after...
    //
    // Reorder that invalid shape into [text] + [tool_use, tool_use]. Consecutive
    // assistant messages are later merged by the provider/SDK, so preserving the
    // original [tool_use...] then [text] order still produces the invalid payload.
    //
    // The root cause appears to be somewhere upstream where the stream is originally
    // processed. We were unable to locate an exact narrower reproduction elsewhere,
    // so we keep this transform in place for the time being.
    msgs = msgs.flatMap((msg) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [msg]

      const parts = msg.content
      const first = parts.findIndex((part) => part.type === "tool-call")
      if (first === -1) return [msg]
      if (!parts.slice(first).some((part) => part.type !== "tool-call")) return [msg]
      return [
        { ...msg, content: parts.filter((part) => part.type !== "tool-call") },
        { ...msg, content: parts.filter((part) => part.type === "tool-call") },
      ]
    })
  }
  if (
    model.providerID === "mistral" ||
    model.api.id.toLowerCase().includes("mistral") ||
    model.api.id.toLocaleLowerCase().includes("devstral")
  ) {
    const scrub = (id: string) => {
      return id
        .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
        .substring(0, 9) // Take first 9 characters
        .padEnd(9, "0") // Pad with zeros if less than 9 characters
    }
    const result: ModelMessage[] = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const nextMsg = msgs[i + 1]

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-call" || part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      result.push(msg)

      // Fix message sequence: tool messages cannot be followed by user messages
      if (msg.role === "tool" && nextMsg?.role === "user") {
        result.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done.",
            },
          ],
        })
      }
    }
    return result
  }

  // Deepseek requires all assistant messages to have reasoning on them
  if (model.api.id.toLowerCase().includes("deepseek")) {
    msgs = msgs.map((msg) => {
      if (msg.role !== "assistant") return msg
      if (Array.isArray(msg.content)) {
        if (msg.content.some((part) => part.type === "reasoning")) return msg
        return {
          ...msg,
          content: [...msg.content, { type: "reasoning", text: "" }],
        }
      }
      return {
        ...msg,
        content: [
          ...(msg.content ? [{ type: "text" as const, text: msg.content }] : []),
          { type: "reasoning" as const, text: "" },
        ],
      }
    })
  }

  if (
    typeof model.capabilities.interleaved === "object" &&
    model.capabilities.interleaved.field &&
    model.api.npm !== "@openrouter/ai-sdk-provider"
  ) {
    const field = model.capabilities.interleaved.field
    return msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
        const reasoningText = reasoningParts.map((part: any) => part.text).join("")

        // Filter out reasoning parts from content
        const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

        // Only set reasoning_content | reasoning_details when this turn actually produced
        // reasoning parts. Messages with no reasoning keep the field absent — an empty
        // string on every assistant message breaks KV-cache prefix matching on long
        // sessions. If the provider returned empty reasoning text, still forward "" so
        // providers that require the field (e.g. DeepSeek) stay compatible.
        if (reasoningParts.length === 0) {
          return {
            ...msg,
            content: filteredContent,
          }
        }

        return {
          ...msg,
          content: filteredContent,
          providerOptions: {
            ...msg.providerOptions,
            openaiCompatible: {
              ...msg.providerOptions?.openaiCompatible,
              [field]: reasoningText,
            },
          },
        }
      }

      return msg
    })
  }

  return msgs
}

function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  // Placement is budgeted (see cache-policy.ts): message-level markers leave a slot
  // for the wire-level tool-definition breakpoint, so a request never exceeds the
  // four Anthropic/Bedrock accept. The minimum cacheable prefix is per-model, so the
  // floor comes from the model rather than a single constant.
  const targets = CachePolicy.plan(
    msgs,
    CachePolicy.MESSAGE_BREAKPOINT_BUDGET,
    CachePolicy.minCacheableChars(model.api.id ?? model.id),
  )

  // A marked message wider than the lookback window puts the previous entry out
  // of reach, so the tail stops hitting with nothing in the response to say why.
  // Reported rather than prevented: the fix is a narrower fan-out at the call
  // site, not a different breakpoint here.
  const wide = CachePolicy.overLookback(targets)
  if (wide.length > 0) {
    log.warn("cache tail breakpoint may miss", {
      reason: "message carries more content blocks than the provider looks back over",
      blocks: wide.map((msg) => CachePolicy.contentBlocks(msg)).join(","),
      lookback: CachePolicy.LOOKBACK_BLOCKS,
    })
  }

  // `ttl` is only carried on the Anthropic block: that is the provider whose
  // `cacheControl` schema declares it (`"5m" | "1h"`). The others keep their default
  // lifetime rather than being sent a field they may not accept.
  //
  // OpenRouter is the tempting exception and is deliberately left out: its provider
  // copies `cacheControl` through verbatim as `cache_control` with no schema, so it
  // would forward a `ttl` rather than reject it — which means the request would be
  // betting on an upstream contract this side cannot see. Extend only against a
  // provider that documents the field.
  const ttl = CachePolicy.ttlFor(CachePolicy.resolveRetention())

  const providerOptions = {
    anthropic: {
      cacheControl: ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" },
    },
    openrouter: {
      cacheControl: { type: "ephemeral" },
    },
    bedrock: {
      cachePoint: { type: "default" },
    },
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
    copilot: {
      copilot_cache_control: { type: "ephemeral" },
    },
    alibaba: {
      cacheControl: { type: "ephemeral" },
    },
  }

  for (const msg of targets) {
    const useMessageLevelOptions =
      model.providerID === "anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.npm === "@ai-sdk/amazon-bedrock"
    const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1]
      if (lastContent && typeof lastContent === "object") {
        ;(lastContent as unknown as Record<string, unknown>).providerOptions = mergeDeep(
          (lastContent as unknown as Record<string, unknown>).providerOptions ?? {},
          providerOptions,
        )
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
  }

  return msgs
}

function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        const imageStr = String(part.image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime = part.type === "image" ? String(part.image).split(";")[0].replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities?.input?.[modality]) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
  msgs = unsupportedParts(msgs, model)
  msgs = normalizeMessages(msgs, model, options)
  if (
    (model.providerID === "anthropic" ||
      model.providerID === "google-vertex-anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.id.includes("anthropic") ||
      model.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@ai-sdk/alibaba" ||
      model.api.npm === "@openrouter/ai-sdk-provider" ||
      model.providerID === "openrouter") &&
    model.api.npm !== "@ai-sdk/gateway"
  ) {
    msgs = applyCaching(msgs, model)
  }

  // Remap providerOptions keys from stored providerID to expected SDK key
  const key = sdkKey(model.api.npm)
  if (key && key !== model.providerID) {
    const remap = (opts: Record<string, any> | undefined) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    }

    msgs = msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
      return {
        ...msg,
        providerOptions: remap(msg.providerOptions),
        content: msg.content.map((part) => {
          const partObj = part as unknown as Record<string, unknown>
          return {
            ...partObj,
            providerOptions: remap(partObj.providerOptions as any),
          }
        }),
      } as typeof msg
    })
  }

  return msgs
}

export function temperature(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 0.55
  if (id.includes("claude")) return undefined
  if (id.includes("gemini")) return 1.0
  if (id.includes("glm-4.6")) return 1.0
  if (id.includes("glm-4.7")) return 1.0
  if (id.includes("minimax-m2") || id.includes("minimax-m3")) return 1.0
  if (id.includes("kimi-k2")) {
    // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
      return 1.0
    }
    return 0.6
  }
  return undefined
}

export function topP(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 1
  if (["minimax-m2", "minimax-m3", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
    return 0.95
  }
  return undefined
}

export function topK(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("minimax-m2") || id.includes("minimax-m3")) {
    if (["m2.", "m25", "m21", "m3"].some((s) => id.includes(s))) return 40
    return 20
  }
  if (id.includes("gemini")) return 64
  return undefined
}

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_1_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS]
const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, "xhigh"]
const OPENAI_GPT5_PRO_EFFORTS = ["high"]
const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ["medium", "high", "xhigh"]
const OPENAI_GPT5_CHAT_EFFORTS = ["medium"]
const OPENAI_GPT5_CODEX_XHIGH_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_CODEX_3_PLUS_EFFORTS = ["none", ...OPENAI_GPT5_CODEX_XHIGH_EFFORTS]

// GPT-6 Astra drops the `none` and `minimal` tiers GPT-5.x exposed (both 400 on
// this family) and adds `max` at the top. `max` is Responses-API only: Chat
// Completions rejects it, so gateways that front chat get the shorter set.
// see: https://developers.openai.com/api/docs/models/gpt-6-astra
const OPENAI_GPT6_CHAT_COMPLETIONS_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT6_RESPONSES_EFFORTS = [...OPENAI_GPT6_CHAT_COMPLETIONS_EFFORTS, "max"]

// OpenAI rolled out the `none` reasoning_effort tier on this date (Responses API).
// Models released before it 400 on `reasoning_effort: "none"`, so we only expose
// it as a variant for models new enough to accept it.
const OPENAI_NONE_EFFORT_RELEASE_DATE = "2025-11-13"

// OpenAI rolled out the `xhigh` reasoning_effort tier on this date. Same reasoning.
const OPENAI_XHIGH_EFFORT_RELEASE_DATE = "2025-12-04"

// Matches members of the gpt-5 family across the id formats we encounter:
//   "gpt-5", "gpt-5-nano", "gpt-5.4", "openai/gpt-5.4-codex".
// Anchored to start-of-string or "/" so it doesn't false-match "gpt-50" or "gpt-5o".
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

// Matches the gpt-6 family the same way, so "gpt-6-astra", "openai/gpt-6-astra"
// and any later gpt-6.x id resolve to the Astra tier set without false-matching
// "gpt-60". GPT-6 Astra (released 2026-09-03) is the family's first member.
const GPT6_FAMILY_RE = /(?:^|\/)gpt-6(?:[.-]|$)/

export function isGpt6Family(apiId: string) {
  return GPT6_FAMILY_RE.test(apiId.toLowerCase())
}

// GPT-Reserve — the model a ChatGPT (Codex) plan falls back to once the main
// models are used up. It is version-less, so it matches neither the gpt-5 nor
// the gpt-6 family regex and needs its own entry. The Codex model manifest
// lists low/medium/high/xhigh/max: no `none` and no `minimal` (both 400), and
// `max` is Responses-only like on gpt-6.
const GPT_RESERVE_RE = /(?:^|\/)gpt-reserve(?:[.-]|$)/

export function isGptReserve(apiId: string) {
  return GPT_RESERVE_RE.test(apiId.toLowerCase())
}

const OPENAI_RESERVE_CHAT_COMPLETIONS_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_RESERVE_RESPONSES_EFFORTS = [...OPENAI_RESERVE_CHAT_COMPLETIONS_EFFORTS, "max"]

function gptReserveReasoningEfforts(apiId: string, responses: boolean) {
  if (!GPT_RESERVE_RE.test(apiId)) return undefined
  return responses ? OPENAI_RESERVE_RESPONSES_EFFORTS : OPENAI_RESERVE_CHAT_COMPLETIONS_EFFORTS
}

// Effort tiers a gpt-6 model exposes. `responses` selects the Responses-API set
// (the only one that accepts `max`); chat-shaped gateways pass false.
function gpt6ReasoningEfforts(apiId: string, responses: boolean) {
  if (!GPT6_FAMILY_RE.test(apiId)) return undefined
  return responses ? OPENAI_GPT6_RESPONSES_EFFORTS : OPENAI_GPT6_CHAT_COMPLETIONS_EFFORTS
}

function gpt5Version(apiId: string) {
  return Number(GPT5_VERSION_RE.exec(apiId)?.[1]) || undefined
}

function versionedGpt5ReasoningEfforts(apiId: string) {
  if (GPT5_VERSIONED_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_2_PLUS_EFFORTS
  const version = gpt5Version(apiId)
  if (version === undefined) return undefined
  if (version === 1) return OPENAI_GPT5_1_EFFORTS
  return OPENAI_GPT5_2_PLUS_EFFORTS
}

function gpt5CodexReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("codex")) return undefined
  const version = gpt5Version(apiId)
  if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS_EFFORTS
  if (apiId.includes("codex-max") || (version !== undefined && version >= 2)) return OPENAI_GPT5_CODEX_XHIGH_EFFORTS
  return WIDELY_SUPPORTED_EFFORTS
}

function gpt5ChatReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("-chat")) return undefined
  return gpt5Version(apiId) === undefined ? [] : OPENAI_GPT5_CHAT_EFFORTS
}

// Computes the reasoning_effort tiers an OpenAI (or OpenAI-compatible upstream
// routed through it, e.g. cf-ai-gateway) model exposes. Effort order: weakest
// to strongest.
function openaiReasoningEfforts(apiId: string, releaseDate: string) {
  const id = apiId.toLowerCase()
  if (id.includes("deep-research")) return ["medium"]
  // Direct OpenAI (and cf-ai-gateway's openai/* routes) go through Responses.
  const gpt6Efforts = gpt6ReasoningEfforts(id, true)
  if (gpt6Efforts) return gpt6Efforts
  const reserveEfforts = gptReserveReasoningEfforts(id, true)
  if (reserveEfforts) return reserveEfforts
  const chatEfforts = gpt5ChatReasoningEfforts(id)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
  const codexEfforts = gpt5CodexReasoningEfforts(id)
  if (codexEfforts) return codexEfforts
  const versionedEfforts = versionedGpt5ReasoningEfforts(id)
  // GPT-5.1 replaced GPT-5's `minimal` effort with `none`; GPT-5.2+
  // additionally accepts `xhigh`. Model pages list the supported subset.
  if (versionedEfforts) return versionedEfforts
  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (GPT5_FAMILY_RE.test(id)) efforts.unshift("minimal")
  if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) efforts.unshift("none")
  if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) efforts.push("xhigh")
  return efforts
}

function openaiCompatibleReasoningEfforts(id: string) {
  const apiId = id.toLowerCase()
  // OpenAI-compatible fronts (OpenRouter, generic /chat/completions) do not
  // carry the Responses-only `max` tier.
  const gpt6Efforts = gpt6ReasoningEfforts(apiId, false)
  if (gpt6Efforts) return gpt6Efforts
  const reserveEfforts = gptReserveReasoningEfforts(apiId, false)
  if (reserveEfforts) return reserveEfforts
  const chatEfforts = gpt5ChatReasoningEfforts(apiId)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_EFFORTS
  return gpt5CodexReasoningEfforts(apiId) ?? versionedGpt5ReasoningEfforts(apiId) ?? OPENAI_EFFORTS
}

function anthropicOpus47OrLater(apiId: string) {
  const version = /opus-(\d+)[.-](\d+)(?:[.@-]|$)/i.exec(apiId)
  if (!version) return false
  const major = Number(version[1])
  const minor = Number(version[2])
  return major > 4 || (major === 4 && minor >= 7)
}

function anthropicAdaptiveEfforts(apiId: string): string[] | null {
  if (anthropicOpus47OrLater(apiId)) {
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) => apiId.includes(v))) {
    return ["low", "medium", "high", "max"]
  }
  // MiniMax-M3 is Anthropic-compatible and accepts the adaptive thinking format.
  if (apiId.toLowerCase().includes("minimax-m3")) {
    return ["low", "medium", "high", "max"]
  }
  return null
}

function googleThinkingLevelEfforts(apiId: string) {
  const id = apiId.toLowerCase()
  if (!id.includes("gemini-3")) return ["low", "high"]
  if (id.includes("flash-image")) return ["minimal", "high"]
  if (id.includes("pro-image")) return ["high"]
  if (id.includes("flash")) return ["minimal", "low", "medium", "high"]
  return ["low", "medium", "high"]
}

// Matches grok-4.5 across the id formats we encounter ("grok-4.5",
// "grok-4-5-fast", "xai/grok-4.5") without false-matching "grok-4.50".
const GROK_4_5_RE = /(?:^|\/)grok-4[.-]5(?:[.-]|$)/

// Effort tiers a grok model accepts, weakest to strongest; undefined when the
// model has no effort control (it may still always reason at a fixed depth).
// see: https://docs.x.ai/docs/guides/reasoning
function xaiReasoningEfforts(id: string): string[] | undefined {
  if (id.includes("grok-3-mini")) return ["low", "high"]
  if (id.includes("multi-agent")) return ["low", "medium", "high", "xhigh"]
  if (GROK_4_5_RE.test(id)) return ["low", "medium", "high"]
  return undefined
}

function googleThinkingBudgetMax(apiId: string) {
  const id = apiId.toLowerCase()
  if (id.includes("2.5") && id.includes("pro") && !id.includes("flash")) return 32_768
  return 24_576
}

import { FUSION_NPM, FUSION_MODEL_ID, FUSION_BUILTIN_VARIANTS } from "@nikcli-ai/util/fusion"

export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  if (model.api.npm === FUSION_NPM && model.api.id === FUSION_MODEL_ID) {
    return FUSION_BUILTIN_VARIANTS
  }

  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  const adaptiveOpus = anthropicOpus47OrLater(model.api.id)
  const adaptiveEfforts = anthropicAdaptiveEfforts(model.api.id)
  if (
    id.includes("deepseek-chat") ||
    id.includes("deepseek-reasoner") ||
    id.includes("deepseek-r1") ||
    id.includes("deepseek-v3") ||
    // MiniMax M2.x leaks reasoning into content and has no usable thinking
    // controls; M3 is Anthropic-compatible and handled via adaptiveEfforts below.
    (id.includes("minimax") && !id.includes("minimax-m3")) ||
    // GLM / Kimi / K2 don't accept reasoning_effort on their direct providers,
    // but they DO via OpenRouter (handled in the openrouter switch case below),
    // so only exclude them when the npm is not openrouter.
    (id.includes("glm") && model.api.npm !== "@openrouter/ai-sdk-provider") ||
    (id.includes("kimi") && model.api.npm !== "@openrouter/ai-sdk-provider") ||
    (id.includes("k2p") && model.api.npm !== "@openrouter/ai-sdk-provider") ||
    id.includes("qwen") ||
    id.includes("big-pickle")
  )
    return {}

  // xAI reasoning-effort support is per-model, not family-wide: grok-3-mini
  // takes low/high, grok-4.5 takes low/medium/high (reasoning can't be disabled,
  // defaults to high), and grok-4.20 multi-agent uses effort to pick the agent
  // count (low/medium/high/xhigh). Every other grok reasoning model (grok-4,
  // grok-4.3, grok-code, grok-build…) reasons at a fixed depth and rejects the
  // parameter, so it gets no variants. Composer models served under the xai
  // provider have no documented effort control either.
  // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
  if (id.includes("grok") || model.api.npm === "@ai-sdk/xai") {
    const efforts = xaiReasoningEfforts(id)
    if (!efforts) return {}
    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      return Object.fromEntries(efforts.map((effort) => [effort, { reasoning: { effort } }]))
    }
    // Direct xAI (and OAI-compatible fronts) take `reasoningEffort`, but
    // @ai-sdk/xai's provider-options schema only allows low|medium|high —
    // `xhigh` fails its zod validation — so it only survives on OpenRouter's
    // generic reasoning.effort passthrough above.
    return Object.fromEntries(
      efforts.filter((effort) => effort !== "xhigh").map((effort) => [effort, { reasoningEffort: effort }]),
    )
  }

  switch (model.api.npm) {
    case "@openrouter/ai-sdk-provider": {
      // OpenRouter normalizes a generic `reasoning.effort` passthrough across
      // every upstream, so we don't pattern-match families here. Any model that
      // reaches this point already passed the reasoning-capability check and the
      // known-broken-controls exclusion above, so just emit the effort tiers.
      // GPT / o-series expose their own OpenAI tier set. Anthropic-adaptive
      // upstreams carry their adaptive efforts (already include `max`).
      // Every other budget-based upstream (glm, kimi, deepseek, gemini-2.5,
      // qwen…) gets low/medium/high plus `max`: OpenRouter maps `max` to ~95%
      // of max_tokens of reasoning budget, so it's the strongest usable tier.
      const efforts =
        id.includes("gpt") || model.api.id.toLowerCase().startsWith("openai/")
          ? openaiCompatibleReasoningEfforts(id)
          : (adaptiveEfforts ?? [...WIDELY_SUPPORTED_EFFORTS, "max"])
      return Object.fromEntries(efforts.map((effort) => [effort, { reasoning: { effort } }]))
    }

    case "ai-gateway-provider": {
      // Cloudflare AI Gateway routes every upstream through its OpenAI-compatible
      // /v1/compat endpoint, so the body is always OAI-shaped. The gateway
      // translates `reasoning_effort` to the upstream provider's native control
      // (e.g. Anthropic thinking budgets) when needed. Variants therefore stay
      // OAI-style for all upstreams, with an extended effort set for OpenAI
      // models that support it.
      if (model.api.id.startsWith("openai/")) {
        const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
        return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
    }

    case "@ai-sdk/gateway":
      if (model.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                },
                effort,
              },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      if (model.id.includes("google")) {
        if (id.includes("2.5")) {
          return {
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 24576,
              },
            },
          }
        }
        return Object.fromEntries(
          ["low", "high"].map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )
      }
      return Object.fromEntries(
        openaiCompatibleReasoningEfforts(model.api.id).map((effort) => [effort, { reasoningEffort: effort }]),
      )

    case "@ai-sdk/github-copilot":
      if (model.id.includes("gemini")) {
        // currently github copilot only returns thinking
        return {}
      }
      if (model.id.includes("claude")) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      const copilotEfforts = iife(() => {
        // Copilot fronts gpt-6 through its own gateway, which has not
        // documented the Responses-only `max` tier — stay on the chat set.
        if (GPT6_FAMILY_RE.test(id)) return OPENAI_GPT6_CHAT_COMPLETIONS_EFFORTS
        if (id.includes("5.1-codex-max") || id.includes("5.2") || id.includes("5.3"))
          return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
        const arr = [...WIDELY_SUPPORTED_EFFORTS]
        if (id.includes("gpt-5") && model.release_date >= "2025-12-04") arr.push("xhigh")
        return arr
      })
      return Object.fromEntries(
        copilotEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: INCLUDE_ENCRYPTED_REASONING,
          },
        ]),
      )

    case "@ai-sdk/cerebras":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
    case "@ai-sdk/togetherai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
    case "@ai-sdk/xai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
    case "@ai-sdk/deepinfra":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
    case "venice-ai-sdk-provider":
    // https://docs.venice.ai/overview/guides/reasoning-models#reasoning-effort
    case "@ai-sdk/openai-compatible":
      const efforts = [...WIDELY_SUPPORTED_EFFORTS]
      if (model.api.id.toLowerCase().includes("deepseek-v4")) {
        efforts.push("max")
      }
      return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))

    case "@ai-sdk/azure":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
      if (id === "o1-mini") return {}
      return Object.fromEntries(
        (GPT6_FAMILY_RE.test(id)
          ? OPENAI_GPT6_CHAT_COMPLETIONS_EFFORTS
          : GPT5_FAMILY_RE.test(id) && gpt5Version(id) === undefined
            ? ["minimal", ...WIDELY_SUPPORTED_EFFORTS]
            : WIDELY_SUPPORTED_EFFORTS
        ).map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: INCLUDE_ENCRYPTED_REASONING,
          },
        ]),
      )
    case "@ai-sdk/openai": {
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
      // "detailed" gives the richest reasoning summary the Responses API
      // exposes (the raw chain-of-thought is never returned).
      const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
      return Object.fromEntries(
        efforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "detailed",
            include: INCLUDE_ENCRYPTED_REASONING,
          },
        ]),
      )
    }

    case "@ai-sdk/anthropic":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
    case "@ai-sdk/google-vertex/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider
      if (adaptiveEfforts) {
        let efforts = [...adaptiveEfforts]
        if (model.providerID === "github-copilot") {
          if (model.api.id.includes("opus-4.7")) {
            efforts = ["medium"]
          }
          // Efforts currently supported are: low, medium, high
          efforts = efforts.filter((v) => v !== "max" && v !== "xhigh")
        }
        return Object.fromEntries(
          efforts.map((effort) => [
            effort,
            {
              thinking: {
                type: "adaptive",
                ...(adaptiveOpus ? { display: "summarized" } : undefined),
              },
              effort,
            },
          ]),
        )
      }

      if (["opus-4-5", "opus-4.5"].some((v) => model.api.id.includes(v))) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { effort }]))
      }

      return {
        high: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
          },
        },
        max: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31_999, model.limit.output - 1),
          },
        },
      }

    case "@ai-sdk/amazon-bedrock":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
      if (adaptiveEfforts) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "adaptive",
                maxReasoningEffort: effort,
                ...(adaptiveOpus ? { display: "summarized" } : undefined),
              },
            },
          ]),
        )
      }
      // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
      if (model.api.id.includes("anthropic")) {
        return {
          high: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }

      // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
      return Object.fromEntries(
        WIDELY_SUPPORTED_EFFORTS.map((effort) => [
          effort,
          {
            reasoningConfig: {
              type: "enabled",
              maxReasoningEffort: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/google-vertex":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
    case "@ai-sdk/google":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
      if (id.includes("2.5")) {
        return {
          high: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 16000,
            },
          },
          max: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: googleThinkingBudgetMax(id),
            },
          },
        }
      }

      return Object.fromEntries(
        googleThinkingLevelEfforts(id).map((effort) => [
          effort,
          {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/mistral":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
      // https://docs.mistral.ai/capabilities/reasoning/adjustable
      if (!model.capabilities.reasoning) return {}
      // Only Mistral Small 4 and Medium 3.5 support reasoning
      const MISTRAL_REASONING_IDS = [
        "mistral-small-2603",
        "mistral-small-latest",
        "mistral-medium-3.5",
        "mistral-medium-2604",
      ]
      const mistralId = model.api.id.toLowerCase()
      if (!MISTRAL_REASONING_IDS.some((id) => mistralId.includes(id))) return {}
      return {
        high: { reasoningEffort: "high" },
      }

    case "@ai-sdk/cohere":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
      return {}

    case "@ai-sdk/groq":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
      const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
      return Object.fromEntries(
        groqEffort.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
          },
        ]),
      )

    case "@ai-sdk/perplexity":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
      return {}

    case "@jerome-benoit/sap-ai-provider-v2":
      if (model.api.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                },
                effort,
              },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      if (model.api.id.includes("gemini") && id.includes("2.5")) {
        return {
          high: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 16000,
            },
          },
          max: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 24576,
            },
          },
        }
      }
      if (model.api.id.includes("gpt") || /\bo[1-9]/.test(model.api.id)) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      return {}
  }
  return {}
}

export function options(input: {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}): Record<string, any> {
  const result: Record<string, any> = {}

  if (
    input.model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
    (!input.model.api.id.includes("claude") && input.model.api.npm === "@ai-sdk/anthropic")
  ) {
    result["toolStreaming"] = false
  }

  // openai and providers using openai package should set store to false by default.
  if (
    input.model.providerID === "openai" ||
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/github-copilot"
  ) {
    result["store"] = false
  }

  if (input.model.api.npm === "@ai-sdk/azure") {
    result["store"] = false
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.api.npm === "@openrouter/ai-sdk-provider" || input.model.api.npm === "@llmgateway/ai-sdk-provider") {
    result["usage"] = {
      include: true,
    }
    if (input.model.api.id.includes("gemini-3")) {
      result["reasoning"] = { effort: "high" }
    }
  }

  if (
    input.model.providerID === "baseten" ||
    (input.model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(input.model.api.id))
  ) {
    result["chat_template_args"] = { enable_thinking: true }
  }

  if (
    ["zai", "zhipuai"].some((id) => input.model.providerID.includes(id)) &&
    input.model.api.npm === "@ai-sdk/openai-compatible"
  ) {
    result["thinking"] = {
      type: "enabled",
      clear_thinking: false,
    }
  }

  if (input.model.providerID === "openai" || input.providerOptions?.setCacheKey) {
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
    if (input.model.capabilities.reasoning) {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }
  }

  // Enable thinking by default for kimi models using anthropic SDK
  const modelId = input.model.api.id.toLowerCase()
  if (
    (input.model.api.npm === "@ai-sdk/anthropic" || input.model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
    (modelId.includes("k2p") || modelId.includes("kimi-k2.") || modelId.includes("kimi-k2p"))
  ) {
    result["thinking"] = {
      type: "enabled",
      budgetTokens: Math.min(16_000, Math.floor(input.model.limit.output / 2 - 1)),
    }
  }

  // Enable thinking for reasoning models on alibaba-cn (DashScope).
  // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
  // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
  // deepseek-r1, etc. never output thinking/reasoning tokens.
  // Note: kimi-k2-thinking is excluded as it returns reasoning_content by default.
  if (
    input.model.providerID === "alibaba-cn" &&
    input.model.capabilities.reasoning &&
    input.model.api.npm === "@ai-sdk/openai-compatible" &&
    !modelId.includes("kimi-k2-thinking")
  ) {
    result["enable_thinking"] = true
  }

  if (input.model.api.npm === "@ai-sdk/azure" && input.model.api.id.includes("gpt-5.5")) {
    result["reasoningSummary"] = "auto"
    return result
  }

  const isGpt5 = input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")
  // GPT-6 Astra always reasons: there is no chat/non-reasoning sibling to
  // exclude, and `reasoning_effort: "none"` 400s, so it takes the same
  // medium-effort default as gpt-5.x.
  const isGpt6 = isGpt6Family(input.model.api.id)
  // GPT-Reserve is a reasoning-only model on the Responses API too: same
  // medium default, same encrypted-reasoning include, and it accepts
  // `text.verbosity` (the Codex manifest defaults it to "low").
  const isReserve = isGptReserve(input.model.api.id)
  if (isGpt5 || isGpt6 || isReserve) {
    if (!input.model.api.id.includes("gpt-5-pro")) {
      result["reasoningEffort"] = "medium"
      // Direct OpenAI accepts "detailed" (richest summary the API exposes);
      // gateways (Copilot, Azure, opencode) stay on "auto" for compatibility.
      result["reasoningSummary"] = input.model.api.npm === "@ai-sdk/openai" ? "detailed" : "auto"
      if (input.model.api.npm === "@ai-sdk/openai") {
        result["include"] = INCLUDE_ENCRYPTED_REASONING
      }
    }

    // Only set textVerbosity for non-chat gpt-5.x models
    // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
    // gpt-6 is left out: OpenAI has not documented `text.verbosity` for Astra,
    // and an unsupported value is a 400 rather than a silent no-op.
    if (
      ((isGpt5 &&
        input.model.api.id.includes("gpt-5.") &&
        !input.model.api.id.includes("codex") &&
        !input.model.api.id.includes("-chat")) ||
        isReserve) &&
      input.model.providerID !== "azure"
    ) {
      result["textVerbosity"] = "low"
    }

    if (input.model.providerID.startsWith("opencode")) {
      result["promptCacheKey"] = input.sessionID
      result["include"] = INCLUDE_ENCRYPTED_REASONING
      result["reasoningSummary"] = "auto"
    }
  }

  if (input.model.providerID === "venice") {
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.providerID === "openrouter") {
    result["prompt_cache_key"] = input.sessionID
  }
  if (input.model.api.npm === "@ai-sdk/gateway") {
    result["gateway"] = {
      caching: "auto",
    }
  }

  return result
}

export function smallOptions(model: Provider.Model) {
  const small = Object.values(model.variants ?? {})[0] ?? {}
  if (
    model.providerID === "openai" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/github-copilot"
  ) {
    const base = { store: false }
    return mergeDeep(base, small)
  }
  if (model.providerID === "openrouter" || model.providerID === "llmgateway") {
    if (Object.keys(small).length === 0 && model.api.id.includes("google")) {
      return { reasoning: { enabled: false } }
    }
  }

  if (model.providerID === "venice") {
    if (Object.keys(small).length > 0) return small
    return { veniceParameters: { disableThinking: true } }
  }

  return small
}

// Maps model ID prefix to provider slug used in providerOptions.
// Example: "amazon/nova-2-lite" → "bedrock"
const SLUG_OVERRIDES: Record<string, string> = {
  amazon: "bedrock",
}

export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  if (model.api.npm === "@ai-sdk/gateway") {
    // Gateway providerOptions are split across two namespaces:
    // - `gateway`: gateway-native routing/caching controls (order, only, byok, etc.)
    // - `<upstream slug>`: provider-specific model options (anthropic/openai/...)
    // We keep `gateway` as-is and route every other top-level option under the
    // model-derived upstream slug.
    const i = model.api.id.indexOf("/")
    const rawSlug = i > 0 ? model.api.id.slice(0, i) : undefined
    const slug = rawSlug ? (SLUG_OVERRIDES[rawSlug] ?? rawSlug) : undefined
    const gateway = options.gateway
    const rest = Object.fromEntries(Object.entries(options).filter(([k]) => k !== "gateway"))
    const has = Object.keys(rest).length > 0

    const result: Record<string, any> = {}
    if (gateway !== undefined) result.gateway = gateway

    if (has) {
      if (slug) {
        // Route model-specific options under the provider slug
        result[slug] = rest
      } else if (gateway && typeof gateway === "object" && !Array.isArray(gateway)) {
        result.gateway = { ...gateway, ...rest }
      } else {
        result.gateway = rest
      }
    }

    return result
  }

  // AI SDK packages that resolve providerOptionsName by splitting the
  // provider name on "." (e.g. "wafer.ai" -> "wafer") need the same
  // logic here so the key we write matches the key they read.
  // Other SDKs (xai, mistral, groq, cohere, etc.) use hardcoded keys
  // like "xai" or "cohere" - applying .split(".")[0] would break those.
  const usesDotSplitOptions =
    model.api.npm === "@ai-sdk/openai-compatible" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/anthropic"
  const key = sdkKey(model.api.npm) ?? (usesDotSplitOptions ? model.providerID.split(".")[0] : model.providerID)
  // @ai-sdk/azure delegates to OpenAIChatLanguageModel which reads from
  // providerOptions["openai"], but OpenAIResponsesLanguageModel checks
  // "azure" first. Pass both so model options work on either code path.
  if (model.api.npm === "@ai-sdk/azure") {
    return { openai: options, azure: options }
  }
  return { [key]: options }
}

export function maxOutputTokens(model: Provider.Model, outputTokenMax = OUTPUT_TOKEN_MAX): number {
  return Math.min(model.limit.output, outputTokenMax) || outputTokenMax
}

// Returns true if the model/provider natively supports media content in tool results.
// OpenAI-compatible APIs only support string content in tool results, so we need
// to extract media and inject as user messages. Other SDKs (anthropic, google,
// bedrock) handle type: "content" with media parts natively.
export function supportsMediaInToolResults(model: Provider.Model): boolean {
  // Check if the model supports images as input (a prerequisite for media in tool results)
  if (!model.capabilities?.input?.image) return false

  // Native providers that support media in tool results via type: "content" parts
  const nativeProviders = [
    "@ai-sdk/anthropic",
    "@ai-sdk/google-vertex/anthropic",
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/google",
    "@ai-sdk/google-vertex",
  ]

  return nativeProviders.includes(model.api.npm)
}

// xAI multi-agent / "Build" models (e.g. grok-4.20-multi-agent-0309) run their
// own agent orchestration on xAI's servers. They have two hard constraints that
// no header/flag can lift:
//   1. They reject chat completions ("Multi Agent requests are not allowed on
//      chat completions") — they must go through the Responses API (handled by
//      the `xai` custom loader's `sdk.responses(modelID)`).
//   2. They reject client-side function tools ("Client-side tools for
//      multi-agent models require beta access") — only xAI's built-in
//      server-side tools (web_search, x_search, code_execution, mcp_server…)
//      are accepted.
// Both limits are documented at https://docs.x.ai/developers/model-capabilities/text/multi-agent
const MULTI_AGENT_RE = /multi-?agent/i

export function isMultiAgent(model: Provider.Model): boolean {
  if (model.providerID !== "xai" && !model.api.id.toLowerCase().includes("grok")) return false
  return MULTI_AGENT_RE.test(model.api.id) || MULTI_AGENT_RE.test(model.id)
}

// Strips client-side (function) tool definitions for models that reject them.
// Currently only xAI multi-agent models: they only accept xAI's built-in
// server-side tools, so sending any client-side tool 400s the request. Returning
// an empty set lets these models run as research/orchestration models instead of
// crashing the session.
export function tools<T extends Record<string, unknown>>(model: Provider.Model, tools: T): T {
  if (isMultiAgent(model)) return {} as T
  return tools
}

// Transforms API errors into user-friendly messages with provider-specific handling
export function error(
  providerID: string,
  error: { message?: string; statusCode?: number; responseBody?: string },
): string {
  const msg = error.message || ""

  // xAI multi-agent models don't accept client-side tools or chat completions.
  // Translate the cryptic API errors into an actionable hint.
  if (providerID === "xai" && MULTI_AGENT_RE.test(msg)) {
    return `${msg}. xAI multi-agent models don't support client-side tools and only run on the Responses API — use a standard grok model (e.g. grok-4, grok-code-fast) for tool-using sessions.`
  }

  // GitHub Copilot: 403 means need to reauthenticate
  if (providerID.includes("github-copilot") && error.statusCode === 403) {
    if (!msg.toLowerCase().includes("reauthenticate")) {
      return msg
        ? `${msg}. Please reauthenticate in GitHub Copilot settings.`
        : "Authentication failed. Please reauthenticate in GitHub Copilot settings."
    }
  }

  // GitHub Copilot: unsupported model message
  if (providerID === "github-copilot" && msg.toLowerCase().includes("not supported")) {
    if (!msg.includes("github.com/settings/copilot")) {
      return `${msg} See https://github.com/settings/copilot for available models.`
    }
  }

  return msg
}

export function schema(model: Provider.Model, schema: JSONSchema7): JSONSchema7 {
  /*
  if (["openai", "azure"].includes(providerID)) {
    if (schema.type === "object" && schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (schema.required?.includes(key)) continue
        schema.properties[key] = {
          anyOf: [
            value as JSONSchema.JSONSchema,
            {
              type: "null",
            },
          ],
        }
      }
    }
  }
  */

  if (model.providerID === "moonshotai" || model.api.id.toLowerCase().includes("kimi")) {
    const sanitizeMoonshot = (obj: unknown): unknown => {
      if (obj === null || typeof obj !== "object") return obj
      if (Array.isArray(obj)) return obj.map(sanitizeMoonshot)
      // Moonshot expands $ref before validation and rejects sibling keywords like description on the same node.
      if ("$ref" in obj && typeof obj.$ref === "string") return { $ref: obj.$ref }
      const result = Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, sanitizeMoonshot(value)]))
      // MFJS does not support tuple-style `items` arrays; it requires one schema object for all array items.
      if (Array.isArray(result.items)) result.items = result.items[0] ?? {}
      return result
    }

    const sanitized = sanitizeMoonshot(schema)
    if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
      schema = sanitized
    }
  }

  // Convert integer enums to string enums for Google/Gemini
  if (model.providerID === "google" || model.api.id.includes("gemini")) {
    const isPlainObject = (node: unknown): node is Record<string, any> =>
      typeof node === "object" && node !== null && !Array.isArray(node)
    const hasCombiner = (node: unknown) =>
      isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
    const hasSchemaIntent = (node: unknown) => {
      if (!isPlainObject(node)) return false
      if (hasCombiner(node)) return true
      return [
        "type",
        "properties",
        "items",
        "prefixItems",
        "enum",
        "const",
        "$ref",
        "additionalProperties",
        "patternProperties",
        "required",
        "not",
        "if",
        "then",
        "else",
      ].some((key) => key in node)
    }

    const sanitizeGemini = (obj: any): any => {
      if (obj === null || typeof obj !== "object") {
        return obj
      }

      if (Array.isArray(obj)) {
        return obj.map(sanitizeGemini)
      }

      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        if (key === "enum" && Array.isArray(value)) {
          // Convert all enum values to strings
          result[key] = value.map((v) => String(v))
          // If we have integer type with enum, change type to string
          if (result.type === "integer" || result.type === "number") {
            result.type = "string"
          }
        } else if (typeof value === "object" && value !== null) {
          result[key] = sanitizeGemini(value)
        } else {
          result[key] = value
        }
      }

      // Filter required array to only include fields that exist in properties
      if (result.type === "object" && result.properties && Array.isArray(result.required)) {
        result.required = result.required.filter((field: any) => field in result.properties)
      }

      if (result.type === "array" && !hasCombiner(result)) {
        if (result.items == null) {
          result.items = {}
        }
        // Ensure items has a type only when it's still schema-empty.
        if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) {
          result.items.type = "string"
        }
      }

      // Remove properties/required from non-object types (Gemini rejects these)
      if (result.type && result.type !== "object" && !hasCombiner(result)) {
        delete result.properties
        delete result.required
      }

      return result
    }

    schema = sanitizeGemini(schema)
  }

  return schema
}

export * as ProviderTransform from "./transform"

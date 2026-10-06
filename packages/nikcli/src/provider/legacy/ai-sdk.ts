import type { Provider as SDK } from "ai"
type ProviderSdkOptions = Record<string, any>
type BundledFactory = (options: ProviderSdkOptions) => SDK
export {
  NoSuchModelError,
  streamText,
  generateText,
  generateObject,
  experimental_generateImage,
  wrapLanguageModel,
  extractReasoningMiddleware,
  jsonSchema,
} from "ai"
export type { Provider, ModelMessage, ToolSet } from "ai"
export type { AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
export type { LanguageModelV2 } from "@openrouter/ai-sdk-provider"
export { createGitLab } from "@gitlab/gitlab-ai-provider"
export { createOpenAI } from "@ai-sdk/openai"
export const BUNDLED_PROVIDERS: Record<string, () => Promise<BundledFactory>> = {
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock),
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  "@ai-sdk/azure": () => import("@ai-sdk/azure").then((m) => m.createAzure),
  "@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex),
  "@ai-sdk/google-vertex/anthropic": () =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic),
  "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
  "@ai-sdk/openai-compatible": () =>
    import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible as unknown as BundledFactory),
  "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter),
  "@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai),
  "@ai-sdk/mistral": () => import("@ai-sdk/mistral").then((m) => m.createMistral),
  "@ai-sdk/groq": () => import("@ai-sdk/groq").then((m) => m.createGroq),
  "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra),
  "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras").then((m) => m.createCerebras),
  "@ai-sdk/cohere": () => import("@ai-sdk/cohere").then((m) => m.createCohere),
  "@ai-sdk/gateway": () => import("@ai-sdk/gateway").then((m) => m.createGateway),
  "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI),
  "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity").then((m) => m.createPerplexity),
  "@ai-sdk/vercel": () => import("@ai-sdk/vercel").then((m) => m.createVercel),
  "@gitlab/gitlab-ai-provider": () => import("@gitlab/gitlab-ai-provider").then((m) => m.createGitLab),
  "@ai-sdk/github-copilot": () =>
    import("./copilot").then((m) => m.createOpenaiCompatible as unknown as BundledFactory),
}

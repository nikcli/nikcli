import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { withFixture } from "../helpers/fixture"

/**
 * One-shot calls (`session/llm/call.ts`) against a real HTTP server: the request they send and the
 * result they hand back, with no model mocked in between.
 */

type Captured = { path: string; headers: Headers; body: any }

const sse = (...chunks: object[]) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
const chunk = (delta: object, finish: string | null = null, usage: object | null = null) => ({
  id: "chatcmpl_call",
  choices: [{ index: 0, delta, finish_reason: finish }],
  usage,
})

// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

describe("one-shot native calls", () => {
  const captured: Captured[] = []
  const replies: Array<{ body: string; type: string }> = []
  let server: ReturnType<typeof Bun.serve>

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        captured.push({
          path: new URL(request.url).pathname,
          headers: request.headers,
          body: await request.json(),
        })
        const reply = replies.shift() ?? {
          body: sse(chunk({}, "stop")),
          type: "text/event-stream",
        }
        return new Response(reply.body, {
          headers: { "content-type": reply.type },
        })
      },
    })
  })
  afterAll(() => server.stop(true))

  async function withModel(body: (ctx: { model: any; call: typeof import("@/session/llm/call") }) => Promise<void>) {
    await withFixture(async ({ home }) => {
      const previous = process.env.NIKCLI_DISABLE_PROJECT_CONFIG
      const previousModelsFetch = process.env.NIKCLI_DISABLE_MODELS_FETCH
      process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "0"
      process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
      const { Instance } = await import("@/project/instance")
      const { Provider } = await import("@/provider/provider")
      const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
      const call = await import("@/session/llm/call")
      try {
        await Bun.write(
          path.join(home, "nikcli.json"),
          JSON.stringify({
            enabled_providers: ["call-e2e"],
            provider: {
              "call-e2e": {
                npm: "@ai-sdk/openai-compatible",
                api: `http://127.0.0.1:${server.port}/v1`,
                options: {
                  apiKey: "call-key",
                  headers: { "x-gateway": "yes" },
                },
                models: {
                  m: { name: "M", limit: { context: 8192, output: 1024 } },
                },
              },
            },
          }),
        )
        await Instance.provide({
          directory: home,
          fn: async () => {
            const model = await runPromiseWithLayer(
              Provider.defaultLayer,
              withCurrentInstance(
                Effect.gen(function* () {
                  return yield* (yield* Provider.Service).getModel("call-e2e", "m")
                }),
              ),
            )
            await body({ model, call })
          },
        })
      } finally {
        await Instance.disposeAll()
        if (previous === undefined) delete process.env.NIKCLI_DISABLE_PROJECT_CONFIG
        else process.env.NIKCLI_DISABLE_PROJECT_CONFIG = previous
        if (previousModelsFetch === undefined) delete process.env.NIKCLI_DISABLE_MODELS_FETCH
        else process.env.NIKCLI_DISABLE_MODELS_FETCH = previousModelsFetch
      }
    })
  }

  it("generateText sends system, prompt and options, and returns the text with usage", async () => {
    captured.length = 0
    replies.push({
      body: sse(
        chunk({ role: "assistant", content: "hel" }),
        chunk({ content: "lo" }),
        chunk({}, "stop", { prompt_tokens: 7, completion_tokens: 2 }),
      ),
      type: "text/event-stream",
    })
    await withModel(async ({ model, call }) => {
      const result = await call.generateText({
        model,
        system: "SYS",
        prompt: "say hello",
        temperature: 0,
        maxOutputTokens: 50,
      })
      expect(result.text).toBe("hello")
      expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 })
    })
    const request = captured[0]!
    expect(request.path).toBe("/v1/chat/completions")
    expect(request.headers.get("authorization")).toBe("Bearer call-key")
    expect(request.headers.get("x-gateway")).toBe("yes")
    expect(request.body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "say hello" },
    ])
    expect(request.body.temperature).toBe(0)
  })

  it("generateObject forces the schema tool and returns its arguments", async () => {
    captured.length = 0
    replies.push({
      body: sse(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: {
                name: "generate_object",
                arguments: '{"identifier":"a-b"}',
              },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ),
      type: "text/event-stream",
    })
    await withModel(async ({ model, call }) => {
      const result = await call.generateObject({
        model,
        prompt: "name an agent",
        schema: {
          type: "object",
          properties: { identifier: { type: "string" } },
          required: ["identifier"],
        },
      })
      expect(result.object).toEqual({ identifier: "a-b" })
    })
    const tools = captured[0]!.body.tools
    expect(tools).toHaveLength(1)
    expect(tools[0].function.name).toBe("generate_object")
    expect(captured[0]!.body.tool_choice).toEqual({
      type: "function",
      function: { name: "generate_object" },
    })
  })

  it("generateText on a custom-SDK provider that fails to load surfaces the SDK error", async () => {
    await withFixture(async ({ home }) => {
      const previous = process.env.NIKCLI_DISABLE_PROJECT_CONFIG
      process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "0"
      process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
      const { Instance } = await import("@/project/instance")
      const { Provider } = await import("@/provider/provider")
      const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
      const call = await import("@/session/llm/call")
      try {
        await Bun.write(
          path.join(home, "nikcli.json"),
          JSON.stringify({
            enabled_providers: ["custom-npm"],
            provider: {
              "custom-npm": {
                npm: "some-ai-sdk-provider",
                api: "https://x.example/v1",
                options: { apiKey: "k" },
                models: {
                  m: { name: "M", limit: { context: 8192, output: 1024 } },
                },
              },
            },
          }),
        )
        await Instance.provide({
          directory: home,
          fn: async () => {
            const model = await runPromiseWithLayer(
              Provider.defaultLayer,
              withCurrentInstance(
                Effect.gen(function* () {
                  return yield* (yield* Provider.Service).getModel("custom-npm", "m")
                }),
              ),
            )
            // Native route refuses (no ModelRef), AI SDK fallback also fails because the
            // configured npm package does not exist; the SDK error reaches the caller.
            await expect(call.generateText({ model, prompt: "hi" })).rejects.toBeDefined()
          },
        })
      } finally {
        await Instance.disposeAll()
        if (previous === undefined) delete process.env.NIKCLI_DISABLE_PROJECT_CONFIG
        else process.env.NIKCLI_DISABLE_PROJECT_CONFIG = previous
      }
    })
  })

  it("serves a custom-SDK provider that names its protocol in config", async () => {
    captured.length = 0
    replies.push({
      body: sse(chunk({ role: "assistant", content: "from acme" }), chunk({}, "stop")),
      type: "text/event-stream",
    })
    await withFixture(async ({ home }) => {
      const previous = process.env.NIKCLI_DISABLE_PROJECT_CONFIG
      process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "0"
      process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
      const { Instance } = await import("@/project/instance")
      const { Provider } = await import("@/provider/provider")
      const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
      const call = await import("@/session/llm/call")
      try {
        await Bun.write(
          path.join(home, "nikcli.json"),
          JSON.stringify({
            enabled_providers: ["acme"],
            provider: {
              acme: {
                npm: "@acme/ai-sdk-provider",
                api: `http://127.0.0.1:${server.port}/v1`,
                options: { apiKey: "acme-key", protocol: "openai-compatible" },
                models: {
                  m: { name: "M", limit: { context: 8192, output: 1024 } },
                },
              },
            },
          }),
        )
        await Instance.provide({
          directory: home,
          fn: async () => {
            const model = await runPromiseWithLayer(
              Provider.defaultLayer,
              withCurrentInstance(
                Effect.gen(function* () {
                  return yield* (yield* Provider.Service).getModel("acme", "m")
                }),
              ),
            )
            expect((await call.generateText({ model, prompt: "hi" })).text).toBe("from acme")
          },
        })
      } finally {
        await Instance.disposeAll()
        if (previous === undefined) delete process.env.NIKCLI_DISABLE_PROJECT_CONFIG
        else process.env.NIKCLI_DISABLE_PROJECT_CONFIG = previous
      }
    })
    expect(captured[0]!.path).toBe("/v1/chat/completions")
    expect(captured[0]!.headers.get("authorization")).toBe("Bearer acme-key")
  })

  it("generateImage posts to /images/generations and decodes base64 images", async () => {
    captured.length = 0
    replies.push({
      body: JSON.stringify({ data: [{ b64_json: PNG }] }),
      type: "application/json",
    })
    await withModel(async ({ model, call }) => {
      const result = await call.generateImage({
        model,
        prompt: "a pixel",
        n: 1,
        size: "1024x1024",
      })
      expect(result.images).toEqual([{ base64: PNG, mediaType: "image/png" }])
      expect(result.warnings).toEqual([])
    })
    const request = captured[0]!
    expect(request.path).toBe("/v1/images/generations")
    expect(request.headers.get("authorization")).toBe("Bearer call-key")
    expect(request.body).toMatchObject({
      model: "m",
      prompt: "a pixel",
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    })
  })

  it("generateImage rejects a response that carries no images", async () => {
    replies.push({
      body: JSON.stringify({ error: { message: "nope" } }),
      type: "application/json",
    })
    await withModel(async ({ model, call }) => {
      await expect(call.generateImage({ model, prompt: "x" })).rejects.toThrow(/no images/)
    })
  })
})

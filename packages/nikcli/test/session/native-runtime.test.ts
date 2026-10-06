import { describe, expect, it, spyOn } from "bun:test"
import { abortableIterable, status } from "@/session/llm/native-runtime"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import type { LLMEvent } from "@nikcli-ai/llm"
import { Effect } from "effect"
import path from "path"
import { withFixture } from "../helpers/fixture"

describe("LLMNativeRuntime.abortableIterable", () => {
  it("yields all values when not aborted", async () => {
    async function* source() {
      yield 1
      yield 2
      yield 3
    }
    const ac = new AbortController()
    const out: number[] = []
    for await (const v of abortableIterable(source(), ac.signal)) {
      out.push(v)
    }
    expect(out).toEqual([1, 2, 3])
  })

  it("throws AbortError when already aborted", async () => {
    async function* source() {
      yield 1
    }
    const ac = new AbortController()
    ac.abort()
    await expect(async () => {
      for await (const _ of abortableIterable(source(), ac.signal)) {
        // empty
      }
    }).toThrow(DOMException)
    try {
      for await (const _ of abortableIterable(source(), ac.signal)) {
        // empty
      }
    } catch (e) {
      expect(e).toBeInstanceOf(DOMException)
      expect((e as DOMException).name).toBe("AbortError")
    }
  })

  it("throws AbortError mid-stream when abort fires", async () => {
    async function* source() {
      yield "a"
      await new Promise((r) => setTimeout(r, 50))
      yield "b"
      await new Promise((r) => setTimeout(r, 200))
      yield "c"
    }
    const ac = new AbortController()
    const out: string[] = []
    const iter = abortableIterable(source(), ac.signal)
    const first = await iter.next()
    expect(first.value).toBe("a")
    out.push(first.value as string)

    // Abort while waiting for next item
    setTimeout(() => ac.abort(), 10)
    await expect(iter.next()).rejects.toMatchObject({ name: "AbortError" })
  })

  it("does not accumulate abort listeners when iter wins the race", async () => {
    // Many iterations with a signal that never fires. Without explicit
    // removeEventListener, abort listener count would grow without bound.
    async function* source(n: number) {
      for (let i = 0; i < n; i++) yield i
    }
    const ac = new AbortController()
    // Spy on addEventListener / removeEventListener to count net listener churn.
    let added = 0
    let removed = 0
    const origAdd = ac.signal.addEventListener.bind(ac.signal)
    const origRemove = ac.signal.removeEventListener.bind(ac.signal)
    ac.signal.addEventListener = ((type: string, listener: any, opts?: any) => {
      if (type === "abort") added++
      return origAdd(type, listener, opts)
    }) as typeof ac.signal.addEventListener
    ac.signal.removeEventListener = ((type: string, listener: any, opts?: any) => {
      if (type === "abort") removed++
      return origRemove(type, listener, opts)
    }) as typeof ac.signal.removeEventListener

    const out: number[] = []
    for await (const v of abortableIterable(source(50), ac.signal)) {
      out.push(v)
    }
    expect(out.length).toBe(50)
    // Every added listener must be removed.
    expect(removed).toBe(added)
  })
})

describe("LLMNativeRuntime.status OAuth", () => {
  const status_ = (provider: object, auth: object | undefined) =>
    status({
      model: { id: "gpt-4o" } as any,
      provider: { id: "openai", ...provider } as any,
      auth: auth as any,
      modelRef: { providerID: "openai", modelID: "gpt-4o" } as any,
    })

  it("supports an oauth session whose credential lives in the provider's fetch", () => {
    const result = status_({ key: undefined, options: { fetch: async () => new Response() } }, { type: "oauth" })
    expect(result.type).toBe("supported")
  })

  it("still requires a key when nothing else carries the credential", () => {
    const result = status_({ key: undefined, options: {} }, { type: "oauth" })
    expect(result).toEqual({
      type: "unsupported",
      reason: "API key is not configured",
    })
  })

  it("supports an API key with no custom fetch", () => {
    expect(status_({ key: "sk-test", options: {} }, { type: "api" }).type).toBe("supported")
  })
})

describe("LLM.stream native failure handling", () => {
  async function fixture(
    body: (ctx: {
      input: import("@/session/llm").LLM.StreamInput
      stream: typeof import("@/session/llm").LLM.stream
      controller: AbortController
    }) => Promise<void>,
  ) {
    await withFixture(async ({ home }) => {
      const previous = process.env.NIKCLI_DISABLE_PROJECT_CONFIG
      const previousModelsFetch = process.env.NIKCLI_DISABLE_MODELS_FETCH
      process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "0"
      process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
      const { Instance } = await import("@/project/instance")
      const { Provider } = await import("@/provider/provider")
      const { LLM } = await import("@/session/llm")
      const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
      try {
        const server = Bun.serve({
          port: 0,
          fetch: () =>
            new Response(
              'data: {"id":"fallback","choices":[{"index":0,"delta":{"role":"assistant","content":"SDK fallback"},"finish_reason":null}]}\n\ndata: {"id":"fallback","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            ),
        })
        try {
          await Bun.write(
            path.join(home, "nikcli.json"),
            JSON.stringify({
              experimental: { openTelemetry: false },
              enabled_providers: ["native-safety"],
              provider: {
                "native-safety": {
                  npm: "@ai-sdk/openai-compatible",
                  api: `http://127.0.0.1:${server.port}/v1`,
                  options: { apiKey: "local-test-key" },
                  models: {
                    "safety-model": {
                      name: "Safety Model",
                      limit: { context: 8192, output: 1024 },
                    },
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
                    const provider = yield* Provider.Service
                    return yield* provider.getModel("native-safety", "safety-model")
                  }),
                ),
              )
              const controller = new AbortController()
              const input: import("@/session/llm").LLM.StreamInput = {
                sessionID: "ses_native_safety",
                user: {
                  id: "msg_native_safety",
                  sessionID: "ses_native_safety",
                  role: "user",
                  time: { created: 0 },
                  agent: "build",
                  model: { providerID: model.providerID, modelID: model.id },
                },
                agent: {
                  name: "build",
                  mode: "primary",
                  options: {},
                  permission: [],
                },
                model,
                system: [],
                messages: [{ role: "user", content: "hello" }],
                tools: {},
                abort: controller.signal,
              }
              await body({
                input,
                stream: LLM.stream,
                controller,
              })
            },
          })
        } finally {
          server.stop(true)
        }
      } finally {
        await Instance.disposeAll()
        if (previous === undefined) delete process.env.NIKCLI_DISABLE_PROJECT_CONFIG
        else process.env.NIKCLI_DISABLE_PROJECT_CONFIG = previous
        if (previousModelsFetch === undefined) delete process.env.NIKCLI_DISABLE_MODELS_FETCH
        else process.env.NIKCLI_DISABLE_MODELS_FETCH = previousModelsFetch
      }
    })
  }

  const partials: LLMEvent[] = [
    { type: "text-delta", id: "text", text: "partial answer" },
    { type: "reasoning-delta", id: "reasoning", text: "partial reasoning" },
    { type: "tool-call", id: "call", name: "bash", input: { command: "pwd" } },
  ]
  for (const partial of partials) {
    it(`surfaces a native ${partial.type} then iteration failure instead of retrying elsewhere`, async () => {
      await fixture(async ({ input, stream }) => {
        const failure = new Error("native iteration failed")
        let started = false
        let closed = false
        const native = spyOn(LLMNativeRuntime, "streamRequestOnly").mockImplementation(() => ({
          type: "supported",
          events: (async function* () {
            started = true
            try {
              yield partial
              throw failure
            } finally {
              closed = true
            }
          })(),
        }))
        try {
          const result = await stream(input)
          expect(started).toBe(false)
          const seen: string[] = []
          await expect(
            (async () => {
              for await (const event of result.fullStream) seen.push(event.type)
            })(),
          ).rejects.toBe(failure)
          expect(seen).toContain(partial.type)
          expect(seen).not.toContain("finish")
          expect(closed).toBe(true)
          expect(native).toHaveBeenCalledTimes(1)
        } finally {
          native.mockRestore()
        }
      })
    })
  }

  for (const timing of ["before iteration", "after partial output"] as const) {
    it(`cancels cleanly on cancellation ${timing}`, async () => {
      await fixture(async ({ input, stream, controller }) => {
        const native = spyOn(LLMNativeRuntime, "streamRequestOnly").mockImplementation((request) => ({
          type: "supported",
          events: abortableIterable(
            (async function* () {
              yield partials[0]!
              yield { type: "request-finish", reason: "stop" } as const
            })(),
            request.abort,
          ),
        }))
        try {
          const result = await stream(input)
          const iterator = result.fullStream[Symbol.asyncIterator]()
          if (timing === "after partial output") {
            expect((await iterator.next()).value?.type).toBe("start")
            expect((await iterator.next()).value?.type).toBe("start-step")
            expect((await iterator.next()).value?.type).toBe("text-start")
            expect((await iterator.next()).value?.type).toBe("text-delta")
          }
          controller.abort()
          await expect(iterator.next()).rejects.toMatchObject({
            name: "AbortError",
          })
        } finally {
          native.mockRestore()
        }
      })
    })
  }

  for (const kind of ["AbortError", "aborted signal"] as const) {
    it(`propagates a setup-time ${kind}`, async () => {
      await fixture(async ({ input, stream, controller }) => {
        const failure = kind === "AbortError" ? new DOMException("Cancelled", "AbortError") : new Error("setup failed")
        const native = spyOn(LLMNativeRuntime, "streamRequestOnly").mockImplementation(() => {
          if (kind === "aborted signal") controller.abort()
          throw failure
        })
        try {
          await expect(stream(input)).rejects.toBe(failure)
        } finally {
          native.mockRestore()
        }
      })
    })
  }

  it("uses SDK fallback when the native route refuses the request", async () => {
    await fixture(async ({ input, stream }) => {
      const native = spyOn(LLMNativeRuntime, "streamRequestOnly").mockReturnValue({
        type: "unsupported",
        reason: "route refused",
      })
      try {
        expect(await (await stream(input)).text).toBe("SDK fallback")
        expect(await (await stream(input)).text).toBe("SDK fallback")
        expect(native).toHaveBeenCalledTimes(2)
      } finally {
        native.mockRestore()
      }
    })
  })

  it("uses SDK credentials when the native pre-flight is ineligible", async () => {
    await fixture(async ({ input, stream }) => {
      const preflight = spyOn(LLMNativeRuntime, "status").mockReturnValue({
        type: "unsupported",
        reason: "API key is not configured",
      })
      try {
        expect(await (await stream(input)).text).toBe("SDK fallback")
      } finally {
        preflight.mockRestore()
      }
    })
  })

  it("uses SDK fallback on a non-cancellation native setup failure", async () => {
    await fixture(async ({ input, stream }) => {
      const failure = new Error("native setup failed")
      const native = spyOn(LLMNativeRuntime, "streamRequestOnly").mockImplementation(() => {
        throw failure
      })
      try {
        expect(await (await stream(input)).text).toBe("SDK fallback")
      } finally {
        native.mockRestore()
      }
    })
  })
})

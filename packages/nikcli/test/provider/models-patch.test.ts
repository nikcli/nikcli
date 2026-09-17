import { describe, expect, it } from "bun:test"
import { ModelsDev } from "@/provider/models"

// `ModelsDev.patch` seeds entries the upstream models.dev registry does not
// carry yet. A missing or wrong entry means the model never reaches the picker,
// or reaches it priced and limited incorrectly.
function openaiDatabase(models: Record<string, unknown> = {}) {
  return {
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      api: "https://api.openai.com/v1",
      npm: "@ai-sdk/openai",
      models,
    },
  } as unknown as Parameters<typeof ModelsDev.patch>[0]
}

describe("ModelsDev.patch — gpt-6-astra", () => {
  it("seeds gpt-6-astra into the openai provider", () => {
    const model = ModelsDev.patch(openaiDatabase()).openai?.models["gpt-6-astra"]
    expect(model).toBeDefined()
    expect(model?.id).toBe("gpt-6-astra")
    expect(model?.name).toBe("GPT-6 Astra")
  })

  it("carries the 1.05M context window and 128k output limit", () => {
    const model = ModelsDev.patch(openaiDatabase()).openai?.models["gpt-6-astra"]
    expect(model?.limit).toEqual({ context: 1_050_000, output: 128_000 })
  })

  it("carries the standard-tier pricing", () => {
    const model = ModelsDev.patch(openaiDatabase()).openai?.models["gpt-6-astra"]
    expect(model?.cost).toEqual({ input: 10, output: 50, cache_read: 1, cache_write: 12.5 })
  })

  it("is a reasoning, tool-calling, image-reading model with temperature off", () => {
    const model = ModelsDev.patch(openaiDatabase()).openai?.models["gpt-6-astra"]
    expect(model?.reasoning).toBe(true)
    expect(model?.tool_call).toBe(true)
    expect(model?.attachment).toBe(true)
    // Astra rejects `temperature` while reasoning, and it always reasons.
    expect(model?.temperature).toBe(false)
    expect(model?.modalities).toEqual({ input: ["text", "image"], output: ["text"] })
  })

  it("does not model a long-context price tier", () => {
    // OpenAI re-prices above 272K input, but session cost accounting hard-codes
    // the `context_over_200k` threshold at 200K, which would over-bill the
    // 200K-272K band. Base rates stay exact there instead.
    const model = ModelsDev.patch(openaiDatabase()).openai?.models["gpt-6-astra"]
    expect(model?.cost?.context_over_200k).toBeUndefined()
  })

  it("lets an upstream catalog entry win once models.dev lists it", () => {
    const upstream = {
      id: "gpt-6-astra",
      name: "Upstream Astra",
      release_date: "2026-09-03",
      attachment: true,
      reasoning: true,
      temperature: false,
      tool_call: true,
      cost: { input: 9, output: 49 },
      limit: { context: 1_050_000, output: 128_000 },
      options: {},
    }
    const model = ModelsDev.patch(openaiDatabase({ "gpt-6-astra": upstream })).openai?.models["gpt-6-astra"]
    expect(model?.name).toBe("Upstream Astra")
    expect(model?.cost?.input).toBe(9)
  })
})

describe("ModelsDev.patch — gpt-reserve", () => {
  // One patch for the whole block: `patch` walks the full catalog, and calling
  // it per assertion pushes the file past bun's per-test timeout.
  const patched = ModelsDev.patch(openaiDatabase())
  const reserve = () => patched.openai?.models["gpt-reserve"]

  it("seeds the reserve model into the openai provider", () => {
    // models.dev will never list it: OpenAI ships it hidden, for ChatGPT plan
    // traffic through the Codex backend only.
    expect(reserve()?.id).toBe("gpt-reserve")
    expect(reserve()?.name).toBe("GPT-Reserve")
  })

  it("carries the 272K standard context window", () => {
    expect(reserve()?.limit).toEqual({ context: 272_000, output: 128_000 })
  })

  it("is free, because plan traffic is not metered per token", () => {
    expect(reserve()?.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
  })

  it("is a reasoning, tool-calling, image-reading model with temperature off", () => {
    expect(reserve()?.reasoning).toBe(true)
    expect(reserve()?.tool_call).toBe(true)
    expect(reserve()?.attachment).toBe(true)
    expect(reserve()?.temperature).toBe(false)
    expect(reserve()?.modalities).toEqual({ input: ["text", "image"], output: ["text"] })
  })
})

import { describe, expect, it } from "bun:test"
import { withStreamFallback } from "@/session/llm/fallback"
import { streamResult } from "@/session/llm/llm-event-adapter"
import type { StreamEvent } from "@/session/llm/types"

describe("safe stream fallback", () => {
  it("retries before output without duplicating lifecycle events", async () => {
    let calls = 0
    const native = (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "start" }
      yield { type: "start-step" }
      throw new Error("connection failed")
    })()
    const fallback = async () => {
      calls++
      return streamResult(
        (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "start" }
          yield { type: "text-delta", id: "sdk", text: "ok" }
        })(),
      )
    }
    const seen = []
    for await (const event of withStreamFallback(native, fallback, new AbortController().signal)) seen.push(event)
    expect(calls).toBe(1)
    expect(seen.map((event) => event.type)).toEqual(["start", "text-delta"])
  })
  for (const type of ["text-delta", "reasoning-delta", "tool-call"] as const) {
    it(`does not replay after ${type}`, async () => {
      const failure = new Error("mid-stream failure")
      let calls = 0
      const native = (async function* (): AsyncGenerator<StreamEvent> {
        yield type === "tool-call"
          ? { type, toolCallId: "call", toolName: "bash", input: {} }
          : { type, id: "part", text: "partial" }
        throw failure
      })()
      await expect(
        (async () => {
          for await (const event of withStreamFallback(
            native,
            async () => {
              calls++
              throw new Error("unexpected")
            },
            new AbortController().signal,
          ))
            void event
        })(),
      ).rejects.toBe(failure)
      expect(calls).toBe(0)
    })
  }
  it("never retries cancellation", async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(
      (async () => {
        for await (const event of withStreamFallback(
          (async function* (): AsyncGenerator<StreamEvent> {
            controller.signal.throwIfAborted()
          })(),
          async () => {
            calls++
            throw new Error("unexpected")
          },
          controller.signal,
        ))
          void event
      })(),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(0)
  })
})

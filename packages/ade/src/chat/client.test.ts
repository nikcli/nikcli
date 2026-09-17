import { describe, expect, test } from "bun:test"
import { ChatError, streamChat } from "./client"

const sse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200 },
  )

const event = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`

const collect = async (chunks: string[]): Promise<string> => {
  let out = ""
  await streamChat({
    apiKey: "k",
    model: "m",
    messages: [{ role: "user", content: "ciao" }],
    onDelta: (text) => (out += text),
    fetchFn: async () => sse(chunks),
  })
  return out
}

describe("streamChat", () => {
  test("assembles a reply from its deltas", async () => {
    expect(await collect([event("Ciao"), event(" mondo"), "data: [DONE]\n"])).toBe("Ciao mondo")
  })

  test("survives a chunk boundary inside a JSON frame", async () => {
    const whole = event("indivisibile")
    const cut = Math.floor(whole.length / 2)
    expect(await collect([whole.slice(0, cut), whole.slice(cut), "data: [DONE]\n"])).toBe("indivisibile")
  })

  test("survives a multi-byte character split across chunks", async () => {
    // Without `decoder.decode(value, {stream: true})` this arrives as U+FFFD,
    // which on an Italian interface means every other accented word is broken.
    const bytes = new TextEncoder().encode(event("perché"))
    const whole = event("perché")
    const cut = whole.indexOf("perch") + 6 // lands inside the two bytes of "é"
    const head = new TextDecoder().decode(bytes.slice(0, 0)) // keep types honest

    let out = ""
    await streamChat({
      apiKey: "k",
      model: "m",
      messages: [],
      onDelta: (text) => (out += text),
      fetchFn: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, cut))
              controller.enqueue(bytes.slice(cut))
              controller.close()
            },
          }),
          { status: 200 },
        ),
    })
    expect(head).toBe("")
    expect(out).toBe("perché")
  })

  test("emits what the last chunk left behind when the terminator never comes", async () => {
    expect(await collect([event("troncato")])).toBe("troncato")
  })

  test("a missing key is refused before any request is made", async () => {
    let called = false
    await expect(
      streamChat({
        apiKey: "",
        model: "m",
        messages: [],
        onDelta: () => {},
        fetchFn: async () => {
          called = true
          return sse([])
        },
      }),
    ).rejects.toThrow(ChatError)
    expect(called).toBe(false)
  })

  test("prefers the provider's own explanation", async () => {
    const promise = streamChat({
      apiKey: "k",
      model: "m",
      messages: [],
      onDelta: () => {},
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 }),
    })
    await expect(promise).rejects.toThrow("Insufficient credits")
  })

  test("falls back to describing the status when the body says nothing", async () => {
    const promise = streamChat({
      apiKey: "k",
      model: "m",
      messages: [],
      onDelta: () => {},
      fetchFn: async () => new Response("<html>gateway</html>", { status: 502 }),
    })
    await expect(promise).rejects.toThrow("OpenRouter non risponde")
  })

  test("sends the system prompt ahead of the conversation", async () => {
    let sent: { role: string; content: string }[] = []
    await streamChat({
      apiKey: "k",
      model: "m",
      system: "sii breve",
      messages: [{ role: "user", content: "ciao" }],
      onDelta: () => {},
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init?.body)).messages
        return sse(["data: [DONE]\n"])
      },
    })
    expect(sent[0]).toEqual({ role: "system", content: "sii breve" })
    expect(sent[1]).toEqual({ role: "user", content: "ciao" })
  })
})

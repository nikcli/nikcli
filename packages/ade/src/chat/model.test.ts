import { describe, expect, test } from "bun:test"
import {
  appendDelta,
  appendMessage,
  conversationTitle,
  createChatState,
  MAX_CONTEXT_MESSAGES,
  messagesForRequest,
  scanSse,
  settleMessage,
  type ChatMessage,
} from "./model"

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  role: "user",
  text: "ciao",
  at: 1,
  ...over,
})

const event = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`

describe("scanSse", () => {
  test("decodes complete events", () => {
    const scan = scanSse(`${event("Ciao")}${event(" mondo")}`)
    expect(scan.deltas).toEqual(["Ciao", " mondo"])
    expect(scan.rest).toBe("")
    expect(scan.done).toBe(false)
  })

  test("holds a partial line back instead of dropping it", () => {
    // The regression this guards: a chunk boundary lands mid-JSON, which TCP
    // does routinely. A decoder that parses per-chunk loses exactly the tokens
    // that straddle the boundary, and it reads as a model swallowing words.
    const whole = event("parola")
    const cut = Math.floor(whole.length / 2)

    const first = scanSse(whole.slice(0, cut))
    expect(first.deltas).toEqual([])
    expect(first.rest).toBe(whole.slice(0, cut))

    const second = scanSse(first.rest + whole.slice(cut))
    expect(second.deltas).toEqual(["parola"])
    expect(second.rest).toBe("")
  })

  test("reports the terminator", () => {
    const scan = scanSse(`${event("fine")}data: [DONE]\n`)
    expect(scan.deltas).toEqual(["fine"])
    expect(scan.done).toBe(true)
  })

  test("skips comments, keep-alives and frames it cannot parse", () => {
    const scan = scanSse(`: keep-alive\n\n${event("ok")}data: {non json}\n`)
    expect(scan.deltas).toEqual(["ok"])
    expect(scan.done).toBe(false)
  })

  test("ignores an event with no content, such as a role-only opener", () => {
    const scan = scanSse(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n`)
    expect(scan.deltas).toEqual([])
  })
})

describe("messagesForRequest", () => {
  test("sends role and content, oldest first", () => {
    const state = [message({ id: "a", text: "domanda" }), message({ id: "b", role: "assistant", text: "risposta" })]
    expect(messagesForRequest(state)).toEqual([
      { role: "user", content: "domanda" },
      { role: "assistant", content: "risposta" },
    ])
  })

  test("drops a failed turn rather than sending an empty assistant message", () => {
    const state = [
      message({ id: "a", text: "domanda" }),
      message({ id: "b", role: "assistant", text: "", error: "rete non raggiungibile" }),
      message({ id: "c", text: "riprova" }),
    ]
    expect(messagesForRequest(state).map((m) => m.content)).toEqual(["domanda", "riprova"])
  })

  test("drops a message that is only whitespace", () => {
    const state = [message({ id: "a", text: "   " }), message({ id: "b", text: "vera" })]
    expect(messagesForRequest(state).map((m) => m.content)).toEqual(["vera"])
  })

  test("keeps only the most recent window", () => {
    const many = Array.from({ length: 40 }, (_, i) => message({ id: `m${i}`, text: `riga ${i}` }))
    const sent = messagesForRequest(many, 4)
    expect(sent).toHaveLength(4)
    expect(sent[0].content).toBe("riga 36")
    expect(sent[3].content).toBe("riga 39")
  })

  test("the default window is bounded", () => {
    const many = Array.from({ length: 200 }, (_, i) => message({ id: `m${i}`, text: `riga ${i}` }))
    expect(messagesForRequest(many)).toHaveLength(MAX_CONTEXT_MESSAGES)
  })
})

describe("settleMessage", () => {
  test("an error arriving mid-stream keeps what already streamed", () => {
    // Half an answer plus a reason beats either alone, and discarding the text
    // would make a flaky network look like a model that refuses to answer.
    let state = appendMessage(createChatState(), message({ id: "r", role: "assistant", text: "", streaming: true }))
    state = appendDelta(state, "r", "Ecco la prima")
    state = settleMessage(state, "r", "la connessione si è interrotta")

    expect(state.messages[0].text).toBe("Ecco la prima")
    expect(state.messages[0].error).toBe("la connessione si è interrotta")
    expect(state.messages[0].streaming).toBe(false)
  })

  test("a clean finish carries no error", () => {
    let state = appendMessage(
      createChatState(),
      message({ id: "r", role: "assistant", text: "fatto", streaming: true }),
    )
    state = settleMessage(state, "r")
    expect(state.messages[0].error).toBeUndefined()
    expect(state.messages[0].streaming).toBe(false)
  })
})

describe("conversationTitle", () => {
  test("uses the first question", () => {
    expect(conversationTitle([message({ text: "come funziona il parser" })])).toBe("come funziona il parser")
  })

  test("ignores an assistant message that came first", () => {
    const state = [message({ id: "a", role: "assistant", text: "Ciao!" }), message({ id: "b", text: "domanda vera" })]
    expect(conversationTitle(state)).toBe("domanda vera")
  })

  test("collapses whitespace and truncates", () => {
    expect(conversationTitle([message({ text: "una  domanda\nmolto lunga davvero" })], 12)).toBe("una domanda…")
  })

  test("names an empty conversation", () => {
    expect(conversationTitle([])).toBe("Nuova conversazione")
  })
})

/**
 * The chat section's state, as data.
 *
 * Kept apart from the component for the reason every pure module in this
 * package is: a `.tsx` has no automatic JSX runtime under `bun test` here, so
 * anything that lives in the component is untestable by construction. The two
 * things worth asserting — how a streamed response is decoded, and what is
 * sent back as context — are both here, and the component imports them rather
 * than carrying a second copy.
 */

export type ChatRole = "user" | "assistant"

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  at: number
  /** Set while the model is still streaming into this message. */
  streaming?: boolean
  /** Why this turn failed, when it did. Replaces the text, never joins it. */
  error?: string
}

export interface ChatState {
  messages: ChatMessage[]
}

export function createChatState(): ChatState {
  return { messages: [] }
}

/**
 * How many past messages travel with a request.
 *
 * A cap rather than the whole conversation, because the context window is
 * paid for by the token and an hour-long chat would quietly get expensive.
 * Pairs, so the window never starts on an assistant turn with no question.
 */
export const MAX_CONTEXT_MESSAGES = 24

/**
 * The messages to send, oldest first, excluding anything that failed.
 *
 * A failed turn is dropped rather than sent as an empty assistant message:
 * an assistant turn with no content is a malformed request on most providers,
 * and on the rest it teaches the model that saying nothing is a valid answer.
 */
export function messagesForRequest(
  messages: readonly ChatMessage[],
  max: number = MAX_CONTEXT_MESSAGES,
): { role: ChatRole; content: string }[] {
  const usable = messages.filter((message) => !message.error && message.text.trim().length > 0)
  const windowed = usable.slice(Math.max(0, usable.length - max))
  return windowed.map((message) => ({ role: message.role, content: message.text }))
}

/** A title for the conversation, taken from its first question. */
export function conversationTitle(messages: readonly ChatMessage[], max = 48): string {
  const first = messages.find((message) => message.role === "user" && message.text.trim())
  if (!first) return "Nuova conversazione"
  const text = first.text.trim().replace(/\s+/g, " ")
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ---------------------------------------------------------------------------
// Decoding the stream
// ---------------------------------------------------------------------------

export interface SseScan {
  /** Text fragments decoded from complete events in this buffer. */
  deltas: string[]
  /** What is left over: a partial line that the next chunk completes. */
  rest: string
  /** True once the provider sent its terminator. */
  done: boolean
}

/**
 * Pulls content deltas out of an SSE buffer, leaving any partial line behind.
 *
 * The leftover is the whole point. A network chunk boundary falls wherever
 * TCP puts it, routinely mid-JSON, and a decoder that parses each chunk on its
 * own drops exactly the tokens that straddle a boundary — which looks like a
 * model that occasionally swallows a word, not like a bug.
 *
 * Unparseable events are skipped rather than thrown: OpenRouter interleaves
 * comment lines and keep-alives, and one of those must not end a reply that
 * was streaming fine.
 */
export function scanSse(buffer: string): SseScan {
  const deltas: string[] = []
  let done = false

  // Only complete lines are consumed; the tail after the last newline stays.
  const lastBreak = buffer.lastIndexOf("\n")
  if (lastBreak === -1) return { deltas, rest: buffer, done }

  const complete = buffer.slice(0, lastBreak)
  const rest = buffer.slice(lastBreak + 1)

  for (const rawLine of complete.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith(":")) continue
    if (!line.startsWith("data:")) continue

    const payload = line.slice(5).trim()
    if (payload === "[DONE]") {
      done = true
      continue
    }

    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { content?: unknown } }[]
      }
      const content = parsed.choices?.[0]?.delta?.content
      if (typeof content === "string" && content.length > 0) deltas.push(content)
    } catch {
      // A keep-alive, a comment, or a provider-specific frame. Not our turn.
    }
  }

  return { deltas, rest, done }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function appendMessage(state: ChatState, message: ChatMessage): ChatState {
  return { messages: [...state.messages, message] }
}

export function updateMessage(state: ChatState, id: string, change: (message: ChatMessage) => ChatMessage): ChatState {
  return {
    messages: state.messages.map((message) => (message.id === id ? change(message) : message)),
  }
}

/** Adds a delta to the message being streamed. */
export function appendDelta(state: ChatState, id: string, delta: string): ChatState {
  return updateMessage(state, id, (message) => ({ ...message, text: message.text + delta }))
}

/**
 * Ends a streaming message, as a success or as a failure.
 *
 * A failure that arrives after some text has already streamed keeps that text
 * and carries the error beside it: half an answer plus "la connessione si è
 * interrotta" is more useful than either alone, and discarding what arrived
 * would make a flaky network look like a model that refuses.
 */
export function settleMessage(state: ChatState, id: string, error?: string): ChatState {
  return updateMessage(state, id, (message) => ({
    ...message,
    streaming: false,
    ...(error ? { error } : {}),
  }))
}

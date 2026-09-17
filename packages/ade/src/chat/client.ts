/**
 * Talking to a language model from the chat section.
 *
 * Separate from the planner in `@nikcli-ai/voice`, deliberately. That one is
 * single-shot, non-streaming and returns JSON: it exists to turn one sentence
 * into a plan, and answers arrive complete or not at all. A conversation needs
 * the opposite — many turns of context, and text on screen while it is still
 * being written. The two share only the key.
 *
 * The key itself is read from voice settings rather than asked for again.
 * Somebody who has already configured OpenRouter for the assistant has
 * configured it for this, and a second field for the same credential is a way
 * to get one of them wrong.
 */

import { scanSse } from "./model"

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

/**
 * The default model.
 *
 * A conversation is not a planner call: it is read by a person, so the
 * trade-off runs the other way — quality over the latency the planner needs.
 */
export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4.5"

/** Models offered in the picker. The user can still type another. */
export const CHAT_MODELS: readonly { id: string; label: string }[] = [
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "anthropic/claude-opus-4.1", label: "Claude Opus 4.1" },
  { id: "openai/gpt-5", label: "GPT-5" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "deepseek/deepseek-chat-v3.1", label: "DeepSeek V3.1" },
]

export const DEFAULT_SYSTEM_PROMPT =
  "Sei l'assistente di ADE, l'ambiente di sviluppo dell'utente. " +
  "Rispondi in italiano, in modo diretto e conciso. " +
  "Quando mostri codice, usa blocchi delimitati da tre backtick con il linguaggio."

export interface ChatRequest {
  apiKey: string
  model: string
  system?: string
  messages: readonly { role: "user" | "assistant"; content: string }[]
  signal?: AbortSignal
  /** Called with each fragment as it arrives. */
  onDelta: (text: string) => void
  /** Injected by tests; defaults to the global. */
  fetchFn?: FetchLike
}

/**
 * Only the shape this file calls.
 *
 * Narrower than `typeof fetch` on purpose: Bun's global carries `preconnect`,
 * so a test double typed against the full signature has to stub a method
 * nothing here will ever call.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * An error the user is meant to read.
 *
 * The provider's own message is preferred when it has one — "insufficient
 * credits" is worth showing verbatim — and the status is only described in
 * words when it does not.
 */
export class ChatError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "ChatError"
    this.status = status
  }
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) return "La chiave OpenRouter è stata rifiutata."
  if (status === 402) return "Credito OpenRouter esaurito."
  if (status === 404) return "Il modello richiesto non esiste su OpenRouter."
  if (status === 429) return "Troppe richieste: riprova fra qualche secondo."
  if (status >= 500) return "OpenRouter non risponde. Riprova."
  return `OpenRouter ha risposto ${status}.`
}

async function readError(response: Response): Promise<ChatError> {
  let detail = ""
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    if (typeof body.error?.message === "string") detail = body.error.message
  } catch {
    // A non-JSON error body. The status alone will have to do.
  }
  return new ChatError(detail || describeStatus(response.status), response.status)
}

/**
 * Streams one assistant turn, calling `onDelta` as text arrives.
 *
 * Resolves when the stream ends. Throws `ChatError` for anything the user can
 * act on, and rethrows an abort untouched so the caller can tell "stopped on
 * purpose" from "broke".
 */
export async function streamChat(request: ChatRequest): Promise<void> {
  if (!request.apiKey) {
    throw new ChatError("Manca la chiave OpenRouter: aggiungila nelle impostazioni vocali, in alto a destra.")
  }

  const fetchFn = request.fetchFn ?? fetch
  const response = await fetchFn(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model,
      stream: true,
      messages: [{ role: "system", content: request.system ?? DEFAULT_SYSTEM_PROMPT }, ...request.messages],
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  })

  if (!response.ok) throw await readError(response)
  if (!response.body) throw new ChatError("OpenRouter ha risposto senza corpo.")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      // `stream: true` matters: a multi-byte character split across two
      // network chunks decodes to a replacement character without it.
      buffer += decoder.decode(value, { stream: true })

      const scan = scanSse(buffer)
      buffer = scan.rest
      for (const delta of scan.deltas) request.onDelta(delta)
      if (scan.done) return
    }

    // Whatever the last chunk left behind, now that no more is coming.
    const tail = scanSse(buffer.endsWith("\n") ? buffer : `${buffer}\n`)
    for (const delta of tail.deltas) request.onDelta(delta)
  } finally {
    // Releasing the lock lets the body be cancelled by an abort that lands
    // while we are between reads; without it the connection leaks.
    reader.releaseLock()
  }
}

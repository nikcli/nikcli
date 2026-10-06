import type { StreamEvent, StreamOutput } from "./types"

export async function* withStreamFallback(
  native: AsyncIterable<StreamEvent>,
  fallback: () => Promise<StreamOutput>,
  abort: AbortSignal,
  onFallback?: (reason: string) => void,
): AsyncGenerator<StreamEvent> {
  let committed = false
  const pending: StreamEvent[] = []
  try {
    for await (const event of native) {
      if (event.type === "error") throw event.error
      if (!committed && event.type !== "start" && event.type !== "start-step") {
        committed = true
        yield* pending
        pending.length = 0
      }
      if (committed) yield event
      else pending.push(event)
    }
    yield* pending
  } catch (error) {
    // Never replay model output or tool execution, and never retry cancellation.
    if (committed || abort.aborted || (error instanceof Error && error.name === "AbortError")) throw error
    onFallback?.(error instanceof Error ? error.message : String(error))
    yield* (await fallback()).fullStream
  }
}

import {
  describeCapabilities,
  formatReply,
  parseRequest,
  type PanelOutcome,
  type PanelRequest,
  type PanelVerb,
} from "./protocol"

/**
 * Where a request from an agent ends up.
 *
 * `protocol.ts` decides what a request *is*; this decides who answers it.
 * Kept apart because the two fail differently: a grammar bug makes ADE act on
 * prose, and a routing bug makes ADE answer for a panel that is not open —
 * and the second one is the plausible-looking failure, because the reply is
 * well-formed and simply untrue.
 *
 * A panel registers when it mounts and unregisters when it goes. Nothing is
 * remembered across that: an agent that asks the video panel to play after
 * the user closed it is told there is no video panel, which is a sentence it
 * can act on. Answering "ok" would leave it reasoning about a frame nobody
 * is showing.
 */

export interface PanelHandler {
  /** What this panel can be asked, for the greeting typed into a session. */
  readonly verbs: readonly PanelVerb[]
  /** `from` is the session that wrote the request, for a panel that answers each session apart. */
  run(request: PanelRequest, from?: string): Promise<PanelOutcome>
}

export type HandledRequest =
  | {
      readonly request: PanelRequest
      /** The single line to type back into the session that asked. */
      readonly reply: string
    }
  | {
      readonly request: PanelRequest
      /**
       * The request was not run, and this says why, for the transcript only.
       * Typing it back would make the TUI redraw, and the line come again.
       */
      readonly skipped: string
    }

export interface PanelRouter {
  register(panel: string, handler: PanelHandler): void
  /**
   * Removes `panel`. With `handler`, only if that is still the one registered:
   * two panes of one kind share a name, and closing the older one must not
   * silence the one still open.
   */
  unregister(panel: string, handler?: PanelHandler): void
  /** The panels that can be driven right now, in the order they opened. */
  open(): string[]
  /**
   * Reads one line of agent output from session `from`.
   *
   * Resolves to `undefined` when the line was not a request at all, which is
   * almost every line — the caller must not treat that as a failure.
   *
   * Not run, and answered with `skipped` instead: text ADE typed into that
   * session in the last `ECHO_WINDOW_MS` coming back as echo, and a request
   * the session showed within `REPEAT_WINDOW_MS` of this turn — a TUI
   * redraws its screen, and every redraw hands the same line to `onLine`
   * again. Only the first skip of a run says so; the rest are `undefined`.
   */
  handle(line: string, from?: string, now?: number): Promise<HandledRequest | undefined>
  /** Records text ADE typed into session `from`, so its echo is not read as the agent's. */
  typed(from: string, text: string, now?: number): void
  /**
   * Session `from` started a turn of its own: the user or a message typed
   * into it, or its hook said busy. A request it repeats from now on is a new
   * one. Ignored within `ECHO_WINDOW_MS` of a panel reply, whose typing is
   * what started that turn and whose redraw would bring the old line back.
   */
  newTurn(from: string, now?: number): void
  /** The lines that tell a session a panel exists. Empty when it does not. */
  greeting(panel: string): string[]
}

/** A request line seen again this soon after its last sighting is a redraw, not a new request. */
export const REPEAT_WINDOW_MS = 30_000
/**
 * How long text ADE typed into a session can come back as its echo.
 *
 * Seconds, not minutes: a message that quoted `@ade model state` ten minutes
 * ago must not swallow the agent writing it now. A TUI that keeps redrawing
 * the echo past this is caught as a repeat, since the echo was seen.
 */
export const ECHO_WINDOW_MS = 5_000
/** The most typed texts remembered per session. */
const MAX_TYPED = 32

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

/** `clock` is only for tests: it tells how long a handler took. */
export function createPanelRouter(clock: () => number = Date.now): PanelRouter {
  const handlers = new Map<string, PanelHandler>()
  const typedBy = new Map<string, { text: string; at: number }[]>()
  /** Each request line a session showed this turn: when last, and whether its skip was already said. */
  const seenBy = new Map<string, Map<string, { at: number; noted: boolean }>>()
  const repliedAt = new Map<string, number>()

  /** Whether `raw` is part of something ADE just typed into `from`, echoed by its TUI. */
  const isEcho = (from: string, raw: string, now: number) =>
    (typedBy.get(from) ?? []).some((entry) => now - entry.at < ECHO_WINDOW_MS && entry.text.includes(raw))

  const seenIn = (from: string, now: number) => {
    let seen = seenBy.get(from)
    if (!seen) seenBy.set(from, (seen = new Map()))
    if (seen.size > 64) for (const [key, entry] of seen) if (now - entry.at >= REPEAT_WINDOW_MS) seen.delete(key)
    return seen
  }

  const answer = async (request: PanelRequest, from: string): Promise<string> => {
    const handler = handlers.get(request.panel)
    if (!handler) {
      const open = [...handlers.keys()]
      const detail = open.length === 0 ? "nessun pannello aperto" : `pannelli aperti: ${open.join(", ")}`
      return formatReply(request, { ok: false, reason: `«${request.panel}» non è aperto; ${detail}` })
    }

    try {
      return formatReply(request, await handler.run(request, from || undefined))
    } catch (error) {
      /*
       * A handler that throws still gets an answer typed back.
       *
       * The agent is waiting on a line. Letting the exception escape would
       * leave it waiting forever, which looks from the outside exactly like
       * an agent that has stopped thinking.
       */
      const reason = error instanceof Error && error.message ? error.message : "non riuscito"
      return formatReply(request, { ok: false, reason })
    }
  }

  return {
    register(panel, handler) {
      handlers.set(panel, handler)
    },

    unregister(panel, handler) {
      if (handler && handlers.get(panel) !== handler) return
      handlers.delete(panel)
    },

    open() {
      return [...handlers.keys()]
    },

    typed(from, text, now = Date.now()) {
      const entries = (typedBy.get(from) ?? []).filter((entry) => now - entry.at < ECHO_WINDOW_MS)
      entries.push({ text: normalize(text), at: now })
      typedBy.set(from, entries.slice(-MAX_TYPED))
    },

    newTurn(from, now = Date.now()) {
      if (now - (repliedAt.get(from) ?? -Infinity) < ECHO_WINDOW_MS) return
      seenBy.delete(from)
    },

    async handle(line, from = "", now = Date.now()) {
      const request = parseRequest(line)
      if (!request) return undefined
      const raw = normalize(request.raw)
      const seen = seenIn(from, now)
      const last = seen.get(raw)
      const echo = isEcho(from, raw, now)
      const repeat = last !== undefined && now - last.at < REPEAT_WINDOW_MS
      if (echo || repeat) {
        seen.set(raw, { at: now, noted: true })
        if (repeat && last?.noted) return undefined
        const why = echo
          ? "è l'eco di un testo che ADE ha appena scritto nella sessione"
          : `è uguale a una di meno di ${REPEAT_WINDOW_MS / 1000} s fa in questo turno, come nel ridisegno di una TUI`
        return { request, skipped: `Riga non eseguita: ${raw} — ${why}` }
      }
      seen.set(raw, { at: now, noted: false })
      const started = clock()
      const reply = await answer(request, from)
      // When the reply is typed, not when the request came: a capture can take
      // seconds, and the busy that the reply causes must still fall within the window.
      repliedAt.set(from, now + (clock() - started))
      return { request, reply }
    },

    greeting(panel) {
      const handler = handlers.get(panel)
      return handler ? describeCapabilities(panel, handler.verbs) : []
    },
  }
}

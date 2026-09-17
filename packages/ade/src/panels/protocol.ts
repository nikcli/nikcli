/**
 * How an agent drives a panel.
 *
 * ADE's panels — the browser, and now a video player, with a mobile emulator
 * and a 3D viewer to follow — are things the user can operate. An agent that
 * has just written the code cannot operate any of them: it can only describe
 * what it would like done and wait for a person to do it.
 *
 * There is no channel for this today and no CLI knows how to use one. Every
 * agent ADE runs is a program in a pty: it reads keystrokes and it writes
 * text, and that is the whole interface. So the channel is text. The agent
 * writes one line in a shape nothing else writes, ADE reads it — `onLine`
 * already reads every line, which is exactly how permission prompts are
 * noticed — performs the action, and types the answer back as if the user had
 * typed it.
 *
 * That choice is what makes it work with all eleven CLIs today rather than
 * with the two that speak MCP. It is also the honest limit of the approach:
 * an agent only does this if something tells it to, which is what
 * `describeCapabilities` is for.
 *
 * Pure, and in its own `.ts`, because a `.tsx` cannot be imported under
 * `bun test` here and this grammar is the part that must not be wrong.
 */

/**
 * The sentinel that opens a request.
 *
 * Deliberately not a word an agent writes by accident, and deliberately
 * readable: it shows up in the transcript, and a user who sees it should be
 * able to tell what their agent just did.
 */
export const REQUEST_PREFIX = "@ade"

/** What ADE writes back, so a reply is never mistaken for a new request. */
export const REPLY_PREFIX = "@ade:"

/** How long an argument may be. Beyond this it is not an argument. */
const MAX_ARGUMENT = 512

export interface PanelRequest {
  /** Which panel the agent is addressing: "video", "browser", … */
  readonly panel: string
  /** What it wants done: "play", "seek", "capture", … */
  readonly verb: string
  /** Everything after the verb, split on whitespace, quotes honoured. */
  readonly args: readonly string[]
  /** The line as it arrived, for the transcript. */
  readonly raw: string
}

/**
 * Reads a request out of one line of agent output, or nothing.
 *
 * Strict on purpose. The line must be a request and nothing else: an agent
 * explaining the protocol in prose ("you can write @ade video play to…")
 * must not thereby start the video. Requiring the sentinel to open the line
 * and the line to hold nothing before it is what separates the two, and it
 * is a rule an agent can follow without ambiguity.
 */
export function parseRequest(line: string): PanelRequest | undefined {
  const trimmed = line.trim()
  // A reply ADE itself typed is echoed back by the terminal. Reading it as a
  // request would be a loop with no exit.
  if (trimmed.startsWith(REPLY_PREFIX)) return undefined
  if (!trimmed.startsWith(`${REQUEST_PREFIX} `)) return undefined

  const rest = trimmed.slice(REQUEST_PREFIX.length).trim()
  const tokens = tokenize(rest)
  const panel = tokens[0]?.toLowerCase()
  const verb = tokens[1]?.toLowerCase()
  if (!panel || !verb) return undefined
  if (!isName(panel) || !isName(verb)) return undefined

  return { panel, verb, args: tokens.slice(2), raw: trimmed }
}

/**
 * A panel and a verb are identifiers, not free text.
 *
 * Anything else is prose that happened to start with the sentinel, and
 * acting on it would be acting on a sentence. A leading digit is allowed
 * because `3d` is the name the 3D panel will have and refusing it would
 * cost an agent a turn to discover.
 */
function isName(token: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(token)
}

/**
 * Splits arguments, honouring double quotes.
 *
 * A path with a space in it is the ordinary case — it is the reason
 * `formatDroppedPaths` quotes — so an agent has to be able to pass one.
 */
function tokenize(text: string): string[] {
  const out: string[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const token = match[1] ?? match[2] ?? ""
    if (token.length > 0) out.push(token.slice(0, MAX_ARGUMENT))
  }
  return out
}

export type PanelOutcome =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: string }

/**
 * The single line ADE types back.
 *
 * One line, because it is going into a pty where a line break submits: see
 * `session/typing.ts`. Prefixed so the agent can find its answer among its
 * own output, and so the next read of the same line is not taken for a new
 * request.
 */
export function formatReply(request: PanelRequest, outcome: PanelOutcome): string {
  const head = `${REPLY_PREFIX} ${request.panel} ${request.verb}`
  return outcome.ok ? `${head} ok — ${outcome.detail}` : `${head} errore — ${outcome.reason}`
}

export interface PanelVerb {
  readonly name: string
  /** How it is written, arguments included: `seek <tempo>`. */
  readonly usage: string
  /** One line, in Italian, as the user reads everything else in ADE. */
  readonly summary: string
}

/**
 * The panels section of `ade-msg help`: one line per panel.
 *
 * How an agent learns the channel exists, now that nothing is typed into its
 * pty. The sentinel is never followed by a real panel and command, not even
 * mid-line: the help is printed in the agent's own output, and a narrow
 * pane that wraps it there would hand `onLine` a request.
 */
export function panelsHelp(panels: readonly { panel: string; verbs: readonly PanelVerb[] }[]): string {
  const width = Math.max(0, ...panels.map(({ panel }) => panel.length)) + 1
  return (
    [
      `pannelli (se aperti in ADE): scrivi da sola nella tua risposta la riga ${REQUEST_PREFIX} <pannello> <comando>;`,
      `  ADE risponde con una riga "${REPLY_PREFIX} <pannello> <comando> ok|errore — …"`,
      ...panels.map(
        ({ panel, verbs }) => `  ${`${panel}:`.padEnd(width + 1)}${verbs.map((verb) => verb.usage).join(" | ")}`,
      ),
    ].join("\n") + "\n"
  )
}

/**
 * What ADE tells a session so its agent knows any of this exists.
 *
 * Noted in the session's transcript when a panel it can drive is opened,
 * never typed into its pty: every typed line is a prompt the agent must
 * answer, and a TUI redrawing the usage lines handed them back to `onLine`
 * as requests. See `announcePanels` in `workbench.tsx`.
 *
 * Returned as an array of lines, one transcript line each.
 */
export function describeCapabilities(panel: string, verbs: readonly PanelVerb[]): string[] {
  if (verbs.length === 0) return []
  return [
    `${REPLY_PREFIX} è aperto un pannello "${panel}" che puoi comandare tu.`,
    `${REPLY_PREFIX} scrivi una riga da sola nella forma: ${REQUEST_PREFIX} ${panel} <comando>`,
    ...verbs.map((verb) => `${REPLY_PREFIX}   ${REQUEST_PREFIX} ${panel} ${verb.usage} — ${verb.summary}`),
    `${REPLY_PREFIX} rispondo sulla stessa riga con "${REPLY_PREFIX} ${panel} <comando> ok" o "errore".`,
  ]
}

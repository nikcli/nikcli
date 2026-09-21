import { bodyRows, worthCollapsing } from "../../component/disclosure"

/**
 * Turn model for the session view — the seam between the renderer and the
 * conversation data.
 *
 * The renderer draws from v2 entries, the model every other client (mobile,
 * desktop, plugins, SDK) already uses:
 *
 *     fromEntries(entries) ─► Turn[] ─► renderer
 *
 * It used to have a second source, `fromMessages`, converting v1 messages and
 * parts into the same turns; the migration ran with both behind a flag until
 * the entry source had soaked, and the pair was held equivalent by test. That
 * is finished — entries are the only source now, so there is one shape in
 * memory instead of two and nothing has to prove they agree.
 *
 * **The unit is the turn, and a turn is a message.** That is deliberate: the
 * renderer virtualizes over messages (see `MESSAGE_HEIGHT_ESTIMATE` in
 * index.tsx), and keying turns on `messageID` keeps the number of windowed
 * units — and therefore the scroll maths, the fork/revert dialogs and
 * `TurnUsage` — exactly where they are. Entries carry `messageID` precisely
 * so this grouping is free.
 *
 * Deliberately dependency-free: no Solid, no store access, no SDK client.
 * It takes data and returns data, which is why it can be tested without
 * standing up a TUI — same rule as `rows.ts`.
 */

// ============================================================================
// Minimum shapes
// ============================================================================
//
// Structural, not imported from the SDK: this module is compiled into tests
// that construct fixtures by hand, and naming only the fields it reads makes
// the renderer's real dependency surface visible. Every field below is one
// the session components actually use.

export type ViewEntry = {
  readonly id: string
  readonly sessionID: string
  readonly messageID?: string
  readonly type: string
  readonly timestamp: number
  readonly ref?: string
  readonly [key: string]: unknown
}

/**
 * One turn of the conversation.
 *
 * `head` is what frames it — the `user` entry, or the assistant `start`.
 * `body` is the content the renderer folds into rows. `complete` is present
 * once the turn is sealed, and carries everything the footer shows (finish
 * reason, tokens, terminal error).
 */
export type Turn = {
  readonly messageID: string
  readonly sessionID: string
  readonly role: "user" | "assistant"
  readonly createdAt: number
  readonly completedAt?: number
  /**
   * When the turn before this one started.
   *
   * The footer shows how long a step took counting from the prompt that
   * caused it. v1 read that off `message.parentID`; a turn list has the
   * answer next door, without needing a back-reference on the entry.
   */
  readonly previousCreatedAt?: number
  /** Model, agent and mode the turn ran with. Absent on user turns. */
  readonly request?: {
    readonly agent: string
    readonly mode: string
    readonly modelID: string
    readonly providerID: string
  }
  readonly complete?: {
    readonly finish?: string
    readonly error?: unknown
    readonly outputTokens: number
    readonly cost: number
  }
  /** True when history was compacted at this turn. */
  readonly compacted: boolean
  /** Content entries, in order. */
  readonly body: ViewEntry[]
}

// ============================================================================
// From entries
// ============================================================================

/**
 * Group flat entries into turns.
 *
 * Entries arrive already ordered (their id *is* the sort key — see
 * `SessionEntry.idForPart`), so this is a single pass that only has to notice
 * where `messageID` changes.
 */
export function fromEntries(entries: readonly ViewEntry[]): Turn[] {
  // Built mutably, then frozen into `Turn`s by `link`. The previous version
  // spread the turn on every entry (`{ ...turn, body: [...turn.body, entry] }`),
  // which made a turn of k entries cost O(k²) copies — paid again on every
  // rebuild, i.e. on every part that arrives during a stream.
  const turns: Mutable[] = []
  const index = new Map<string, number>()

  for (const entry of entries) {
    const messageID = entry.messageID
    if (!messageID) continue

    let at = index.get(messageID)
    if (at === undefined) {
      at = turns.length
      index.set(messageID, at)
      turns.push({
        messageID,
        sessionID: entry.sessionID,
        role: entry.type === "user" ? "user" : "assistant",
        createdAt: entry.timestamp,
        compacted: false,
        body: [],
      })
    }

    const turn = turns[at]!
    if (entry.type === "user") {
      turn.role = "user"
      turn.createdAt = entry.timestamp
      turn.body.push(entry)
      continue
    }

    if (entry.type === "start") {
      turn.role = "assistant"
      turn.createdAt = entry.timestamp
      turn.request = {
        agent: String(entry.agent ?? ""),
        mode: String(entry.mode ?? ""),
        modelID: String(entry.modelID ?? ""),
        providerID: String(entry.providerID ?? ""),
      }
      continue
    }

    if (entry.type === "complete") {
      const tokens = entry.tokens as { output?: number } | undefined
      turn.completedAt = entry.timestamp
      turn.complete = {
        finish: entry.finish as string | undefined,
        error: entry.error,
        outputTokens: tokens?.output ?? 0,
        cost: typeof entry.cost === "number" ? entry.cost : 0,
      }
      continue
    }

    if (entry.type === "compaction") {
      turn.compacted = true
      continue
    }

    if (
      entry.type === "snapshot" ||
      entry.type === "patch" ||
      entry.type === "step-start" ||
      entry.type === "step-finish"
    ) {
      continue
    }

    turn.body.push(entry)
  }

  return link(turns)
}

/** `Turn` while it is still being assembled. */
type Mutable = {
  -readonly [K in keyof Turn]: Turn[K]
}

/** Give every turn the start time of the one before it. */
function link(turns: Mutable[]): Turn[] {
  for (let index = 1; index < turns.length; index++) {
    turns[index]!.previousCreatedAt = turns[index - 1]!.createdAt
  }
  return turns
}

// ============================================================================
// Identity across rebuilds
// ============================================================================

/**
 * Keep the object identity of turns that did not change.
 *
 * The renderer draws the turn list with Solid's `<For>`, which reconciles by
 * **reference**. `fromEntries` allocates a fresh `Turn` for every message on
 * every run, so without this every entry that arrives — a tool call, a new
 * text part, the `complete` that seals the turn — handed `<For>` an entirely
 * new list and made it dispose and recreate *every message in the
 * conversation*. That is the flicker: the whole transcript is torn down and
 * repainted several times per assistant turn, and it gets worse the longer the
 * session runs.
 *
 * Returning the previous object for an unchanged turn means `<For>` leaves it
 * mounted. Only the turn that actually changed is rebuilt.
 *
 * Comparing `body` by reference is what makes this work *and* what keeps
 * streamed text live: entries are updated in place in the sync store
 * (`setStore(..., reconcile(entry))`), so a token delta does not change any
 * reference here — the turn stays identical and the leaf component, which
 * reads `entry.text` through the store, repaints on its own. A turn is only
 * rebuilt when its set of entries changes.
 */
export function stabilize(previous: readonly Turn[], next: readonly Turn[]): Turn[] {
  if (previous.length === next.length && previous.every((turn, index) => sameTurn(turn, next[index]!))) {
    return previous as Turn[]
  }
  const before = new Map(previous.map((turn) => [turn.messageID, turn]))
  return next.map((turn) => {
    const old = before.get(turn.messageID)
    return old && sameTurn(old, turn) ? old : turn
  })
}

function sameTurn(a: Turn, b: Turn): boolean {
  return (
    a.messageID === b.messageID &&
    a.sessionID === b.sessionID &&
    a.role === b.role &&
    a.createdAt === b.createdAt &&
    a.completedAt === b.completedAt &&
    a.previousCreatedAt === b.previousCreatedAt &&
    a.compacted === b.compacted &&
    sameRequest(a.request, b.request) &&
    sameComplete(a.complete, b.complete) &&
    sameBody(a.body, b.body)
  )
}

function sameRequest(a: Turn["request"], b: Turn["request"]): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.agent === b.agent && a.mode === b.mode && a.modelID === b.modelID && a.providerID === b.providerID
}

function sameComplete(a: Turn["complete"], b: Turn["complete"]): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.finish === b.finish && a.error === b.error && a.outputTokens === b.outputTokens && a.cost === b.cost
}

function sameBody(a: readonly ViewEntry[], b: readonly ViewEntry[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
}

// ============================================================================
// Height estimation
// ============================================================================

/** A tool call, a reasoning block, or any other non-text entry, collapsed. */
const ENTRY_ROWS = 1

/**
 * Rows a turn spends on chrome rather than content.
 *
 * These used to be literals here, duplicating the paddings the message
 * components hardcoded in `index.tsx`. That was safe only while both sides were
 * literals. Now that a theme can restyle those boxes, the caller passes the
 * figure derived from the *resolved* style (`chromeRows` in
 * `context/component-tokens.ts`), and these serve as the default for callers
 * that have no theme in hand — tests, and any pure-view use.
 *
 * The default is 3 because that is what the stock style resolves to:
 * `paddingTop 1 + paddingBottom 1 + marginTop 1`.
 */
export type TurnHeightMetrics = {
  readonly chromeRows: number
  readonly entryRows: number
}

export const DEFAULT_TURN_HEIGHT_METRICS: TurnHeightMetrics = {
  chromeRows: 3,
  entryRows: ENTRY_ROWS,
}

/**
 * How tall a turn is likely to render, in rows, at a given width.
 *
 * The virtualizer used a flat 6 for every turn. A constant is wrong in both
 * directions and the errors do not cancel: a one-line acknowledgement is
 * over-reserved while a fifty-line diff is under-reserved by an order of
 * magnitude, so the scroll offset drifts further the more the transcript mixes
 * the two — which is what a transcript is.
 *
 * This is still an **estimate**, derived from content rather than measured from
 * a rendered row. The measured-height endpoint EOT-06 describes needs heights
 * fed back from the renderer and a real terminal to verify against; this is the
 * part that can be computed purely, and it is strictly closer than a constant.
 *
 * Deliberately cheap: it runs for every turn on every scroll tick, so it counts
 * newlines and divides, and never touches a layout engine.
 */
export function estimateTurnHeight(
  turn: Turn,
  width: number,
  metrics: TurnHeightMetrics = DEFAULT_TURN_HEIGHT_METRICS,
): number {
  // A zero or negative width is a viewport that has not reported yet. Wrapping
  // against it would divide by zero and poison every offset after it.
  const columns = Math.max(1, Math.floor(width) || 1)
  let rows = metrics.chromeRows

  for (const [index, entry] of turn.body.entries()) {
    const text = typeof entry.text === "string" ? entry.text : undefined
    if (text === undefined) {
      rows += metrics.entryRows
      continue
    }
    // A user body tall enough to collapse renders as one row until somebody
    // expands it, and collapsed is the default. Counting it whole would have
    // the virtualizer reserve thirty rows for a wake message that draws one.
    //
    // `body[0]` and no further, because that is precisely what `UserMessage`
    // draws: a user turn is one entry to it, and anything after the first is
    // already counted here without being rendered at all.
    if (turn.role === "user" && index === 0 && worthCollapsing(text, columns)) {
      rows += 1
      continue
    }
    // Every hard line break is a row, and each line wraps by width. An empty
    // line still occupies one.
    rows += bodyRows(text, columns)
  }

  return rows
}

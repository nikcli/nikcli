/**
 * Who speaks, in what order, and when the room stops.
 *
 * A room is two to six bots in one conversation. The rule the reference
 * implementations settled on, and the one encoded here, is:
 *
 *   - a message that mentions bots is answered by those bots, in the order
 *     they were mentioned;
 *   - a message that mentions nobody is answered by every member, in roster
 *     order;
 *   - a bot may pass rather than reply, and a pass is not a turn wasted;
 *   - the room runs at most three serial rounds per user message.
 *
 * Every clause of that is a bound on something that otherwise does not
 * terminate. Six bots each replying to each other's replies is not a
 * conversation, it is a loop that bills the user for it — which is why the
 * round cap is not a tuning knob and why a round in which everyone passes
 * ends the exchange rather than trying again.
 *
 * Pure, and apart from the component, because this is the part that must be
 * right: the failure mode is not a wrong pixel, it is a room that will not
 * stop talking.
 */

/**
 * The two things a room needs to know about a member.
 *
 * Deliberately narrower than a bot. A room decides who speaks, and that needs
 * an identity to address and a name the user can type after an `@`; nothing
 * here has any business knowing which model a bot runs on or where its file
 * is. Narrow enough that both a nikcli agent — where the identity is the
 * filename — and anything later can be a member without this file changing.
 */
export interface RoomMember {
  readonly id: string
  readonly name: string
}

/** The smallest room that is a room rather than a chat. */
export const MIN_MEMBERS = 2

/**
 * The largest.
 *
 * Beyond six, a single user message costs six replies a round and three
 * rounds, and nobody reads eighteen paragraphs. The limit is a kindness to
 * the reader before it is one to the bill.
 */
export const MAX_MEMBERS = 6

/** How many serial rounds one user message may set off. */
export const MAX_ROUNDS = 3

export interface RoomTurn {
  readonly botId: string
  /** 1-based, so "round 1" in the interface is `round === 1`. */
  readonly round: number
}

/**
 * Finds the bots a message addresses, in the order it addresses them.
 *
 * `@name`, matched against the roster rather than against a pattern: a bot
 * called "revisore senior" cannot be found by a regex that stops at the
 * space, and asking users to type a slug instead of the name they gave is
 * asking them to remember two names per bot.
 *
 * Order is the order of mention, because "@alfa, chiedi a @beta" reads as a
 * sequence and answering it backwards reads as not having been understood.
 */
export function mentionedBots(text: string, members: readonly RoomMember[]): string[] {
  const haystack = text.toLowerCase()
  const found: { id: string; at: number }[] = []

  for (const bot of members) {
    const needle = `@${bot.name.toLowerCase()}`
    const at = haystack.indexOf(needle)
    if (at === -1) continue
    /*
     * The mention must end at a boundary. Without this, a room holding
     * both "rev" and "revisore" has every mention of @revisore also
     * waking @rev, which looks like a bot answering questions addressed
     * to someone else.
     */
    const after = haystack[at + needle.length]
    if (after !== undefined && /[\p{L}\p{N}]/u.test(after)) continue
    found.push({ id: bot.id, at })
  }

  return found.sort((a, b) => a.at - b.at).map((entry) => entry.id)
}

/**
 * Who answers this message, in order.
 *
 * The mentioned ones if any were mentioned; otherwise everyone. Members are
 * given in roster order and that order is kept, so the room reads the same
 * way twice.
 */
export function respondersFor(text: string, members: readonly RoomMember[]): string[] {
  const mentioned = mentionedBots(text, members)
  if (mentioned.length > 0) return mentioned
  return members.map((bot) => bot.id)
}

export interface RoundState {
  /** Which round has just finished, 1-based. Zero before the first. */
  readonly round: number
  /** Whether anybody said anything in it. */
  readonly anyoneSpoke: boolean
}

/**
 * Whether the room goes round again.
 *
 * Two ways to stop, and both are needed. The cap stops a room where every
 * bot always has something to add; the silence check stops one where they
 * do not, without making the user wait out two more empty rounds to find
 * that out.
 */
export function continuesAfter(state: RoundState): boolean {
  if (state.round >= MAX_ROUNDS) return false
  return state.anyoneSpoke
}

/**
 * The full running order for one user message, assuming nobody passes.
 *
 * Used to show the user what is about to happen before it does — a room
 * that starts producing text with no indication of how much is coming is
 * one people interrupt out of uncertainty. Passing shortens this; nothing
 * lengthens it.
 */
export function plannedTurns(text: string, members: readonly RoomMember[]): RoomTurn[] {
  const responders = respondersFor(text, members)
  if (responders.length === 0) return []

  const turns: RoomTurn[] = []
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const botId of responders) turns.push({ botId, round })
  }
  return turns
}

export type RoomProblem = "troppo-pochi" | "troppi" | "duplicati"

/**
 * Whether these members make a room, and what is wrong when they do not.
 *
 * Returned rather than thrown, and named rather than boolean, because the
 * interface has to say which of the three it is: "seleziona almeno due bot"
 * and "al massimo sei" are different instructions.
 */
export function roomProblem(memberIds: readonly string[]): RoomProblem | undefined {
  if (new Set(memberIds).size !== memberIds.length) return "duplicati"
  if (memberIds.length < MIN_MEMBERS) return "troppo-pochi"
  if (memberIds.length > MAX_MEMBERS) return "troppi"
  return undefined
}

/** The sentence shown beside a room that cannot start. */
export function describeProblem(problem: RoomProblem): string {
  switch (problem) {
    case "troppo-pochi":
      return `Servono almeno ${MIN_MEMBERS} bot: con uno solo è una chat.`
    case "troppi":
      return `Al massimo ${MAX_MEMBERS} bot: oltre, un messaggio ne produce troppi.`
    case "duplicati":
      return "Lo stesso bot è stato aggiunto due volte."
  }
}

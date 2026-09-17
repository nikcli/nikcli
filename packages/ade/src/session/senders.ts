/**
 * Mailbox identities for processes that are not panes.
 *
 * `ade-msg` proves who is speaking with a token ADE put in the process's
 * environment, and until now only a pane's process had one. A turn run in
 * the background (the voice agent, a bot) is not a pane, but it may still need
 * to list sessions, ask them, spawn one and close what it spawned, and for
 * that its messages must not arrive anonymous. It registers here for the
 * length of the turn, and the mailbox accepts its token like a pane's.
 *
 * Such a sender has no terminal, so nothing can be typed into it: it should
 * wait for answers with a blocking `ade-msg ask`, not `--no-wait`.
 */

const tokens = new Map<string, string>()

/** Ids look like a pane's so `ade-msg` passes them through, and say what they are. */
export function isSenderId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id)
}

export function registerSender(id: string, token: string): void {
  if (!isSenderId(id)) throw new Error(`id mittente non valido: ${id}`)
  tokens.set(id, token)
}

/**
 * Ends the identity a turn registered, and only that one.
 *
 * Two turns of the same agent share its id: an old turn that ends after a new
 * one started must not take the new turn's token away with it.
 */
export function unregisterSender(id: string, token: string): void {
  if (tokens.get(id) === token) tokens.delete(id)
}

/** The token a registered background sender proves itself with, if any. */
export function senderToken(id: string): string | undefined {
  return tokens.get(id)
}

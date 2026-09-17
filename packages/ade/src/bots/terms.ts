/**
 * What the providers' terms ask of ADE when it runs their CLIs (S13).
 *
 * ADE starts the official Claude Code and Codex CLIs the user installed and
 * signed in to, with that user's own plan. The terms that allow it
 * (`ade-team/results/master-D7-termini.md`) set the conditions kept here:
 *
 * - credentials stay with the CLIs: ADE never reads or carries them (a test
 *   holds the source to that);
 * - a turn starts from something the user did, and only a few run at once;
 * - when a plan's limit is reached the turn ends there, and ADE never retries
 *   or switches account to get around it;
 * - the user is told, where bots are set up, whose account pays and on which terms.
 */

/** Runners that spend the user's Anthropic or ChatGPT plan, rather than keys the user gave nikcli. */
export const PLAN_RUNNERS: readonly string[] = ["claude", "codex"]

/** How many turns on one plan may run at the same time. */
export const MAX_PARALLEL_TURNS = 3

export const TERMS_NOTICE =
  "ADE avvia la CLI ufficiale installata sul tuo computer, con l'account con cui vi hai fatto l'accesso, e non vede le tue credenziali. " +
  "L'abbonamento è per uso personale e consuma i limiti del tuo piano: per automazioni intensive o non presidiate usa una chiave API nella CLI."

const running = new Map<string, number>()

/**
 * A place for one more turn on `runnerId`'s plan, or why there is none.
 *
 * The release function gives the place back; calling it twice does nothing.
 * Runners not on a plan always get one.
 */
export function acquireTurn(runnerId: string, label = runnerId): { release: () => void } | { problem: string } {
  if (!PLAN_RUNNERS.includes(runnerId)) return { release: () => {} }
  const now = running.get(runnerId) ?? 0
  if (now >= MAX_PARALLEL_TURNS) {
    return {
      problem: `Già ${now} turni di ${label} in corso: ADE ne tiene al massimo ${MAX_PARALLEL_TURNS} insieme sul tuo abbonamento. Riprova quando uno finisce.`,
    }
  }
  running.set(runnerId, now + 1)
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      running.set(runnerId, Math.max(0, (running.get(runnerId) ?? 1) - 1))
    },
  }
}

/** Turns on `runnerId`'s plan running now. */
export function turnsRunning(runnerId: string): number {
  return running.get(runnerId) ?? 0
}

const LIMIT = /usage limit|rate limit|limit reached|hit your limit|limit will reset|quota exceeded|out of (?:extra )?usage|too many requests|\b429\b/i

/** Whether a CLI's error says the plan's limit was reached. */
export function limitReached(text: string): boolean {
  return LIMIT.test(text)
}

export function limitNotice(label: string): string {
  return `${label} ha raggiunto il limite del tuo piano. ADE non riprova e non cambia account: attendi il reset indicato dalla CLI oppure usa una chiave API.`
}

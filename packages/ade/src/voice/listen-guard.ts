/**
 * When always-on listening pauses and comes back by itself.
 *
 * Listening pauses on a PC nobody can be talking to — locked, or asleep —
 * and comes back on its own at the unlock. Nothing announces a lock to the
 * page, so it asks every few seconds; a sleep shows up as a tick that arrives
 * far later than it should, and after one the microphone stream may be dead,
 * so it is opened again.
 *
 * ADE hidden in the tray closes always-on listening (G11 review, M1): nobody
 * is looking at the window, so ADE does not keep a microphone open in it by
 * itself, and listening comes back when the window does. It is not a lock,
 * though: a microphone the user opened from the tray, with the system-wide
 * dictation chord, stays open. That chord is the only way to dictate while
 * ADE is in the tray, and the guard used to close it within five seconds.
 *
 * What it does not bring back is listening that stopped itself to stop
 * spending — the cap on requests an hour, or half an hour with nobody calling
 * it. That is `isHalted`, and only the user lifts it; without it the two
 * brakes were a five-second pause in the same bill.
 */

import { every, pageHidden } from "../host/every"

export const LOCK_POLL_MS = 5_000
/** A gap between ticks this much longer than the poll means the PC was asleep. */
export const SLEEP_GAP_MS = 30_000

export interface ListenGuardDeps {
  now(): number
  /** Whether the session is locked; a check that fails counts as locked. */
  isLocked(): Promise<boolean>
  /** Whether ADE's window is hidden in the tray (G11). */
  isHidden?(): boolean
  /** Whether the open microphone is a dictation, which only the user opens. */
  isDictating?(): boolean
  /** Whether a tap left the microphone open until the next one: nobody is holding it. */
  isLatched?(): boolean
  /** Whether ADE should be listening by itself, from the settings. */
  shouldListen(): boolean
  /** Whether any microphone is open, dictation included. */
  isListening(): boolean
  isPaused(): boolean
  /** Whether listening stopped itself and must stay stopped: see the top of this file. */
  isHalted(): boolean
  pause(): Promise<void>
  resume(): Promise<void>
  restart(): Promise<void>
}

export function createListenGuard(deps: ListenGuardDeps) {
  let last = deps.now()
  return {
    async tick(): Promise<void> {
      const at = deps.now()
      const slept = at - last > SLEEP_GAP_MS
      last = at
      /* Nothing is open and nothing should be: there is no state a lock could
         change, so the question is not asked. It is a call into the OS session,
         and with the voice off there is nothing to win by making it twelve
         times a minute. A microphone that is open still asks, so a lock closes
         the dictation too, and a voice the user wants listening still asks, so
         the unlock is not missed. */
      if (!deps.isListening() && (!deps.shouldListen() || deps.isHalted())) return
      /* Nobody can be talking to a locked PC: whatever is open closes, the
         dictation too, whether or not it listens by itself. A check that
         cannot answer is taken as a lock — an open microphone is the costly
         mistake. */
      const locked = await deps.isLocked().catch(() => true)
      if (locked) {
        if (deps.isListening()) await deps.pause()
        return
      }
      /* In the tray only what listens by itself closes, and a dictation left
         open by a tap: nobody is holding that one, and in a window nobody
         sees it could be forgotten. A microphone open with listening switched
         off, or a dictation held on its chord, was opened by the user after
         the window went away. */
      if (deps.isHidden?.() === true) {
        const opened = (!deps.shouldListen() || deps.isDictating?.() === true) && deps.isLatched?.() !== true
        if (deps.isListening() && !opened) await deps.pause()
        return
      }
      if (!deps.shouldListen() || deps.isHalted()) return
      if (slept && deps.isListening()) {
        await deps.restart()
        return
      }
      if (deps.isPaused()) await deps.resume()
    },
  }
}

/**
 * Starts the guard on a timer, and returns what stops it.
 *
 * Its own function because a hidden window must not stop it: `every` pauses a
 * hidden page by default, which is right for a poll that only feeds the screen
 * and wrong here. Listening that stays on does not stop when the window is
 * hidden — talking to ADE while working in another window is the whole point of
 * it — and Chromium on Windows marks the page hidden when the screen locks, so
 * the pause could stop the guard exactly when the lock is what it must notice.
 * A minimised ADE on a locked PC would then keep the microphone open.
 *
 * The pace does not change, hidden or not, because the guard is what decides
 * whether there is anything to ask: with the voice off and nothing open it asks
 * nothing at all, and `every` still waits for the previous tick.
 */
export function pollListenGuard(
  guard: { tick: () => Promise<void> },
  isHidden: () => boolean = pageHidden,
  ms: number = LOCK_POLL_MS,
): () => void {
  return every(ms, () => guard.tick(), { whenHidden: ms, isHidden })
}

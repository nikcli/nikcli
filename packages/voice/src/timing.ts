/**
 * Where a spoken turn spends its time, for whoever is measuring it.
 *
 * A harness creates `globalThis.__adeVoiceTimeline` (an array) and reads it
 * back; without it every mark is a no-op. Wall-clock times, so they line up
 * with what the harness itself records.
 */

type Timeline = Array<{ at: number; mark: string; detail?: string }>

export function markVoice(mark: string, detail?: string): void {
  const timeline = (globalThis as { __adeVoiceTimeline?: Timeline }).__adeVoiceTimeline
  if (!Array.isArray(timeline)) return
  timeline.push({ at: Date.now(), mark, ...(detail ? { detail } : {}) })
}

import { wavEnvelope, type PlaybackMeter } from "@nikcli-ai/voice/core"

/**
 * Plays one WAV the voice host synthesised, on the chosen output device.
 *
 * An `<audio>` element rather than an AudioContext: it takes the WAV as it is,
 * and `setSinkId` puts it on the output the user picked in the voice settings,
 * which Web Speech could never honour. For the same reason the agent's orb
 * reads the voice's loudness from the WAV itself (`meter`), at the element's
 * current time, rather than from an analyser in the audio path.
 */
/**
 * Rejects when the sound could not be played at all — a WAV the element will
 * not decode, a `play()` the webview refuses — so the speaker can say the
 * sentence in the system voice instead of skipping it without a sound.
 */
export function playWav(wav: ArrayBuffer, signal: AbortSignal, outputDeviceId?: string, meter?: PlaybackMeter): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  const envelope = meter ? wavEnvelope(wav) : undefined
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }))
  const audio = new Audio(url)
  return new Promise<void>((resolve, reject) => {
    let untrack: (() => void) | undefined
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      untrack?.()
      audio.pause()
      audio.removeAttribute("src")
      URL.revokeObjectURL(url)
      signal.removeEventListener("abort", done)
      if (error && !signal.aborted) reject(error instanceof Error ? error : new Error("Riproduzione della voce non riuscita."))
      else resolve()
    }
    const done = () => finish()
    const failed = (error?: unknown) => finish(error ?? new Error("Riproduzione della voce non riuscita."))
    audio.addEventListener("ended", done, { once: true })
    audio.addEventListener("error", () => failed(), { once: true })
    signal.addEventListener("abort", done, { once: true })
    const sink = outputDeviceId && "setSinkId" in audio
      ? (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(outputDeviceId).catch(() => {})
      : Promise.resolve()
    void sink.then(() => {
      if (signal.aborted) return
      if (meter && envelope) untrack = meter.track(envelope, () => audio.currentTime)
      return audio.play().catch(failed)
    })
  })
}

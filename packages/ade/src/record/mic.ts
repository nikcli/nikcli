/**
 * The microphone as a track of its own, recorded by the webview (S36).
 *
 * `MediaRecorder` on the input the user already picked for the assistant, so
 * a take hears the same microphone the voice commands do. ADE's own page is
 * granted the microphone without a prompt (`lib.rs`), which is what lets a
 * take start with one click instead of a dialog in the first second of the
 * video.
 */

import type { MicTake } from "./recorder"

/** The container the webview can write, Opus in WebM first. */
function pickMime(): { mimeType: string; extension: string } | undefined {
  if (typeof MediaRecorder === "undefined") return undefined
  const candidates = [
    { mimeType: "audio/webm;codecs=opus", extension: "webm" },
    { mimeType: "audio/webm", extension: "webm" },
    { mimeType: "audio/mp4", extension: "m4a" },
  ]
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate.mimeType))
}

export async function startMicTake(deviceId?: string): Promise<MicTake | undefined> {
  const mime = pickMime()
  if (!mime || !navigator.mediaDevices?.getUserMedia) return undefined
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // A voice-over wants the voice, not the fan behind it.
      noiseSuppression: true,
      echoCancellation: true,
    },
  })
  const recorder = new MediaRecorder(stream, { mimeType: mime.mimeType, audioBitsPerSecond: 128_000 })
  const chunks: Blob[] = []
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  })
  // Chunks every second, so a take that ends abruptly still has its audio.
  recorder.start(1000)

  return {
    extension: mime.extension,
    stop: () =>
      new Promise<Uint8Array | undefined>((resolve) => {
        const finish = async () => {
          for (const track of stream.getTracks()) track.stop()
          if (chunks.length === 0) return resolve(undefined)
          const blob = new Blob(chunks, { type: mime.mimeType })
          resolve(new Uint8Array(await blob.arrayBuffer()))
        }
        if (recorder.state === "inactive") return void finish()
        recorder.addEventListener("stop", () => void finish(), { once: true })
        recorder.stop()
      }),
  }
}

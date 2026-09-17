/**
 * The browser side of a take: what ADE knows and the capture does not.
 *
 * The platform writes the pixels; this writes everything a promo cut needs
 * afterwards, each in a file of its own beside the video:
 *
 * - `<nome>.events.jsonl`: pointer, clicks, panes, commands, what was said;
 * - `<nome>.voce.wav`: the assistant's voice, from the clips ADE synthesised;
 * - `<nome>.microfono.webm`: the microphone, when the user allowed it.
 *
 * Separate tracks rather than a mix, because an editor wants to lower the
 * microphone under the voice-over, not undo a mix made for them. Nothing is
 * drawn onto the frames either: zoom and click highlights are a decision taken
 * at export (`zoom.ts`), and a take can be re-cut without filming it again.
 *
 * Kept out of `workbench.tsx` because it is the part with rules: one take at a
 * time, and what was collected is written even when the capture fails to
 * close.
 */

import {
  bitrateFor,
  createEventLog,
  qualityLevel,
  recordingName,
  startProblem,
  type QualityLevel,
  type RecordEvent,
  type RecordState,
  type RecordTarget,
} from "./recording"
import { buildVoiceTrack, type VoiceClip } from "./wav"
import { locale, translate, type Locale } from "../i18n"

/** A microphone being recorded; `stop` hands back the file's bytes. */
export interface MicTake {
  readonly extension: string
  stop(): Promise<Uint8Array | undefined>
}

export interface RecorderDeps {
  /** The platform capture: `host.recordStart` and friends. */
  start: (
    target: RecordTarget,
    dir: string,
    name: string,
    quality: { fps: number; width?: number; height?: number; bitrate: number },
  ) => Promise<{ path: string | null }>
  stop: () => Promise<{ path: string | null }>
  /** Writes the events file beside the video. */
  writeText: (path: string, text: string) => Promise<void>
  /** Writes an audio track beside the video. */
  writeBytes?: (path: string, bytes: Uint8Array) => Promise<void>
  /** Starts recording the microphone; undefined when it is off or refused. */
  startMic?: () => Promise<MicTake | undefined>
  /** The page's geometry at the start, for the `frame` event. */
  frame?: (target: RecordTarget) => Omit<Extract<RecordEvent, { kind: "frame" }>, "kind" | "at">
  /** The folder the user chose; undefined asks the caller to pick one. */
  dir: () => string | undefined
  /** The level chosen in the panel; the heaviest when absent. */
  quality?: () => QualityLevel
  now: () => number
  onState: (state: RecordState) => void
}

export interface StartOptions {
  /**
   * Records the microphone too. Off unless asked, take by take: a take an
   * agent started must not also be a recording of the room.
   */
  readonly mic?: boolean
  /**
   * The language of the reasons returned. An agent reads them, so its
   * requests fix one like every other text for agents; the UI omits it.
   */
  readonly language?: Locale
}

export interface Recorder {
  start(target: RecordTarget, options?: StartOptions): Promise<string | undefined>
  stop(language?: Locale): Promise<string | undefined>
  /** Notes something worth keeping: ignored when nothing is being recorded. */
  note(event: RecordEvent): void
  /** Keeps a sentence the assistant is about to say, for the voice track. */
  noteVoice(wav: ArrayBuffer, text?: string): void
  state(): RecordState
}

const stem = (video: string) => video.replace(/\.mp4$/i, "")

/** The events file sits beside the video, same name. */
export function eventsPathFor(video: string): string {
  return `${stem(video)}.events.jsonl`
}

export function voicePathFor(video: string): string {
  return `${stem(video)}.voce.wav`
}

export function micPathFor(video: string, extension: string): string {
  return `${stem(video)}.microfono.${extension}`
}

export function createRecorder(deps: RecorderDeps): Recorder {
  let state: RecordState = { status: "idle" }
  let log: ReturnType<typeof createEventLog> | undefined
  let voice: VoiceClip[] = []
  let mic: MicTake | undefined

  const settle = (next: RecordState) => {
    state = next
    deps.onState(state)
  }

  /** Everything collected during the take, written beside `video`. */
  const writeTracks = async (video: string, startedAt: number, events: string, clips: VoiceClip[], micTake?: MicTake) => {
    const problems: string[] = []
    if (events) await deps.writeText(eventsPathFor(video), events).catch((error) => problems.push(String(error)))
    const track = buildVoiceTrack(clips, deps.now() - startedAt)
    if (track && deps.writeBytes) {
      await deps.writeBytes(voicePathFor(video), new Uint8Array(track.wav)).catch((error) => problems.push(String(error)))
    }
    if (micTake && deps.writeBytes) {
      const bytes = await micTake.stop().catch(() => undefined)
      if (bytes && bytes.length > 0) {
        await deps.writeBytes(micPathFor(video, micTake.extension), bytes).catch((error) => problems.push(String(error)))
      }
    }
    return problems
  }

  return {
    async start(target, options = {}) {
      const language = options.language ?? locale()
      const problem = startProblem(state, language)
      if (problem) return problem
      const dir = deps.dir()
      if (!dir) return translate(language, "record.chooseFolder")

      const startedAt = deps.now()
      const name = recordingName(startedAt)
      try {
        const level = deps.quality?.() ?? qualityLevel(undefined)
        const started = await deps.start(target, dir, name, {
          fps: level.fps,
          bitrate: bitrateFor(level),
          ...(level.width ? { width: level.width } : {}),
          ...(level.height ? { height: level.height } : {}),
        })
        log = createEventLog(startedAt)
        voice = []
        const frame = deps.frame?.(target)
        if (frame) log.add({ kind: "frame", at: startedAt, ...frame })
        // The microphone is extra: a refusal records the take without it.
        mic = options.mic ? await deps.startMic?.().catch(() => undefined) : undefined
        settle({
          status: "recording",
          recording: { target, path: started.path ?? `${dir}/${name}.mp4`, startedAt, mic: mic !== undefined },
        })
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },

    async stop(language = locale()) {
      if (state.status !== "recording") return undefined
      const { recording } = state
      const events = log?.text() ?? ""
      const clips = voice
      const micTake = mic
      log = undefined
      voice = []
      mic = undefined
      settle({ status: "stopping", recording })
      try {
        const stopped = await deps.stop()
        const problems = await writeTracks(stopped.path ?? recording.path, recording.startedAt, events, clips, micTake)
        settle({ status: "idle" })
        return problems.length > 0 ? translate(language, "record.partial", problems.join("; ")) : undefined
      } catch (error) {
        // The video may still be on disk: what was collected goes next to it anyway.
        await writeTracks(recording.path, recording.startedAt, events, clips, micTake).catch(() => {})
        settle({ status: "idle" })
        return error instanceof Error ? error.message : String(error)
      }
    },

    note(event) {
      if (state.status !== "recording") return
      log?.add(event)
    },

    noteVoice(wav, text) {
      if (state.status !== "recording") return
      const at = deps.now()
      voice.push({ at: at - state.recording.startedAt, wav })
      if (text) log?.add({ kind: "said", at, text })
    },

    state() {
      return state
    },
  }
}

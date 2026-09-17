import { locale, translate, type Locale } from "../i18n"
/**
 * Recording a video of ADE in use (S36).
 *
 * The video is captured by the operating system — Windows.Graphics.Capture,
 * ScreenCaptureKit, PipeWire — and is only ever what the window showed. What
 * makes it a usable promo video is the second half, here: while the capture
 * runs, ADE writes down where the pointer was, when it was clicked, which pane
 * had focus and which command ran. Zoom and click highlights are drawn from
 * that afterwards, at export, so nothing is burned into the frames and a take
 * can be re-cut without recording it again.
 *
 * The decisions are pure and tested here; the platform side owns only the
 * pixels.
 */

/**
 * What the capture covers. A pane is a rectangle inside the same window.
 *
 * The rectangle travels with the target because only ADE knows where a pane
 * is: the capture is given a window and a crop, never a second capture.
 */
export type RecordTarget =
  | { readonly kind: "window" }
  | {
      readonly kind: "pane"
      readonly paneId: string
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }

export type RecordEvent =
  /**
   * Written first: how the page's CSS pixels map onto the captured frame.
   * `crop*` are set for a pane take, in physical pixels of the window.
   */
  | {
      readonly kind: "frame"
      readonly at: number
      readonly width: number
      readonly height: number
      readonly dpr: number
      readonly cropX?: number
      readonly cropY?: number
      readonly cropWidth?: number
      readonly cropHeight?: number
    }
  /** Where the pointer was, in window coordinates. */
  | { readonly kind: "pointer"; readonly at: number; readonly x: number; readonly y: number }
  | {
      readonly kind: "click"
      readonly at: number
      readonly x: number
      readonly y: number
      readonly button: "left" | "right" | "middle"
    }
  /** The pane that took focus: the export zooms to it. */
  | { readonly kind: "pane"; readonly at: number; readonly paneId: string }
  /** A command the user ran, by id, so the export can caption it. */
  | { readonly kind: "command"; readonly at: number; readonly id: string }
  /** Said by the assistant, for subtitles on the voice track. */
  | { readonly kind: "said"; readonly at: number; readonly text: string }

export interface Recording {
  readonly target: RecordTarget
  /** Where the video and its events are written, without extension. */
  readonly path: string
  readonly startedAt: number
  /** The microphone is being recorded too: the badge says so. */
  readonly mic?: boolean
}

/** What the platform side answers: it knows the file, not why a take was made. */
export interface RecordingState {
  readonly recording: boolean
  readonly path: string | null
  /** The window is minimised, so the capture is getting no frames. */
  readonly minimized?: boolean
}

export type RecordState =
  | { readonly status: "idle" }
  | { readonly status: "recording"; readonly recording: Recording }
  /** The capture is closing its file: a new one cannot start yet. */
  | { readonly status: "stopping"; readonly recording: Recording }

/**
 * Pointer positions are worth keeping at about the frame rate, no more.
 *
 * A mouse reports far more often than 60 Hz, and every extra sample is a line
 * in the events file that the export averages away anyway.
 */
export const POINTER_MIN_GAP_MS = 16

/** Clicks and pane changes are never dropped; only pointer moves are thinned. */
export function keepEvent(previous: RecordEvent | undefined, next: RecordEvent): boolean {
  if (next.kind !== "pointer") return true
  if (!previous || previous.kind !== "pointer") return true
  if (next.at - previous.at >= POINTER_MIN_GAP_MS) return true
  return false
}

/**
 * The file's base name: the date, so takes of the same session sort in order.
 *
 * Local time, because it is named after the moment the user recorded it, not
 * after UTC.
 */
export function recordingName(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, "0")
  return `ADE ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`
}

/** One event per line, so a long take streams to disk instead of being held. */
export function eventLine(event: RecordEvent, startedAt: number): string {
  return JSON.stringify({ ...event, at: Math.max(0, Math.round(event.at - startedAt)) })
}

export function parseEventLine(line: string): RecordEvent | undefined {
  try {
    const parsed = JSON.parse(line) as RecordEvent
    return typeof parsed?.kind === "string" && typeof parsed?.at === "number" ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Collects what happens during a take, thinning the pointer as it goes. */
export function createEventLog(startedAt: number) {
  const lines: string[] = []
  let last: RecordEvent | undefined
  return {
    add(event: RecordEvent): boolean {
      if (!keepEvent(last, event)) return false
      last = event
      lines.push(eventLine(event, startedAt))
      return true
    },
    /** What is written next to the video, as JSON lines. */
    text(): string {
      return lines.length > 0 ? `${lines.join("\n")}\n` : ""
    },
    get length(): number {
      return lines.length
    },
  }
}

/** What the user is told when a take cannot start; an agent asking gets it in `language`. */
export function startProblem(state: RecordState, language: Locale = locale()): string | undefined {
  if (state.status === "recording") return translate(language, "record.busy")
  if (state.status === "stopping") return translate(language, "record.closingPrevious")
  return undefined
}

/**
 * How heavy a take is (S36, misure di agy in `results/agy-S36-misure.md`).
 *
 * Measured on a real minute with software H.264, so the numbers are what the
 * user's disk actually sees rather than the bitrate we ask for. The default is
 * the heaviest on purpose: these videos are made to be watched by someone
 * deciding whether to try ADE, and text that smears while a pane scrolls is
 * the one thing a promo cannot have.
 */
export type RecordQuality = "alta" | "media" | "leggera"

export interface QualityLevel {
  readonly id: RecordQuality
  readonly label: string
  /** Undefined keeps the window's own size. */
  readonly width?: number
  readonly height?: number
  readonly fps: number
  /**
   * Bits a second, fixed rather than left to the encoder.
   *
   * Left free, the hardware encoder on this machine wrote 165 MB a minute —
   * two and a half times the label. Pinned, software and hardware produce the
   * same size, and the only difference is the CPU it costs.
   */
  readonly bitrate: number
  /** Megabytes a minute, measured at that rate, for the line beside the choice. */
  readonly megabytesPerMinute: number
}

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { id: "alta", label: "Alta — schermo intero, 60 fps", fps: 60, bitrate: 8_000_000, megabytesPerMinute: 66 },
  { id: "media", label: "Media — schermo intero, 30 fps", fps: 30, bitrate: 5_000_000, megabytesPerMinute: 43 },
  {
    id: "leggera",
    label: "Leggera — 1280×800, 30 fps",
    width: 1280,
    height: 800,
    fps: 30,
    bitrate: 2_500_000,
    megabytesPerMinute: 21.5,
  },
]

/**
 * The rate the encoder is given for a level.
 *
 * The first live take left it at 20 Mbit/s against a label saying 66 MB a
 * minute and wrote 150; measured again with the hardware encoder at its own
 * choosing, 165. These three rates are the measured ones, so what the user
 * reads is what the file weighs, whichever encoder Windows picks.
 */
export function bitrateFor(level: QualityLevel): number {
  return level.bitrate
}

export const DEFAULT_QUALITY: RecordQuality = "alta"

export function qualityLevel(id: RecordQuality | undefined): QualityLevel {
  return QUALITY_LEVELS.find((level) => level.id === id) ?? QUALITY_LEVELS[0]!
}

/** "circa 66 MB al minuto", as it is written beside the choice. */
export function sizePerMinute(level: QualityLevel): string {
  const rounded = Number.isInteger(level.megabytesPerMinute)
    ? String(level.megabytesPerMinute)
    : level.megabytesPerMinute.toFixed(1).replace(".", ",")
  return `circa ${rounded} MB al minuto`
}

/** What a take of `seconds` will weigh, for a warning before a long one. */
export function estimatedMegabytes(level: QualityLevel, seconds: number): number {
  return Math.round((level.megabytesPerMinute * seconds) / 60)
}

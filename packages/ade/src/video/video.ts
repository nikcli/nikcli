/**
 * The video panel's decisions, apart from the element that plays the file.
 *
 * The panel exists so what a session just built can be watched next to it —
 * a recorded run, a render, a screen capture of the app — and so the agent
 * that built it can watch too: the panel's verbs are driven over the text
 * protocol in `panels/protocol.ts`, which means every one of them is a
 * function that has to say exactly what it did, in words, on one line.
 *
 * That is why the timecode parsing and the seek arithmetic are here and not
 * in the component: they are what the agent's reply is built from, they are
 * where an off-by-one is invisible, and a `.tsx` cannot be imported under
 * `bun test` in this repo.
 */

/**
 * What the panel offers to open.
 *
 * The containers a WebView2 will actually play, which is a shorter list than
 * the ones a project might contain: an `.mkv` or an `.avi` in the tree is
 * better refused with a reason than opened into a black rectangle.
 */
export const PLAYABLE_EXTENSIONS = ["mp4", "m4v", "webm", "ogv", "ogg", "mov"] as const

/** True when this path is something the panel can be asked to play. */
export function isPlayable(path: string): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(path.trim())
  if (!match) return false
  const extension = match[1]!.toLowerCase()
  return PLAYABLE_EXTENSIONS.some((known) => known === extension)
}

/**
 * Reads a time the way a person or an agent would write one.
 *
 * `12`, `12.5`, `1:03`, `01:02:03.25` — and nothing else. Returns seconds,
 * or `undefined` when the text is not a time at all, which the caller turns
 * into an error the agent can read rather than a silent seek to zero.
 */
export function parseTimecode(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(trimmed)) return undefined

  const parts = trimmed.split(":")
  if (parts.length > 3) return undefined

  let seconds = 0
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isFinite(value)) return undefined
    seconds = seconds * 60 + value
  }
  // A minutes or seconds field above 59 is a typo, not a time: `1:75` almost
  // certainly meant `1:15` or `75`, and guessing which is worse than asking.
  if (parts.length > 1 && parts.slice(1).some((part) => Number(part) >= 60)) return undefined
  return seconds
}

/**
 * The URL a `<video>` element can be given for a file on disk.
 *
 * Must match `url_for` in `src-tauri/src/media.rs`, which is the other half
 * of this: a scheme of ADE's own, answering range requests, confined to the
 * project roots the window has opened. Encoded the same way — everything but
 * the unreserved set and the separator, so a path with a space or an accent
 * survives.
 *
 * Kept here rather than in the component because a wrong encoding produces a
 * silent 404 in a media element, which shows as a player that never starts.
 */
export const MEDIA_SCHEME = "ade-media"

/**
 * WebView2 (Windows) answers custom schemes only as `http://<scheme>.localhost`;
 * the `<scheme>://localhost` form fails there with a format error.
 */
const isWindowsWebview = () => typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)

export function mediaUrl(path: string, windows = isWindowsWebview()): string {
  const encoded = [...new TextEncoder().encode(path.replace(/\\/g, "/"))]
    .map((byte) => {
      const character = String.fromCharCode(byte)
      return /[A-Za-z0-9\-_.~/]/.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")
  return windows ? `http://${MEDIA_SCHEME}.localhost/${encoded}` : `${MEDIA_SCHEME}://localhost/${encoded}`
}

/**
 * Seconds as `m:ss` or `h:mm:ss`, with tenths.
 *
 * The same string the panel shows and the agent is told, so the two cannot
 * disagree about where the video is.
 */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0"
  const whole = Math.floor(seconds)
  const tenths = Math.floor((seconds - whole) * 10)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60

  const body = hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
  return `${body}.${tenths}`
}

function pad(value: number): string {
  return value.toString().padStart(2, "0")
}

/**
 * Where a seek actually lands.
 *
 * Clamped, because a video element silently ignores a seek past its end and
 * the agent would be told it had moved somewhere it had not. Reporting the
 * clamped value is the difference between "ok — a 30,0 s" and a lie.
 */
export function clampSeek(target: number, duration: number): number {
  if (!Number.isFinite(target)) return 0
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, target)
  return Math.min(Math.max(target, 0), duration)
}

/**
 * Playback rates the panel will accept.
 *
 * Bounded at both ends: below this the element stops emitting audio and
 * above it most builds drop frames, so a rate outside the range is a request
 * that would appear to work and would not.
 */
export const MIN_RATE = 0.25
export const MAX_RATE = 4

export function parseRate(text: string): number | undefined {
  const value = Number(text.trim().replace(",", "."))
  if (!Number.isFinite(value)) return undefined
  if (value < MIN_RATE || value > MAX_RATE) return undefined
  return value
}

/**
 * The name a captured frame is saved under.
 *
 * The time is in the filename because the whole point of the capture is
 * *which* frame it was, and a directory of `frame-1.png` answers that only
 * for whoever was watching. Sortable, and safe on Windows, where `:` is not
 * a filename character.
 */
export function frameFileName(source: string, seconds: number): string {
  const base = (source.split(/[\\/]/).pop() ?? "video").replace(/\.[^.]+$/, "")
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "video"
  const stamp = formatTimecode(seconds).replace(/[:.]/g, "-")
  return `${safe}-${stamp}.png`
}

/**
 * How the panel describes itself to the agent, and to the user.
 *
 * One list, used for both: the verbs the component implements are the verbs
 * the agent is told about, so the two cannot drift into a protocol that
 * documents something nobody handles.
 */
export const VIDEO_VERBS = [
  { name: "open", usage: "open <percorso>", summary: "apre un file video del progetto" },
  { name: "play", usage: "play", summary: "avvia la riproduzione" },
  { name: "pause", usage: "pause", summary: "mette in pausa" },
  { name: "seek", usage: "seek <tempo>", summary: "salta a un istante, es. 1:03 oppure 12.5" },
  { name: "step", usage: "step <secondi>", summary: "avanza o torna indietro, es. -0.5" },
  { name: "rate", usage: "rate <fattore>", summary: `velocità fra ${MIN_RATE} e ${MAX_RATE}` },
  { name: "capture", usage: "capture", summary: "cattura il fotogramma corrente e ne dà il percorso" },
  { name: "state", usage: "state", summary: "dice file, posizione, durata e se è in riproduzione" },
] as const

/** The panel's state, in the words the agent is answered with. */
export interface VideoState {
  readonly source?: string
  readonly playing: boolean
  readonly position: number
  readonly duration: number
  readonly rate: number
}

export function describeState(state: VideoState): string {
  if (!state.source) return "nessun video aperto"
  const where = `${formatTimecode(state.position)} di ${formatTimecode(state.duration)}`
  const how = state.playing ? "in riproduzione" : "in pausa"
  const speed = state.rate === 1 ? "" : ` a ${state.rate}×`
  return `${state.source} — ${where}, ${how}${speed}`
}

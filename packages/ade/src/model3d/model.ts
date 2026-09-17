/**
 * The 3D panel's decisions, apart from the scene that draws the model.
 *
 * The panel exists for the same reason the video one does: what a session
 * just produced — an exported asset, a generated mesh, a scene a game is
 * about to load — can be looked at next to it, and looked at again the moment
 * the file changes. And the agent that produced it can drive the panel over
 * the text protocol in `panels/protocol.ts`, so every verb answers in one
 * true sentence.
 *
 * What lives here is what can be wrong without a screenshot showing it: which
 * files are models, which other files a model needs, how a relative URI in a
 * `.gltf` resolves on Windows, when a change on disk means "reload", and where
 * the camera has to stand to see the whole thing. `three` is not imported
 * here: this module is loaded by the workbench on every start and by
 * `bun test`, and the renderer is loaded only when a panel opens.
 */

/**
 * What the panel offers to open.
 *
 * glTF first because it is what real-time pipelines export today and the only
 * format whose materials come through unambiguously. OBJ and STL because they
 * are what CAD, printing and quick generators write; FBX because game assets
 * still arrive in it, with the caveat that only its embedded textures load.
 */
export const MODEL_EXTENSIONS = ["glb", "gltf", "obj", "stl", "fbx"] as const

export type ModelFormat = (typeof MODEL_EXTENSIONS)[number]

/** The format of a path, from its extension; `undefined` when it is not a model. */
export function modelFormat(path: string): ModelFormat | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(path.trim())
  if (!match) return undefined
  const extension = match[1]!.toLowerCase()
  return MODEL_EXTENSIONS.find((known) => known === extension)
}

/** True when this path is something the panel can be asked to show. */
export function isModel(path: string): boolean {
  return modelFormat(path) !== undefined
}

/**
 * How big a model file may be before the panel refuses to read it.
 *
 * The file crosses the IPC boundary whole, and a scene larger than this is
 * one a webview would struggle to hold in GPU memory anyway: refusing with
 * the size in the message beats a window that stops answering.
 */
export const MAX_MODEL_BYTES = 256 * 1024 * 1024

/** The directory part of a path, keeping the separator style it came with. */
export function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return cut < 0 ? "" : path.slice(0, cut)
}

/**
 * Where a URI written inside a model file points on disk.
 *
 * `undefined` for what must not be read from disk: an inline `data:` URI
 * (the loader decodes it itself), a URL with a scheme, and an absolute path —
 * a model that names `C:\Users\someone\texture.png` is naming a file on the
 * machine it was exported on, and following it would let a downloaded asset
 * make the panel read wherever it liked. Relative segments are resolved here,
 * so `../textures/a.png` cannot climb out without it being visible to the
 * host's own confinement check.
 */
export function resolveResource(modelPath: string, uri: string): string | undefined {
  const trimmed = uri.trim()
  if (trimmed.length === 0) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined // data:, http:, C: …
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return undefined

  let decoded = trimmed
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    // A stray `%` in a filename: the URI was not encoded, use it as written.
  }

  const separator = modelPath.includes("\\") && !modelPath.includes("/") ? "\\" : "/"
  const parts = directoryOf(modelPath).split(/[\\/]/)
  for (const segment of decoded.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      // Never above the drive or the filesystem root.
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join(separator)
}

/**
 * The external files a `.gltf` names: its buffers and its images.
 *
 * Returned as the URIs exactly as written, because that is the string the
 * loader will ask for and the key it has to be answered under. A file that is
 * not JSON yields nothing, and the loader then says what is wrong with it.
 */
export function gltfResources(text: string): string[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  if (!json || typeof json !== "object") return []
  const record = json as { buffers?: unknown; images?: unknown }
  const uris: string[] = []
  for (const list of [record.buffers, record.images]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const uri = item && typeof item === "object" ? (item as { uri?: unknown }).uri : undefined
      if (typeof uri === "string" && !uri.startsWith("data:") && !uris.includes(uri)) uris.push(uri)
    }
  }
  return uris
}

/** The material libraries an `.obj` names with `mtllib`. */
export function objMaterialLibraries(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*mtllib\s+(.+?)\s*$/.exec(line)
    if (match && !names.includes(match[1]!)) names.push(match[1]!)
  }
  return names
}

/**
 * The textures an `.mtl` names.
 *
 * The file name is the last token: map statements may carry options before
 * it (`map_Kd -s 1 1 1 wood.png`), and a name with spaces in it is rare
 * enough in exported assets that the options are the case worth handling.
 */
export function mtlTextures(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(map_\w+|bump|disp|decal|norm)\s+(.+?)\s*$/i.exec(line)
    if (!match) continue
    const name = match[2]!.split(/\s+/).pop()!
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** One entry of a directory listing, as much of it as the stamp needs. */
export interface StampEntry {
  readonly path: string
  readonly size: number
  readonly modified_ms: number
}

/**
 * A string that changes when any of the watched files changes.
 *
 * Size and modification time, not content: the panel asks for a listing every
 * couple of seconds, and hashing a 40 MB scene to learn that nothing happened
 * would cost more than drawing it. A file that is missing contributes a mark
 * of its own, so a model deleted and written back — which is how most
 * exporters save — reads as two changes, not zero.
 */
export function changeStamp(entries: readonly StampEntry[], watched: readonly string[]): string {
  const byPath = new Map(entries.map((entry) => [normalizePath(entry.path), entry]))
  return watched
    .map((path) => {
      const entry = byPath.get(normalizePath(path))
      return entry ? `${entry.size}:${Math.round(entry.modified_ms)}` : "-"
    })
    .join("|")
}

/** Slashes one way and case folded, which is how Windows compares paths. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase()
}

/**
 * How long a change has to stay put before the panel reloads.
 *
 * An exporter writes a large file in several passes; reloading on the first
 * change would parse half a file and show an error for a moment. The stamp
 * has to read the same on two consecutive polls.
 */
export const WATCH_INTERVAL_MS = 1500

export interface ReloadDecision {
  /** The stamp to remember for the next poll. */
  readonly pending: string | undefined
  readonly reload: boolean
}

/**
 * Whether a poll that read `next` should reload the model.
 *
 * `loaded` is the stamp of what is on screen, `pending` a different stamp seen
 * on the previous poll. A reload happens only when a change has held still
 * for a whole interval, and never for a file that is currently missing.
 */
/**
 * The files to stamp before loading `path`: what the last load of the same
 * file read, so a texture saved during the load counts; just the file for
 * one not loaded before.
 */
export function filesToStamp(path: string, framed: string, watched: readonly string[]): readonly string[] {
  return path === framed && watched.length > 0 ? watched : [path]
}

export function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((file) => set.has(file))
}

/** The reason a load overtaken by a later one gives; not an error to show. */
export const SUPERSEDED = "caricamento superato da uno più recente"

export function isSuperseded(failure: unknown): boolean {
  return failure instanceof Error && failure.message === SUPERSEDED
}

export function decideReload(loaded: string, pending: string | undefined, next: string): ReloadDecision {
  if (next === loaded) return { pending: undefined, reload: false }
  if (next.split("|")[0] === "-") return { pending: undefined, reload: false }
  if (next === pending) return { pending: undefined, reload: true }
  return { pending: next, reload: false }
}

/**
 * Where the camera stands to see a sphere of `radius` whole.
 *
 * The vertical field of view is what three.js takes; on a pane narrower than
 * it is tall the horizontal one is the tighter, and ignoring it is how a
 * model ends up cut off at both sides of a portrait pane. A margin keeps the
 * silhouette off the edges.
 */
export function frameDistance(radius: number, fovDegrees: number, aspect: number, margin = 1.15): number {
  if (!Number.isFinite(radius) || radius <= 0) return 5
  const vertical = (fovDegrees * Math.PI) / 180
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(aspect, 1e-3))
  const tightest = Math.min(vertical, horizontal)
  return (radius * margin) / Math.sin(tightest / 2)
}

/** The directions the camera can be put in, looking at the model's centre. */
export const VIEW_PRESETS = {
  iso: [1, 0.8, 1],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  // A hair off the axis: looking straight down Y makes OrbitControls' up
  // vector degenerate, and the model would spin under the first drag.
  top: [0, 1, 0.0001],
  bottom: [0, -1, 0.0001],
} as const satisfies Record<string, readonly [number, number, number]>

export type ViewPreset = keyof typeof VIEW_PRESETS

export function parseView(text: string): ViewPreset | undefined {
  const key = text.trim().toLowerCase()
  const aliases: Record<string, ViewPreset> = {
    fronte: "front",
    retro: "back",
    sinistra: "left",
    destra: "right",
    sopra: "top",
    sotto: "bottom",
    iso: "iso",
    isometrica: "iso",
  }
  if (key in VIEW_PRESETS) return key as ViewPreset
  return aliases[key]
}

/** The unit vector for a preset. */
export function viewDirection(preset: ViewPreset): [number, number, number] {
  const [x, y, z] = VIEW_PRESETS[preset]
  const length = Math.hypot(x, y, z)
  return [x / length, y / length, z / length]
}

/** What the scene reports about what it loaded. */
export interface ModelStats {
  readonly meshes: number
  readonly triangles: number
  /** Bounding box size along x, y, z, in the model's own units. */
  readonly size: readonly [number, number, number]
  readonly animations: number
}

export interface ModelState {
  readonly source?: string
  readonly loading: boolean
  readonly error?: string
  readonly stats?: ModelStats
}

/** A number the way an agent and a person both read it: short, with a comma. */
export function formatMeasure(value: number): string {
  if (!Number.isFinite(value)) return "?"
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3
  return value.toFixed(digits).replace(".", ",")
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("it-IT")
}

export function describeModelState(state: ModelState): string {
  if (!state.source) return "nessun modello aperto"
  if (state.loading) return `${state.source} — in caricamento`
  if (state.error) return `${state.source} — errore: ${state.error}`
  const stats = state.stats
  if (!stats) return state.source
  const [x, y, z] = stats.size
  const parts = [
    `${formatCount(stats.meshes)} mesh`,
    `${formatCount(stats.triangles)} triangoli`,
    `ingombro ${formatMeasure(x)} × ${formatMeasure(y)} × ${formatMeasure(z)}`,
  ]
  if (stats.animations > 0) parts.push(`${stats.animations} animazioni`)
  return `${state.source} — ${parts.join(", ")}`
}

/**
 * The name a captured view is saved under. Sortable, and safe on Windows.
 */
export function viewFileName(source: string, now: Date): string {
  const base = (source.split(/[\\/]/).pop() ?? "modello").replace(/\.[^.]+$/, "")
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "modello"
  const pad = (value: number) => value.toString().padStart(2, "0")
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${safe}-${stamp}.png`
}

/** The panel's verbs, for the agent's greeting and for the handler. */
export const MODEL_VERBS = [
  { name: "open", usage: "open <percorso>", summary: `apre un modello 3D del progetto (${MODEL_EXTENSIONS.join(", ")})` },
  { name: "view", usage: "view <vista>", summary: `inquadra da ${Object.keys(VIEW_PRESETS).join(", ")}` },
  { name: "reload", usage: "reload", summary: "rilegge il file dal disco" },
  { name: "capture", usage: "capture", summary: "salva la vista corrente come PNG e ne dà il percorso" },
  { name: "state", usage: "state", summary: "dice file, mesh, triangoli e ingombro" },
] as const

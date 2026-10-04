/**
 * The wire contract between a gadget and the nikcli gadgets bridge.
 *
 * This file is the whole protocol: the bridge (the nikcli plugin) and every
 * device SDK import it, so a change here is a change on both ends at once.
 * It is plain JSON over HTTP, with one server-sent-events stream per device
 * for what the bridge pushes. No binary framing, no custom transport: an
 * ESP32 with an HTTP client speaks it, and so does `curl`.
 *
 * Specified in `specs/effect-tui/21-gadgets-device-bridge.md`.
 */

export const PROTOCOL_VERSION = 1 as const

export const LIMITS = {
  /** A file chunk (`file.read`, `file.write`) is at most this large. */
  CHUNK_BYTES: 64 * 1024,
  /** What a command may return unless its spec says otherwise. */
  DEFAULT_OUTPUT_BYTES: 256 * 1024,
  /** The ceiling a spec may raise `maxOutputBytes` to. */
  MAX_OUTPUT_BYTES: 4 * 1024 * 1024,
  /** A command's deadline unless its spec says otherwise. */
  DEFAULT_TIMEOUT_MS: 30_000,
  /** The ceiling a spec may raise `timeoutMs` to. */
  MAX_TIMEOUT_MS: 600_000,
  /** Invocations waiting behind the one in flight, per device. */
  QUEUE_DEPTH: 8,
  /** Messages a device may push into sessions per minute. */
  MESSAGE_RATE_PER_MIN: 60,
  /** How long a pairing window stays open. */
  PAIR_WINDOW_MS: 10 * 60_000,
  /** How often the bridge pings an idle feed. */
  PING_INTERVAL_MS: 15_000,
  /** Frames a feed may fall behind before the bridge evicts it. */
  FEED_LAG_FRAMES: 256,
  /** The largest request body the bridge reads. */
  MAX_BODY_BYTES: 4 * 1024 * 1024 + 256 * 1024,
  /** Drawing bounds — the same the nikcli mod surface enforces. */
  TREE_MAX_DEPTH: 16,
  /** A Box's `gap` and `padding`, in cells: layout work grows with them. */
  TREE_MAX_SPACING: 16,
  TREE_MAX_NODES: 2_000,
  TREE_MAX_TEXT: 10_000,
  /** Commands a hello may declare. */
  MAX_COMMANDS: 64,
} as const

// ---------------------------------------------------------------------------
// Declarations

/** A JSON Schema object describing a command's arguments. */
export type JsonSchema = { readonly type: "object"; readonly [key: string]: unknown }

export interface CommandSpec {
  /** `namespace.name`, lowercase: `system.run`, `ha.toggle`. */
  readonly name: string
  readonly description: string
  readonly args: JsonSchema
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

export interface DisplaySpec {
  /** Character cells the device can show. For a `bitmap` display the bridge derives them from the pixels. */
  readonly columns: number
  readonly rows: number
  /** Bits per pixel the panel has — informational. */
  readonly depth: 1 | 2 | 8
  /**
   * What the bridge sends. `tree` is a drawing tree the device lays out itself; `bitmap` is a finished 1-bit image
   * the bridge rendered for `width × height` pixels, for a panel with no layout engine (an e-paper board, a
   * microcontroller).
   */
  readonly format: "tree" | "bitmap"
  /** Pixels. Required when `format` is `bitmap`. */
  readonly width?: number
  readonly height?: number
  /** Glyph magnification for a `bitmap` display, 1 to 8. Default 1. */
  readonly scale?: number
}

/** The 5×7 font plus one pixel of spacing: the cell a character occupies at scale 1. */
export const CELL_WIDTH = 6
export const CELL_HEIGHT = 8

/** A rendered frame: 1 bit per pixel, rows padded to whole bytes, most significant bit first, 1 = ink. */
export interface BitmapFrame {
  readonly width: number
  readonly height: number
  readonly format: "1bpp"
  /** Base64 of the packed rows. */
  readonly data: string
}

export interface Platform {
  readonly os: string
  readonly arch: string
  /** A stable machine identifier when the platform has one. */
  readonly machine?: string
}

/** What a device sends on every connect. Replaces the previous declaration whole. */
export interface Hello {
  readonly protocol: typeof PROTOCOL_VERSION
  readonly name: string
  readonly version: string
  readonly platform: Platform
  readonly commands: readonly CommandSpec[]
  readonly display?: DisplaySpec
  /** Button keys the device can press: `ok`, `next`, … */
  readonly buttons?: readonly string[]
  /** Whether the device records audio for push-to-talk. */
  readonly audio?: boolean
  /**
   * The largest frame, in bytes of JSON, the device can read. The bridge refuses to send a bigger `invoke`, `show` or
   * `message` (`PayloadTooLarge`) instead of sending what the device would drop, which would leave the call to time out.
   * Absent means no limit worth stating.
   */
  readonly maxFrameBytes?: number
}

// ---------------------------------------------------------------------------
// Pairing

export interface PairRequest {
  readonly code: string
  readonly name: string
  readonly platform: Platform
  /** Stable per-device identity the token is bound to. */
  readonly fingerprint: string
  /** The device has a button and will confirm pairing by pressing it. */
  readonly button: boolean
  readonly version?: string
}

export interface PairResponse {
  readonly id: string
  readonly token: string
  /** True when the device must `POST /pair/confirm` before hello is accepted. */
  readonly confirm: boolean
}

// ---------------------------------------------------------------------------
// Frames the bridge pushes on `GET /devices/:id/commands`

export type Frame =
  | { readonly type: "hello"; readonly id: string; readonly time: number }
  | {
      readonly type: "invoke"
      readonly callID: string
      readonly command: string
      readonly args: Record<string, unknown>
      /**
       * How long the device has, from receiving this frame. Relative on purpose: the bridge's clock and the
       * device's are not the same clock, and a Pi with no battery-backed RTC can be hours off before NTP.
       */
      readonly timeoutMs: number
    }
  | {
      readonly type: "show"
      readonly frameID: string
      readonly tree: Tree
      readonly viewport: { readonly columns: number; readonly rows: number }
    }
  | { readonly type: "show"; readonly frameID: string; readonly bitmap: BitmapFrame }
  | { readonly type: "message"; readonly text: string; readonly sessionID?: string }
  | { readonly type: "ping"; readonly time: number }
  | { readonly type: "bye"; readonly reason: string }

// ---------------------------------------------------------------------------
// What a device posts back

export interface ResultBody {
  readonly callID: string
  readonly output: string
  readonly exitCode?: number
  readonly isError?: boolean
  /** The device cut the output at its spec's `maxOutputBytes`. */
  readonly truncated?: boolean
}

export interface DeviceEvent {
  readonly kind: "press" | "input"
  readonly key: string
  readonly value?: string
}

export interface MessageBody {
  readonly text: string
  /** Continue this session; absent starts one titled after the device. */
  readonly sessionID?: string
}

export interface MessageResponse {
  readonly sessionID: string
}

// ---------------------------------------------------------------------------
// What the operator (the nikcli tool, the TUI) sees

export interface HealthInfo {
  readonly uptimeSec: number
  readonly load: readonly [number, number, number]
  readonly memory: { readonly totalBytes: number; readonly freeBytes: number }
  readonly disk?: { readonly totalBytes: number; readonly freeBytes: number; readonly path: string }
  readonly temperatureC?: number
  readonly time: number
}

export interface GadgetInfo {
  readonly id: string
  readonly name: string
  readonly online: boolean
  readonly confirmed: boolean
  readonly platform: Platform
  readonly version?: string
  readonly commands: readonly CommandSpec[]
  readonly display?: DisplaySpec
  readonly buttons?: readonly string[]
  readonly audio?: boolean
  readonly createdAt: number
  readonly lastSeen?: number
}

export interface InvokeRequest {
  readonly command: string
  readonly args?: Record<string, unknown>
  readonly timeoutMs?: number
}

export interface InvokeResult {
  readonly callID: string
  readonly output: string
  readonly exitCode?: number
  readonly isError: boolean
  readonly truncated: boolean
  readonly durationMs: number
}

export interface PairWindow {
  readonly code: string
  readonly expiresAt: number
  readonly url: string
}

// ---------------------------------------------------------------------------
// Failures

export type GadgetErrorName =
  | "NotPaired"
  | "HelloInvalid"
  | "Offline"
  | "Busy"
  | "Timeout"
  | "CommandUnknown"
  | "Denied"
  | "PayloadTooLarge"
  | "RateLimited"
  | "TokenRevoked"
  | "PairingClosed"
  | "Unconfirmed"
  | "BadRequest"

export const ERROR_STATUS: Readonly<Record<GadgetErrorName, number>> = {
  NotPaired: 404,
  HelloInvalid: 400,
  Offline: 503,
  Busy: 429,
  Timeout: 504,
  CommandUnknown: 404,
  Denied: 403,
  PayloadTooLarge: 413,
  RateLimited: 429,
  TokenRevoked: 401,
  PairingClosed: 410,
  Unconfirmed: 409,
  BadRequest: 400,
}

/** The one error shape both ends throw and serialize. `name` is `GadgetError.<tag>`. */
export class GadgetError extends Error {
  override readonly name: `GadgetError.${GadgetErrorName}`
  readonly tag: GadgetErrorName
  readonly status: number
  readonly retryAfterMs?: number

  constructor(tag: GadgetErrorName, message: string, options?: { retryAfterMs?: number }) {
    super(message)
    this.tag = tag
    this.name = `GadgetError.${tag}`
    this.status = ERROR_STATUS[tag]
    this.retryAfterMs = options?.retryAfterMs
  }

  toJSON() {
    return { error: { name: this.name, tag: this.tag, message: this.message, retryAfterMs: this.retryAfterMs } }
  }

  /** Rebuild from a bridge response body; `undefined` when the body is not one of ours. */
  static fromBody(body: unknown): GadgetError | undefined {
    if (typeof body !== "object" || body === null) return undefined
    const error = (body as { error?: unknown }).error
    if (typeof error !== "object" || error === null) return undefined
    const { tag, message, retryAfterMs } = error as { tag?: unknown; message?: unknown; retryAfterMs?: unknown }
    if (typeof tag !== "string" || !(tag in ERROR_STATUS)) return undefined
    return new GadgetError(tag as GadgetErrorName, typeof message === "string" ? message : tag, {
      retryAfterMs: typeof retryAfterMs === "number" ? retryAfterMs : undefined,
    })
  }
}

// ---------------------------------------------------------------------------
// Drawing: plain data, the subset of nikcli's mod trees a panel can lay out.

export type TreeNode = Tree | string | number | false | null | undefined

export type Tree =
  | {
      readonly type: "Box"
      readonly key?: string
      readonly props: {
        readonly direction?: "row" | "column"
        readonly gap?: number
        readonly padding?: number
        readonly borderStyle?: "single" | "double" | "round" | "bold"
        readonly justifyContent?: "flex-start" | "center" | "flex-end" | "space-between"
      }
      readonly children: readonly TreeNode[]
    }
  | {
      readonly type: "Text"
      readonly key?: string
      readonly props: { readonly bold?: boolean; readonly dimColor?: boolean; readonly inverse?: boolean }
      readonly children: readonly TreeNode[]
    }
  | { readonly type: "Button"; readonly key: string; readonly props: { readonly label: string } }
  | { readonly type: "Markdown"; readonly key?: string; readonly props: { readonly text: string } }
  | { readonly type: "Code"; readonly props: { readonly text: string; readonly language?: string } }

const TREE_TYPES = new Set(["Box", "Text", "Button", "Markdown", "Code"])

/**
 * Check a tree against the limits before it crosses the wire. Returns the
 * reason it fails, or `undefined` when it is drawable in bounded time.
 */
export function treeProblem(tree: unknown): string | undefined {
  let nodes = 0
  let text = 0
  const walk = (node: unknown, depth: number): string | undefined => {
    if (node === null || node === undefined || node === false) return
    if (typeof node === "string" || typeof node === "number") {
      text += String(node).length
      if (text > LIMITS.TREE_MAX_TEXT) return `more than ${LIMITS.TREE_MAX_TEXT} characters of text`
      return
    }
    if (typeof node !== "object") return `unexpected ${typeof node} in tree`
    if (depth > LIMITS.TREE_MAX_DEPTH) return `deeper than ${LIMITS.TREE_MAX_DEPTH}`
    if (++nodes > LIMITS.TREE_MAX_NODES) return `more than ${LIMITS.TREE_MAX_NODES} nodes`
    const element = node as { type?: unknown; props?: unknown; children?: unknown; key?: unknown }
    if (typeof element.type !== "string" || !TREE_TYPES.has(element.type))
      return `unknown node type ${String(element.type)}`
    if (element.props !== undefined && (typeof element.props !== "object" || element.props === null))
      return "props must be an object"
    const props = (element.props ?? {}) as Record<string, unknown>
    if (element.type === "Box") {
      for (const name of ["gap", "padding"] as const) {
        const value = props[name]
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LIMITS.TREE_MAX_SPACING)
        ) {
          return `Box ${name} must be a whole number from 0 to ${LIMITS.TREE_MAX_SPACING}`
        }
      }
    }
    if (element.type === "Button") {
      if (typeof element.key !== "string" || !element.key) return "Button needs a key"
      if (typeof props.label !== "string") return "Button needs a label"
      text += props.label.length
    }
    if (element.type === "Markdown" || element.type === "Code") {
      if (typeof props.text !== "string") return `${element.type} needs text`
      text += props.text.length
      if (text > LIMITS.TREE_MAX_TEXT) return `more than ${LIMITS.TREE_MAX_TEXT} characters of text`
    }
    if (element.children !== undefined) {
      if (!Array.isArray(element.children)) return "children must be an array"
      for (const child of element.children) {
        const problem = walk(child, depth + 1)
        if (problem) return problem
      }
    }
    return
  }
  return walk(tree, 1)
}

// ---------------------------------------------------------------------------
// Validation the bridge runs on a hello, exposed so the SDK can run it first.

const COMMAND_NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/
const BUTTON_KEY = /^[a-z][a-z0-9_-]{0,31}$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

export function isCommandName(value: string): boolean {
  return COMMAND_NAME.test(value)
}

/** Turn a device name into the id its routes, tokens and permissions key on. */
/** `s` without leading and trailing dashes. A loop: an anchored alternation over a name from outside is quadratic on a run of dashes. */
function trimDashes(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && s[start] === "-") start++
  while (end > start && s[end - 1] === "-") end--
  return s.slice(start, end)
}

export function slugify(name: string): string {
  const dashed = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  const slug = trimDashes(dashed).slice(0, 63)
  return SLUG.test(slug) ? slug : "gadget"
}

function fail(reason: string): never {
  throw new GadgetError("HelloInvalid", reason)
}

/** Parse a hello. Throws `GadgetError.HelloInvalid` naming the first problem; never loads a valid subset. */
export function parseHello(value: unknown): Hello {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("hello must be an object")
  const raw = value as Record<string, unknown>
  if (raw.protocol !== PROTOCOL_VERSION)
    fail(`protocol must be ${PROTOCOL_VERSION}, got ${JSON.stringify(raw.protocol)}`)
  if (typeof raw.name !== "string" || !raw.name.trim()) fail("name must be a non-empty string")
  if (typeof raw.version !== "string") fail("version must be a string")
  const platform = raw.platform
  if (typeof platform !== "object" || platform === null) fail("platform must be an object")
  const { os, arch, machine } = platform as Record<string, unknown>
  if (typeof os !== "string" || typeof arch !== "string") fail("platform.os and platform.arch must be strings")
  if (machine !== undefined && typeof machine !== "string") fail("platform.machine must be a string")
  if (!Array.isArray(raw.commands)) fail("commands must be an array")
  if (raw.commands.length > LIMITS.MAX_COMMANDS) fail(`more than ${LIMITS.MAX_COMMANDS} commands`)
  const seen = new Set<string>()
  const commands: CommandSpec[] = raw.commands.map((item, index) => {
    if (typeof item !== "object" || item === null) fail(`commands[${index}] must be an object`)
    const spec = item as Record<string, unknown>
    if (typeof spec.name !== "string" || !isCommandName(spec.name)) {
      fail(`commands[${index}].name must look like "namespace.name", got ${JSON.stringify(spec.name)}`)
    }
    if (seen.has(spec.name)) fail(`command ${spec.name} declared twice`)
    seen.add(spec.name)
    if (typeof spec.description !== "string" || !spec.description.trim())
      fail(`command ${spec.name} needs a description`)
    const args = spec.args
    if (typeof args !== "object" || args === null || (args as { type?: unknown }).type !== "object") {
      fail(`command ${spec.name} args must be a JSON Schema object with type "object"`)
    }
    const timeoutMs = spec.timeoutMs
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" || timeoutMs <= 0 || timeoutMs > LIMITS.MAX_TIMEOUT_MS)
    ) {
      fail(`command ${spec.name} timeoutMs must be between 1 and ${LIMITS.MAX_TIMEOUT_MS}`)
    }
    const maxOutputBytes = spec.maxOutputBytes
    if (
      maxOutputBytes !== undefined &&
      (typeof maxOutputBytes !== "number" || maxOutputBytes <= 0 || maxOutputBytes > LIMITS.MAX_OUTPUT_BYTES)
    ) {
      fail(`command ${spec.name} maxOutputBytes must be between 1 and ${LIMITS.MAX_OUTPUT_BYTES}`)
    }
    return {
      name: spec.name,
      description: spec.description,
      args: args as JsonSchema,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    }
  })
  let display: DisplaySpec | undefined
  if (raw.display !== undefined) {
    if (typeof raw.display !== "object" || raw.display === null) fail("display must be an object")
    const { columns, rows, depth, format, width, height, scale } = raw.display as Record<string, unknown>
    if (depth !== 1 && depth !== 2 && depth !== 8) fail("display.depth must be 1, 2 or 8")
    if (format === "bitmap") {
      const whole = (value: unknown, min: number, max: number) =>
        typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      if (!whole(width, 8, 2048) || !whole(height, 8, 2048))
        fail("display.width and display.height must be whole pixels between 8 and 2048")
      if (scale !== undefined && !whole(scale, 1, 8)) fail("display.scale must be a whole number from 1 to 8")
      const magnification = (scale as number | undefined) ?? 1
      display = {
        columns: Math.max(1, Math.floor((width as number) / (CELL_WIDTH * magnification))),
        rows: Math.max(1, Math.floor((height as number) / (CELL_HEIGHT * magnification))),
        depth,
        format,
        width: width as number,
        height: height as number,
        ...(scale === undefined ? {} : { scale: scale as number }),
      }
    } else if (format === "tree") {
      if (
        typeof columns !== "number" ||
        typeof rows !== "number" ||
        columns < 1 ||
        rows < 1 ||
        columns > 512 ||
        rows > 256
      ) {
        fail("display.columns and display.rows must be between 1 and 512/256")
      }
      display = { columns: Math.floor(columns), rows: Math.floor(rows), depth, format }
    } else {
      fail('display.format must be "tree" or "bitmap"')
    }
  }
  let buttons: string[] | undefined
  if (raw.buttons !== undefined) {
    if (!Array.isArray(raw.buttons)) fail("buttons must be an array of keys")
    buttons = raw.buttons.map((key) => {
      if (typeof key !== "string" || !BUTTON_KEY.test(key))
        fail(`button key ${JSON.stringify(key)} is not a lowercase key`)
      return key
    })
  }
  if (raw.audio !== undefined && typeof raw.audio !== "boolean") fail("audio must be a boolean")
  const maxFrameBytes = raw.maxFrameBytes
  if (
    maxFrameBytes !== undefined &&
    (typeof maxFrameBytes !== "number" ||
      !Number.isInteger(maxFrameBytes) ||
      maxFrameBytes < 512 ||
      maxFrameBytes > LIMITS.MAX_BODY_BYTES)
  ) {
    fail(`maxFrameBytes must be a whole number from 512 to ${LIMITS.MAX_BODY_BYTES}`)
  }
  return {
    protocol: PROTOCOL_VERSION,
    name: raw.name.trim(),
    version: raw.version,
    platform: { os, arch, ...(machine === undefined ? {} : { machine }) },
    commands,
    ...(display === undefined ? {} : { display }),
    ...(buttons === undefined ? {} : { buttons }),
    ...(raw.audio === undefined ? {} : { audio: raw.audio as boolean }),
    ...(maxFrameBytes === undefined ? {} : { maxFrameBytes: maxFrameBytes as number }),
  }
}

/** Routes, in one place, so the SDK, the bridge and the firmware agree on paths. */
export const ROUTES = {
  info: "/",
  pair: "/pair",
  pairConfirm: "/pair/confirm",
  hello: (id: string) => `/devices/${encodeURIComponent(id)}/hello`,
  commands: (id: string) => `/devices/${encodeURIComponent(id)}/commands`,
  result: (id: string) => `/devices/${encodeURIComponent(id)}/result`,
  event: (id: string) => `/devices/${encodeURIComponent(id)}/event`,
  message: (id: string) => `/devices/${encodeURIComponent(id)}/message`,
  admin: {
    devices: "/admin/devices",
    pair: "/admin/pair",
    device: (id: string) => `/admin/devices/${encodeURIComponent(id)}`,
    message: (id: string) => `/admin/devices/${encodeURIComponent(id)}/message`,
    health: (id: string) => `/admin/devices/${encodeURIComponent(id)}/health`,
  },
} as const

/** The device-side token prefix. Hashed at rest on the bridge; an identifier for the device, never a user. */
export const TOKEN_PREFIX = "nkg_"

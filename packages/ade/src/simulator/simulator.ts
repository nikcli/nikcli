/**
 * The app simulator's decisions, apart from the frame that draws the device.
 *
 * The browser pane already previews a page at a phone's width. The simulator
 * is for the app a project is building — a web app, a Tauri front end, an
 * Expo app on the web — seen the way it will be used: inside a phone with its
 * status bar and rounded corners, turned sideways, or in a desktop window the
 * user drags to the size that breaks the layout. And it knows where a project
 * usually serves itself, so opening one does not start with typing a port.
 *
 * Plain `.ts` for `bun test`: the geometry, the device list, the dev server
 * guess and the URL guard are what can be wrong without a screenshot showing
 * it.
 */

export type DeviceKind = "phone" | "tablet" | "window"

/** Where the camera or sensor sits, which decides what is drawn over the status bar. */
export type Cutout = "island" | "notch" | "punch" | "none"

export interface Device {
  readonly id: string
  readonly label: string
  readonly kind: DeviceKind
  /** CSS pixels in portrait: what the app's media queries see. */
  readonly width: number
  readonly height: number
  /** Corner radius of the screen, in CSS pixels. */
  readonly radius: number
  /** Bezel thickness around the screen, in CSS pixels. */
  readonly bezel: number
  readonly cutout: Cutout
  /** Height of the status bar the device draws over the top of the app. */
  readonly statusBar: number
}

/**
 * The devices offered, in CSS pixels as each one reports them to a page.
 *
 * Few on purpose: one current iPhone, one small iPhone, two Androids with
 * the widths most layouts break at, a tablet, and a desktop window. A list
 * of forty phones is a list nobody picks from.
 */
export const DEVICES: readonly Device[] = [
  {
    id: "iphone-15",
    label: "iPhone 15",
    kind: "phone",
    width: 393,
    height: 852,
    radius: 48,
    bezel: 12,
    cutout: "island",
    statusBar: 54,
  },
  {
    id: "iphone-se",
    label: "iPhone SE",
    kind: "phone",
    width: 375,
    height: 667,
    radius: 0,
    bezel: 14,
    cutout: "none",
    statusBar: 20,
  },
  {
    id: "pixel-8",
    label: "Pixel 8",
    kind: "phone",
    width: 412,
    height: 915,
    radius: 36,
    bezel: 11,
    cutout: "punch",
    statusBar: 36,
  },
  {
    id: "galaxy-s24",
    label: "Galaxy S24",
    kind: "phone",
    width: 360,
    height: 780,
    radius: 32,
    bezel: 10,
    cutout: "punch",
    statusBar: 32,
  },
  {
    id: "ipad-air",
    label: "iPad Air",
    kind: "tablet",
    width: 820,
    height: 1180,
    radius: 18,
    bezel: 20,
    cutout: "none",
    statusBar: 24,
  },
  {
    id: "window",
    label: "Finestra desktop",
    kind: "window",
    width: 1280,
    height: 800,
    radius: 8,
    bezel: 0,
    cutout: "none",
    statusBar: 0,
  },
]

export const DEFAULT_DEVICE_ID = "iphone-15"

export function deviceById(id: string | undefined): Device {
  return DEVICES.find((device) => device.id === id) ?? DEVICES.find((device) => device.id === DEFAULT_DEVICE_ID)!
}

/** Height of the title bar drawn above a desktop window's content. */
export const WINDOW_TITLE_BAR = 30

/** The smallest window a desktop app is expected to survive. */
export const MIN_WINDOW = { width: 320, height: 240 } as const
export const MAX_WINDOW = { width: 3840, height: 2160 } as const

/** A dragged window size, rounded and held inside what a desktop allows. */
export function clampWindowSize(width: number, height: number): { width: number; height: number } {
  const fit = (value: number, min: number, max: number) =>
    Math.round(Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)))
  return {
    width: fit(width, MIN_WINDOW.width, MAX_WINDOW.width),
    height: fit(height, MIN_WINDOW.height, MAX_WINDOW.height),
  }
}

export interface FrameInput {
  readonly device: Device
  readonly landscape: boolean
  /** The size of a desktop window, when the user has dragged one; ignored for phones. */
  readonly windowSize?: { width: number; height: number }
  readonly containerWidth: number
  readonly containerHeight: number
  /** Space kept free around the device, so it never touches the pane's edges. */
  readonly padding?: number
}

export interface FrameFit {
  /** The device's screen, unscaled: status bar and app together. */
  readonly screenWidth: number
  readonly screenHeight: number
  /** The strip at the top of the screen the device keeps for itself; 0 in landscape and for windows. */
  readonly statusBar: number
  /** The viewport the app renders at, unscaled: the screen minus the status bar. */
  readonly viewportWidth: number
  readonly viewportHeight: number
  /** The whole device — bezel or title bar included — unscaled. */
  readonly outerWidth: number
  readonly outerHeight: number
  /** Uniform scale to fit the pane, never above 1. */
  readonly scale: number
  /** What the scaled device occupies in the pane's layout. */
  readonly renderedWidth: number
  readonly renderedHeight: number
}

/**
 * Where the device goes in the pane, and how small it has to be.
 *
 * Never scaled above 1: a phone blown up to fill a 4K pane shows a layout no
 * phone will ever show, and text that looks fine only because it is huge.
 * Rotation swaps the screen — the app gets a landscape viewport, not a
 * picture of a portrait one turned sideways — and drops the status bar, as
 * phones do in landscape.
 *
 * The status bar is a strip above the app rather than drawn over it: a frame
 * cannot tell a page what its safe-area insets are, so an app that draws
 * under a status bar here would be hidden behind one that is not there on
 * the device, or the other way round. Reporting the viewport without it is
 * the arrangement a page can trust.
 */
export function fitFrame(input: FrameInput): FrameFit {
  const { device } = input
  const base =
    device.kind === "window" && input.windowSize
      ? clampWindowSize(input.windowSize.width, input.windowSize.height)
      : device
  const rotate = input.landscape && device.kind !== "window"
  const screenWidth = rotate ? base.height : base.width
  const screenHeight = rotate ? base.width : base.height
  const statusBar = rotate ? 0 : device.statusBar

  const outerWidth = screenWidth + device.bezel * 2
  const outerHeight = screenHeight + device.bezel * 2 + (device.kind === "window" ? WINDOW_TITLE_BAR : 0)

  const padding = input.padding ?? 16
  const availableWidth = Math.max(0, input.containerWidth - padding * 2)
  const availableHeight = Math.max(0, input.containerHeight - padding * 2)
  const scale =
    availableWidth <= 0 || availableHeight <= 0
      ? 0
      : Math.min(1, availableWidth / outerWidth, availableHeight / outerHeight)

  return {
    screenWidth,
    screenHeight,
    statusBar,
    viewportWidth: screenWidth,
    viewportHeight: screenHeight - statusBar,
    outerWidth,
    outerHeight,
    scale,
    renderedWidth: Math.round(outerWidth * scale),
    renderedHeight: Math.round(outerHeight * scale),
  }
}

/* ── Where the app is served ─────────────────────────────────────────── */

export interface DevServerGuess {
  readonly label: string
  readonly url: string
  /** The command that starts it, when it came from a `package.json` script. */
  readonly command?: string
}

/** What the guess reads: the project's own config files, as text, when present. */
export interface ProjectConfig {
  readonly packageJson?: string
  /** `src-tauri/tauri.conf.json`. */
  readonly tauriConf?: string
  /** `app.json`, which marks an Expo project even when `expo` is a transitive dependency. */
  readonly appJson?: string
}

/** Default ports of the tools that start dev servers, first match wins. */
const TOOLS: readonly { pattern: RegExp; label: string; port: number }[] = [
  { pattern: /\bexpo\b/, label: "Expo (web)", port: 8081 },
  { pattern: /\bnext\b/, label: "Next.js", port: 3000 },
  { pattern: /\bnuxi?\b/, label: "Nuxt", port: 3000 },
  { pattern: /\bastro\b/, label: "Astro", port: 4321 },
  { pattern: /\bng\s+serve\b/, label: "Angular", port: 4200 },
  { pattern: /\breact-scripts\b/, label: "Create React App", port: 3000 },
  { pattern: /\bvite\b/, label: "Vite", port: 5173 },
  { pattern: /\bwebpack(-dev-server| serve)\b/, label: "webpack", port: 8080 },
]

/**
 * The dev servers a project probably runs, most likely first.
 *
 * A guess from the config, not a scan of open ports: listening sockets say
 * something is running, not that it is this project. Tauri's `devUrl` is
 * authoritative when it exists, because it is the URL the real app window
 * loads. A `--port` in the script beats the tool's default.
 */
export function guessDevServers(config: ProjectConfig): DevServerGuess[] {
  const guesses: DevServerGuess[] = []
  const add = (guess: DevServerGuess) => {
    if (!guesses.some((known) => known.url === guess.url)) guesses.push(guess)
  }

  const tauri = parseJson(config.tauriConf) as { build?: { devUrl?: unknown; devPath?: unknown } } | undefined
  const devUrl = tauri?.build?.devUrl ?? tauri?.build?.devPath
  if (typeof devUrl === "string" && /^https?:\/\//i.test(devUrl))
    add({ label: "Tauri (devUrl)", url: stripSlash(devUrl) })

  const pkg = parseJson(config.packageJson) as
    | { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown> }
    | undefined
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}
  const preferred = ["web", "dev", "start", "serve"]
  const names = Object.keys(scripts).sort((a, b) => rank(a, preferred) - rank(b, preferred))

  for (const name of names) {
    const script = scripts[name]
    if (typeof script !== "string" || !preferred.includes(name)) continue
    const tool = TOOLS.find((candidate) => candidate.pattern.test(script))
    if (!tool) continue
    const port = portIn(script) ?? tool.port
    add({ label: tool.label, url: `http://localhost:${port}`, command: `${name}` })
  }

  const isExpo =
    Boolean(parseJson(config.appJson) && (parseJson(config.appJson) as { expo?: unknown }).expo) ||
    Boolean(pkg?.dependencies?.expo)
  if (isExpo) add({ label: "Expo (web)", url: "http://localhost:8081", command: "web" })

  return guesses
}

function rank(name: string, preferred: readonly string[]): number {
  const index = preferred.indexOf(name)
  return index < 0 ? preferred.length : index
}

function portIn(script: string): number | undefined {
  const match = /(?:--port[= ]|-p\s+|PORT=)(\d{2,5})\b/.exec(script)
  if (!match) return undefined
  const port = Number(match[1])
  return port > 0 && port < 65536 ? port : undefined
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

/**
 * Reads what the user typed in the address field as a dev server URL.
 *
 * `5173`, `localhost:5173`, `192.168.1.20:8081/app` and full URLs all work;
 * only http and https are accepted. `undefined` for anything else, which the
 * panel says out loud instead of loading a blank frame.
 */
export function parseAppUrl(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  let candidate = trimmed
  if (/^\d{2,5}$/.test(candidate)) candidate = `localhost:${candidate}`
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `http://${candidate}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (!url.hostname) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/**
 * Whether a URL may be loaded in the simulator's frame.
 *
 * The frame is given `allow-same-origin`, because an app under development
 * needs its own storage, cookies and service worker to behave as it will on
 * a device. That is safe only while the app's origin is not ADE's own: a
 * same-origin frame with scripts could reach into the window that hosts it.
 * So ADE's origin is refused — which in development is the Vite server ADE
 * itself runs on.
 */
export function isLoadableAppUrl(url: string, hostOrigin: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    return parsed.origin !== hostOrigin
  } catch {
    return false
  }
}

/** How the panel describes what it shows, to the agent and in the footer. */
export interface SimulatorState {
  readonly url?: string
  readonly device: Device
  readonly landscape: boolean
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly reachable?: boolean
}

export function describeSimulator(state: SimulatorState): string {
  const size = `${state.viewportWidth}×${state.viewportHeight}`
  const orientation = state.device.kind === "window" ? "" : state.landscape ? ", orizzontale" : ", verticale"
  const where = state.url ?? "nessuna app aperta"
  const reach = state.reachable === false ? " — server non raggiungibile" : ""
  return `${where} su ${state.device.label} (${size}${orientation})${reach}`
}

export const SIMULATOR_VERBS = [
  {
    name: "open",
    usage: "open <url>",
    summary: "carica l'app servita dal dev server, es. 5173 o http://localhost:8081",
  },
  {
    name: "device",
    usage: "device <id>",
    summary: `cambia dispositivo: ${DEVICES.map((device) => device.id).join(", ")}`,
  },
  { name: "rotate", usage: "rotate", summary: "gira il telefono o il tablet" },
  { name: "size", usage: "size <larghezza>x<altezza>", summary: "ridimensiona la finestra desktop" },
  { name: "reload", usage: "reload", summary: "ricarica l'app" },
  { name: "state", usage: "state", summary: "dice URL, dispositivo e dimensioni" },
] as const

/** `1280x800`, `1280×800` or `1280 800`. */
export function parseSize(text: string): { width: number; height: number } | undefined {
  const match = /^\s*(\d{2,5})\s*[x×*, ]\s*(\d{2,5})\s*$/i.exec(text)
  if (!match) return undefined
  return clampWindowSize(Number(match[1]), Number(match[2]))
}

/**
 * One terminal per session, kept outside the view.
 *
 * A pane is not a stable place to keep a terminal: it is collapsed, expanded,
 * moved between columns and — until the pointer-down remount was fixed — thrown
 * away and rebuilt. The scrollback has to survive all of that, and output keeps
 * arriving while a pane is not on screen at all, so the emulator lives here and
 * the pane only borrows it.
 *
 * Nothing in this module knows about the pty. It receives text and hands back
 * keystrokes; whoever owns the process wires the two together.
 */
import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"

export interface SessionTerminal {
  terminal: Terminal
  fit: FitAddon
  /** Where it is currently drawn, if anywhere. */
  element?: HTMLElement
  detach?: () => void
}

const terminals = new Map<string, SessionTerminal>()

/*
 * The palette is read from ADE's own tokens rather than hardcoded, so a session
 * looks like it belongs to the window it is in. xterm needs concrete colours —
 * it cannot take a var() — so they are resolved at creation and again whenever
 * a terminal is attached to a pane.
 *
 * Resolved, not read. A custom property computes to the text it was declared
 * with, so `getPropertyValue("--ade-surface")` hands back
 * `light-dark(#faf9f8, #1a1818)`; xterm cannot parse that and quietly falls back
 * to its own white on black. Setting the token as a probe's `color` and reading
 * the computed value makes the browser pick the half for the scheme in effect.
 */
const ANSI_SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

type ColourSlot = Exclude<keyof ITheme, "extendedAnsi">

/**
 * Read from ADE's own root, which is where every token now lives.
 *
 * This used to take a `scope`, because the ANSI palette was declared inside
 * `[data-component="session-pane"]` — and both call sites passed nothing, so
 * the sixteen colours were never found and xterm kept its own defaults. The
 * palette moved to `:root` (see index.css) precisely so that there is one
 * place to read it from and no way to read it from the wrong one.
 *
 * The probe stays in the ADE shell rather than on `document.body`: `light-dark()`
 * resolves against the computed `color-scheme`, and the theme attribute is
 * stamped on ADE's own root, not on the document. Reading from outside the
 * shell would always return the dark half.
 */
function readTheme(): ITheme {
  if (typeof document === "undefined" || !document.body) return {}
  const host =
    document.querySelector('[data-component="ade-shell"]') ?? document.body
  const declared = getComputedStyle(host)
  const probe = document.createElement("span")
  probe.setAttribute("aria-hidden", "true")
  // Visible to the cascade, invisible to the user: `light-dark()` is resolved
  // from computed style, and an element kept in the box tree cannot be
  // short-circuited by an engine that skips work for `display: none`.
  probe.style.cssText =
    "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none"
  host.appendChild(probe)

  const theme: ITheme = { selectionBackground: "rgba(10, 124, 107, 0.25)" }
  // The first token declared in scope wins. A slot with none keeps xterm's
  // default, where an undeclared var() would hand the probe the text colour.
  const slot = (key: ColourSlot, ...tokens: string[]) => {
    const token = tokens.find((name) => declared.getPropertyValue(name).trim().length > 0)
    if (!token) return
    probe.style.color = `var(${token})`
    theme[key] = getComputedStyle(probe).color
  }
  slot("background", "--ade-terminal-bg", "--ade-sunken")
  slot("foreground", "--ade-terminal-fg", "--ade-text")
  slot("cursor", "--ade-accent")
  slot("selectionBackground", "--ade-selection")
  for (const name of ANSI_SLOTS) slot(name, `--ade-ansi-${name}`)

  probe.remove()
  return theme
}

/**
 * Repaints every live terminal in the theme now in effect.
 *
 * Terminals outlive the panes that draw them, and the panes are memoised so
 * that pressing one does not rebuild its DOM — which together mean nothing
 * remounts when the theme changes, and `attachTerminal` is the only place that
 * ever re-read the colours. Toggling the theme recoloured the whole window
 * except the part of it the user is actually reading, until the launch screen
 * happened to unmount the grid.
 */
export function refreshTerminalThemes(): void {
  if (terminals.size === 0) return
  const theme = readTheme()
  for (const session of terminals.values()) {
    session.terminal.options.theme = theme
  }
}

export function getTerminal(id: string): SessionTerminal {
  const existing = terminals.get(id)
  if (existing) return existing

  const terminal = new Terminal({
    /*
     * Scrollback is what makes a session reviewable after the fact. Agents are
     * verbose — a single tool call can be hundreds of lines — and the default
     * thousand would quietly eat the beginning of most runs. Five thousand keeps
     * a long run reviewable at half the memory of the ten thousand it was: the
     * buffer is held for every terminal, hidden panes included, and a full one
     * at wide columns ran to tens of megabytes each.
     */
    scrollback: 5_000,
    fontSize: 12,
    fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, ui-monospace, monospace",
    lineHeight: 1.25,
    // A visible block that stops blinking when the pane loses focus: with six
    // sessions tiled, a blinking cursor in each is a room full of distractions.
    cursorBlink: false,
    cursorStyle: "block",
    allowProposedApi: true,
    convertEol: false,
    theme: readTheme(),
  })

  const fit = new FitAddon()
  terminal.loadAddon(fit)

  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    // Allow voice shortcuts (Mod+Shift+J / Mod+Shift+K) to bypass xterm and bubble to window
    const isMod = event.ctrlKey || event.metaKey
    if (isMod && event.shiftKey) {
      const k = event.key.toLowerCase()
      if (k === "j" || k === "k" || event.code === "KeyJ" || event.code === "KeyK") {
        return false
      }
    }
    return true
  })

  const created: SessionTerminal = { terminal, fit }
  terminals.set(id, created)
  return created
}

export function hasTerminal(id: string): boolean {
  return terminals.has(id)
}

export function writeToTerminal(id: string, chunk: string): void {
  getTerminal(id).terminal.write(chunk)
}

/**
 * What moves a written screen into the scrollback and puts the cursor home.
 *
 * A process started in a pane begins at 1;1: that is what `pty.rs` tells
 * ConPTY, which asks before it lets the child speak. A pane reused by a
 * restart still shows the last run with the cursor somewhere below it, and the
 * new shell drew over it from the top. One newline per row, from wherever the
 * cursor is, scrolls every visible line out; nothing is erased.
 */
export function cleanScreenSequence(rows: number, written: boolean): string {
  return written ? "\r\n".repeat(Math.max(1, rows)) + "[H" : ""
}

/** Gives the next process in `id` an empty screen at 1;1, the old one kept in the scrollback. */
export function startOnCleanScreen(id: string): void {
  const session = terminals.get(id)
  if (!session) return
  const { terminal } = session
  const buffer = terminal.buffer.active
  const written = buffer.baseY > 0 || buffer.cursorY > 0 || buffer.cursorX > 0
  const sequence = cleanScreenSequence(terminal.rows, written)
  if (sequence) terminal.write(sequence)
}

/** Prints a line of ADE's own, marked so it cannot be mistaken for the agent. */
export function noteInTerminal(id: string, text: string): void {
  getTerminal(id).terminal.writeln(`\u001b[2m${text}\u001b[0m`)
}

export interface AttachOptions {
  /** Keystrokes the user typed, to be forwarded to the process. */
  onInput?: (data: string) => void
  /** The terminal's new size after a fit, in character cells. */
  onResize?: (cols: number, rows: number) => void
}

/**
 * How to get an emulator into the pane that is asking for it.
 *
 * `open()` builds xterm's DOM the first time and does nothing at all on any
 * later call — it returns early as soon as the terminal has an element, without
 * so much as looking at the parent it was handed. So only a terminal that has
 * never been drawn can be opened; one that has already been drawn has to be
 * moved by hand, or it stays inside the pane it was first drawn in and every
 * pane rebuilt after that comes back empty.
 *
 * Rebuilding is the common case, not the rare one: opening the launch screen
 * unmounts the whole grid, so every running session's pane is thrown away and
 * remade the moment another session starts.
 */
export function placementFor(drawn: { parentElement: unknown } | null | undefined, parent: unknown): "open" | "move" | "keep" {
  if (!drawn) return "open"
  return drawn.parentElement === parent ? "keep" : "move"
}

/**
 * Draws the terminal into `element` and keeps it fitted to it.
 *
 * Returns a detach function rather than disposing: the session is still running
 * and its scrollback still matters, so leaving a pane must cost nothing more
 * than the DOM it was drawn in.
 */
export function attachTerminal(id: string, element: HTMLElement, options: AttachOptions = {}): () => void {
  const session = getTerminal(id)
  session.detach?.()

  session.terminal.options.theme = readTheme()

  const drawn = session.terminal.element
  const placement = placementFor(drawn, element)
  if (placement === "open") {
    session.terminal.open(element)
  } else if (placement === "move" && drawn) {
    element.appendChild(drawn)
    // The rows travel with the element, but they were painted for a parent
    // that no longer holds them; without this the pane can come back blank
    // until the next byte arrives.
    try {
      session.terminal.refresh(0, session.terminal.rows - 1)
    } catch {
      /* a terminal with no rows yet has nothing to repaint */
    }
  }
  session.element = element

  const inputHandler = options.onInput ? session.terminal.onData(options.onInput) : undefined

  const applyFit = () => {
    // A pane can be zero-sized for a frame — collapsed, or mid-layout — and
    // fitting against that throws inside xterm's renderer.
    if (element.clientWidth < 2 || element.clientHeight < 2) return
    try {
      session.fit.fit()
    } catch {
      return
    }
    options.onResize?.(session.terminal.cols, session.terminal.rows)
  }

  const observer = new ResizeObserver(() => applyFit())
  observer.observe(element)
  applyFit()

  const detach = () => {
    observer.disconnect()
    inputHandler?.dispose()
    session.element = undefined
    session.detach = undefined
  }
  session.detach = detach
  return detach
}

/** Ends a terminal for good. Called when its pane closes, not when it hides. */
export function disposeTerminal(id: string): void {
  const session = terminals.get(id)
  if (!session) return
  session.detach?.()
  session.terminal.dispose()
  terminals.delete(id)
}

/**
 * Keyboard chord parsing, matching, formatting, and binding resolution.
 *
 * A chord is a single key combination: one principal key plus zero or more
 * modifiers (Ctrl/Cmd, Shift, Alt). Multi-chord sequences (Ctrl+K Ctrl+S)
 * are not modelled here — they belong to a higher-level input handler that
 * would consume individual chords as they arrive.
 *
 * The `mod` modifier abstracts the platform split: it maps to Cmd on macOS
 * and Ctrl everywhere else. The platform is always a parameter, never read
 * from the environment, so everything is testable without a DOM.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Platform = "mac" | "other"

export interface Chord {
  key: string // lowercase principal key, e.g. "p", "enter", "arrowup"
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/** Minimal keyboard event shape — just enough to match, no DOM dependency. */
export interface KeyInput {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export interface Binding {
  chord: Chord
  commandId: string
}

// ---------------------------------------------------------------------------
// Key names
// ---------------------------------------------------------------------------

/**
 * Spellings that mean the same physical key as the name they map to.
 *
 * `plus` is here because `+` is the separator: a chord string can never carry
 * the character itself, so the only way to bind it is by name.
 */
const KEY_ALIASES: Record<string, string> = {
  spacebar: "space",
  esc: "escape",
  return: "enter",
  del: "delete",
  ins: "insert",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  plus: "+",
  /*
   * The punctuation row, as `KeyboardEvent.code` and the global-hotkey crate
   * spell it. A chord recorded here stores what `event.key` gives — "," — and
   * the system reports the pressed hotkey as "Comma": without these the two
   * spellings never met, so a voice chord on a punctuation key registered with
   * the OS and was then thrown away every time it fired.
   */
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  backquote: "`",
  minus: "-",
  equal: "=",
  semicolon: ";",
  quote: "'",
  bracketleft: "[",
  bracketright: "]",
  controlleft: "control",
  controlright: "control",
  shiftleft: "shift",
  shiftright: "shift",
  altleft: "alt",
  altright: "alt",
  metaleft: "meta",
  metaright: "meta",
}

/**
 * Reduce any spelling of a key to the one this module compares on.
 *
 * Three vocabularies meet here and none of them agree. A chord is *written* by
 * a human ("space"), *stored* as text, and then compared against a live
 * `KeyboardEvent` — whose `key` for the space bar is a literal `" "`, a
 * character that cannot survive a `"+"`-separated chord string at all, and
 * whose `code` calls the letter row "KeyK" and the number row "Digit1".
 *
 * Without one spelling in the middle a chord recorded by pressing the space bar
 * is stored as "space" and then matches nothing, for ever, silently — which is
 * exactly what a rebindable shortcut must never do.
 */
export function normalizeKeyName(key: string): string {
  const lower = key.toLowerCase()
  // Checked before trimming: the space bar's own `event.key` is " ".
  if (lower === " ") return "space"

  const name = lower.trim()
  if (name.length === 0) return ""

  // `KeyboardEvent.code` spellings for the two rows that have one.
  const letter = /^key([a-z])$/.exec(name)
  if (letter) return letter[1]
  const digit = /^digit([0-9])$/.exec(name)
  if (digit) return digit[1]

  return KEY_ALIASES[name] ?? name
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a human-written chord string into a normalised `Chord`.
 *
 * Case-insensitive, order-insensitive. `mod` expands to `meta` on mac and
 * `ctrl` elsewhere. Examples:
 *
 *   parseChord("mod+shift+p", "mac")  → { key: "p", meta: true, shift: true, ... }
 *   parseChord("Ctrl+K", "other")     → { key: "k", ctrl: true, ... }
 */
export function parseChord(raw: string, platform: Platform): Chord {
  const parts = raw.includes("+")
    ? raw
        .toLowerCase()
        .split("+")
        .map((s) => s.trim())
        .filter(Boolean)
    : raw
        .toLowerCase()
        .split(/[\s-]+/)
        .map((s) => s.trim())
        .filter(Boolean)

  let ctrl = false
  let meta = false
  let shift = false
  let alt = false
  let key = ""

  for (const part of parts) {
    switch (part) {
      case "mod":
        if (platform === "mac") meta = true
        else ctrl = true
        break
      case "ctrl":
      case "control":
        ctrl = true
        break
      case "meta":
      case "cmd":
      case "command":
        meta = true
        break
      case "shift":
        shift = true
        break
      case "alt":
      case "option":
      case "opt":
        alt = true
        break
      default:
        // Last non-modifier part wins — allows "ctrl+shift+p" order
        key = normalizeKeyName(part)
    }
  }

  return { key, ctrl, meta, shift, alt }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * True when `chord` matches the given key input exactly.
 *
 * All four modifier flags must agree — a chord that specifies Ctrl without
 * Shift must not fire when Shift is held, because that might mean a different
 * binding.
 *
 * The event's key goes through `normalizeKeyName` for the same reason the
 * chord's did at parse time: both sides must be speaking the one vocabulary,
 * or a perfectly valid stored chord never fires.
 */
export function matchesChord(chord: Chord, event: KeyInput): boolean {
  return (
    normalizeKeyName(event.key) === chord.key &&
    event.ctrlKey === chord.ctrl &&
    event.metaKey === chord.meta &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt
  )
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a chord for display.
 *
 * macOS uses symbol glyphs (⌘⇧⌥⌃); other platforms use "Ctrl+Shift+Alt+".
 * The principal key is capitalised on both.
 */
export function formatChord(chord: Chord, platform: Platform): string {
  if (platform === "mac") {
    let s = ""
    if (chord.ctrl) s += "⌃"
    if (chord.alt) s += "⌥"
    if (chord.shift) s += "⇧"
    if (chord.meta) s += "⌘"
    s += prettifyKey(chord.key)
    return s
  }

  const parts: string[] = []
  if (chord.ctrl) parts.push("Ctrl")
  if (chord.alt) parts.push("Alt")
  if (chord.shift) parts.push("Shift")
  if (chord.meta) parts.push("Meta")
  parts.push(prettifyKey(chord.key))
  return parts.join("+")
}

/** Capitalise and prettify common key names for display. */
function prettifyKey(key: string): string {
  if (key.length === 1) return key.toUpperCase()
  // Named keys
  const map: Record<string, string> = {
    enter: "Enter",
    escape: "Esc",
    backspace: "Backspace",
    tab: "Tab",
    delete: "Delete",
    space: "Space",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
  }
  return map[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}

// ---------------------------------------------------------------------------
// Binding resolution
// ---------------------------------------------------------------------------

/**
 * Find the command id bound to this key event, if any.
 *
 * First match wins: bindings earlier in the array have higher priority. This
 * is intentional — it lets user overrides prepend the array and shadow defaults.
 */
export function resolveBinding(bindings: Binding[], event: KeyInput, platform: Platform): string | undefined {
  for (const b of bindings) {
    if (matchesChord(b.chord, event)) return b.commandId
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export interface Conflict {
  chord: Chord
  commandIds: string[]
}

/**
 * Find all chords that are bound to more than one command.
 *
 * Two chords conflict when they would match the same key event. Since
 * `resolveBinding` uses first-match-wins, conflicts are not fatal — but they
 * are a configuration smell worth surfacing in tests and dev tools.
 */
export function findConflicts(bindings: Binding[]): Conflict[] {
  // Key each chord as a stable string so we can group by identity
  const groups = new Map<string, { chord: Chord; commandIds: string[] }>()

  for (const b of bindings) {
    const k = chordKey(b.chord)
    const existing = groups.get(k)
    if (existing) {
      if (!existing.commandIds.includes(b.commandId)) {
        existing.commandIds.push(b.commandId)
      }
    } else {
      groups.set(k, { chord: b.chord, commandIds: [b.commandId] })
    }
  }

  return [...groups.values()]
    .filter((g) => g.commandIds.length > 1)
    .map((g) => ({ chord: g.chord, commandIds: g.commandIds }))
}

function chordKey(c: Chord): string {
  return `${c.key}|${+c.ctrl}${+c.meta}${+c.shift}${+c.alt}`
}

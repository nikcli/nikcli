export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
}

// Glass/Rounded border characters for glassmorphism effect
export const GlassBorder = {
  border: ["top", "bottom", "left", "right"] as const,
  customBorderChars: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    vertical: "│",
    horizontal: "─",
    topT: "┬",
    bottomT: "┴",
    leftT: "├",
    rightT: "┤",
    cross: "┼",
  },
}

// Re-export GlassBorder as GlassBorderLight for backward compatibility
// The distinction was cosmetic; both styles are identical.
export const GlassBorderLight = GlassBorder

// Minimal glass border - only corners, no sides
/** Single-line characters shared by dialog dividers and separators */
export const DialogSeparatorChars = {
  horizontal: "─",
  vertical: "│",
  dot: "·",
} as const

export const GlassBorderMinimal = {
  border: [] as const,
  customBorderChars: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    vertical: "│",
    horizontal: "─",
    topT: "┬",
    bottomT: "┴",
    leftT: "├",
    rightT: "┤",
    cross: "┼",
  },
}

/**
 * Character tables a themed component may select by name.
 *
 * Named for the tables, not the charsets: `component-tokens.ts` exports
 * `BORDER_CHARSETS`, the list of names a theme may write. One is the vocabulary,
 * the other is what the renderer is handed, and sharing an identifier between
 * them made every import site a guess.
 *
 * Themes name a charset; they never supply raw glyphs. A hand-written table can
 * be the wrong width — a double-width or combining character silently shifts
 * every column after it — and the damage shows up as a corrupted transcript far
 * from the theme that caused it. A closed set keeps that impossible.
 */
export const BORDER_CHAR_TABLES = {
  none: EmptyBorder,
  single: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    vertical: "│",
    horizontal: "─",
    topT: "┬",
    bottomT: "┴",
    leftT: "├",
    rightT: "┤",
    cross: "┼",
  },
  rounded: GlassBorder.customBorderChars,
  double: {
    topLeft: "╔",
    topRight: "╗",
    bottomLeft: "╚",
    bottomRight: "╝",
    vertical: "║",
    horizontal: "═",
    topT: "╦",
    bottomT: "╩",
    leftT: "╠",
    rightT: "╣",
    cross: "╬",
  },
  heavy: {
    topLeft: "┏",
    topRight: "┓",
    bottomLeft: "┗",
    bottomRight: "┛",
    vertical: "┃",
    horizontal: "━",
    topT: "┳",
    bottomT: "┻",
    leftT: "┣",
    rightT: "┫",
    cross: "╋",
  },
  split: SplitBorder.customBorderChars,
} as const

/**
 * The table for a charset, or `undefined` for `"default"`.
 *
 * `undefined` is not a failure: it is how a component says "use the renderer's
 * own border characters". Those live on the native side, so the only way to
 * reproduce them faithfully is not to pass a table at all — spelling out a
 * lookalike here would drift the first time they change.
 */
export function borderCharsFor(charset: keyof typeof BORDER_CHAR_TABLES | "default") {
  if (charset === "default") return undefined
  return BORDER_CHAR_TABLES[charset] ?? EmptyBorder
}

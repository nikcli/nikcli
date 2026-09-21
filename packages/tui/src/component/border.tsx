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
 * Themes name a charset; they never supply raw glyphs. A hand-written table can
 * be the wrong width — a double-width or combining character silently shifts
 * every column after it — and the damage shows up as a corrupted transcript far
 * from the theme that caused it. A closed set keeps that impossible.
 */
export const BORDER_CHARSETS = {
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

export function borderCharsFor(charset: keyof typeof BORDER_CHARSETS) {
  return BORDER_CHARSETS[charset] ?? EmptyBorder
}

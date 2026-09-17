/**
 * Element context serializer for the browser pane.
 *
 * Turns inspected DOM elements into compact, agent-readable text blocks that
 * attach to the prompt.
 *
 * Sizing and style choices:
 * - A full `getComputedStyle` dump is ~300 properties per element. Dumping raw
 *   styles or full outerHTML for multiple elements wastes thousands of context
 *   tokens on default browser values.
 * - Squeezing each element into 4-5 focused lines (selector, geometry, layout,
 *   typography/colors, text snippet) gives the agent all actionable styling and
 *   structural context without bloating the prompt window.
 * - Missing or partial properties must never throw; all field accesses use safe
 *   fallbacks.
 */

import type { InspectedElement } from "./protocol"

export interface FormatSelectionOptions {
  url?: string
  instruction?: string
}

/*
 * Every string below comes from the inspected page, and the page is not ADE's.
 *
 * The block these values land in is typed into an agent's terminal, where a
 * carriage return submits the line: a style property answered as
 * `red<CR>git push --force<CR>` used to arrive as two things typed, the second
 * of which the user never saw. Only `innerText` was ever cleaned, which covered
 * the one field nobody would think to attack.
 *
 * So nothing is interpolated raw. Control characters are removed rather than
 * escaped — a selector with a carriage return in it is not a selector — and
 * every field is capped, so one long attribute cannot push the rest of the
 * prompt out of the window.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+", "g")

/** A page-supplied value, made safe to put in a line of prompt text. */
export function field(value: unknown, maxLen = 120): string {
  if (typeof value !== "string") return ""
  const flat = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim()
  if (flat.length <= maxLen) return flat
  return `${flat.slice(0, maxLen)}...`
}

/**
 * Sanitizes a text snippet for prompt context by stripping line breaks and
 * capping length so large text nodes do not dominate the prompt.
 */
function cleanTextSnippet(text: unknown, maxLen = 100): string {
  return field(text, maxLen)
}

/**
 * Formats a single inspected element into structured, agent-readable lines.
 */
export function describeElement(element: Partial<InspectedElement> | null | undefined, index?: number): string {
  if (!element || typeof element !== "object") {
    return index !== undefined ? `${index + 1}. <unknown>` : "<unknown>"
  }

  const tagName = (field(element.tagName, 40) || "element").toLowerCase()
  const id = field(element.id, 60) ? `#${field(element.id, 60)}` : ""

  let classes = ""
  const className = field(element.className, 200)
  if (className) {
    const classList = className
      .split(/\s+/)
      .filter((c) => c && !c.startsWith("__nikcli"))
      .slice(0, 3)
    if (classList.length > 0) {
      classes = `.${classList.join(".")}`
    }
  }

  const lang = field(element.detectedLanguage, 20) || "html"
  const prefix = index !== undefined ? `${index + 1}. ` : ""
  const headerLine = `${prefix}<${tagName}${id}${classes}> (${lang})`

  const selector = field(element.selector, 200) || `${tagName}${id}${classes}`
  const selectorLine = `   selector: ${selector}`

  const rect = element.rect ?? { width: 0, height: 0, top: 0, left: 0 }
  const styles = element.styles ?? ({} as Partial<NonNullable<InspectedElement["styles"]>>)

  // Geometry is arithmetic, so it needs no cleaning — but it does need to be a
  // number: `Math.round` of a string the page chose returns NaN, not the string.
  const width = Math.round(Number(rect.width) || 0)
  const height = Math.round(Number(rect.height) || 0)
  const display = field(styles.display, 40) || "block"
  const padding = field(styles.padding, 40) || "0"
  const margin = field(styles.margin, 40) || "0"
  const boxLine = `   box: ${width}×${height} · display: ${display} · padding: ${padding} · margin: ${margin}`

  const color = field(styles.color, 40) || "-"
  const fontSize = field(styles.fontSize, 40) || "-"
  const fontWeight = field(styles.fontWeight, 40) || "-"
  const bg = field(styles.backgroundColor, 40) || "-"
  const radius = field(styles.borderRadius, 40) || "-"
  const styleLine = `   text: ${color} ${fontSize}/${fontWeight} · background: ${bg} · radius: ${radius}`

  const lines = [headerLine, selectorLine, boxLine, styleLine]

  const snippet = cleanTextSnippet(element.innerText)
  if (snippet) {
    lines.push(`   content: "${snippet}"`)
  }

  return lines.join("\n")
}

/**
 * Formats a list of inspected elements into a unified prompt block with a summary
 * header and optional follow-up instruction.
 */
export function formatSelectionContext(
  elements: readonly Partial<InspectedElement>[],
  options?: FormatSelectionOptions,
): string {
  if (!elements || elements.length === 0) return ""

  const count = elements.length
  const countLabel = `${count} element${count === 1 ? "" : "s"}`
  // The address bar is the user's, but the page can put ADE on a URL it chose
  // by navigating the frame, so the header gets the same treatment as the body.
  const url = field(options?.url, 300)
  const urlLabel = url ? ` on ${url}` : ""
  const header = `[Design Mode · ${countLabel}${urlLabel}]`

  const body = elements.map((el, i) => describeElement(el, i)).join("\n")

  if (options?.instruction && options.instruction.trim()) {
    return `${header}\n${body}\n\n${options.instruction.trim()}\n`
  }

  return `${header}\n${body}\n`
}

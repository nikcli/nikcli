/**
 * Who owns a file, from the team board.
 *
 * Sessions that work on one package side by side keep a board with a table
 * of owners: a row per owner, a cell of paths in backticks, often with a word
 * on which part (`blocchi 3D di `workbench.tsx``). Answering "whose is this
 * file" used to take a round of messages; `ade-msg who-owns` reads the table
 * instead.
 *
 * Paths in the table are written loosely: some from the repository root
 * (`packages/ade/src/bots/**`), some from the package (`src/sidebar/*`), some
 * as a bare file name (`lib.rs`). A pattern with no directory matches the
 * file name; one with a directory matches the end of the path. `*` is one
 * segment, `**` any number.
 *
 * Pure, in a `.ts`, so it is tested without a board on disk.
 */

export interface OwnerEntry {
  readonly owner: string
  readonly pattern: string
  /** The words next to the pattern in its cell, e.g. "blocchi 3D/simulatore di". */
  readonly note: string
}

export interface SharedEntry {
  readonly pattern: string
  readonly rule: string
}

export interface OwnerTable {
  readonly entries: readonly OwnerEntry[]
  readonly shared: readonly SharedEntry[]
  /** The sentence under the heading that says what to do, if the board has one. */
  readonly rule?: string
}

const PATHLIKE = /^[\w.*@~/-]+$/

/** A backticked token that names a file or a glob rather than a symbol. */
function isPathPattern(token: string): boolean {
  if (!PATHLIKE.test(token)) return false
  return token.includes("/") || /\.[A-Za-z0-9*]{1,6}$/.test(token) || token.includes("*")
}

/** Splits a cell on the commas between its items, not the ones inside parentheses. */
function cellItems(cell: string): string[] {
  const items: string[] = []
  let depth = 0
  let current = ""
  for (const char of cell) {
    if (char === "(") depth++
    if (char === ")") depth = Math.max(0, depth - 1)
    if (char === "," && depth === 0) {
      items.push(current)
      current = ""
    } else current += char
  }
  if (current.trim()) items.push(current)
  return items.map((item) => item.trim()).filter(Boolean)
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim())
}

/**
 * The owners table and the shared-files list of a board.
 *
 * The table is the first one whose header begins "Proprietario" or "Owner";
 * the shared list is the bullets after a line beginning "**File condivisi"
 * or "**Shared", each `path`: rule.
 */
export function parseOwners(markdown: string): OwnerTable {
  const lines = markdown.split(/\r?\n/)
  const entries: OwnerEntry[] = []
  const shared: SharedEntry[] = []
  let rule: string | undefined

  const header = lines.findIndex((line) => /^\s*\|\s*(Proprietario|Owner)\s*\|/i.test(line))
  if (header >= 0) {
    for (let back = header - 1; back >= 0 && back > header - 4; back--) {
      const text = lines[back]!.trim()
      if (text && !text.startsWith("#") && !text.startsWith("|")) {
        rule = text
        break
      }
    }
    for (let i = header + 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
      const [owner, files] = tableCells(lines[i]!)
      if (!owner || !files) continue
      const name = owner.replace(/\*\*/g, "").trim()
      for (const item of cellItems(files)) {
        const tokens = [...item.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)
        const paths = tokens.filter(isPathPattern)
        const note = item
          .replace(/`[^`]+`/g, (whole) => (isPathPattern(whole.slice(1, -1)) ? "" : whole))
          .replace(/`/g, "")
          .replace(/\s+/g, " ")
          .trim()
          // "blocchi 3D di `a` e `b`" leaves "blocchi 3D di e": the joiners go with the paths.
          .replace(/(\s+(di|in|of|e|and))+\s*$/i, "")
          .trim()
        for (const pattern of paths) entries.push({ owner: name, pattern, note })
      }
    }
  }

  const sharedStart = lines.findIndex((line) => /^\s*\*\*(File condivisi|Shared)/i.test(line))
  if (sharedStart >= 0) {
    for (let i = sharedStart + 1; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (line.startsWith("#")) break
      const match = /^[-*]\s+`([^`]+)`\s*:?\s*(.*)$/.exec(line)
      if (match && isPathPattern(match[1]!)) shared.push({ pattern: match[1]!, rule: match[2]!.trim() })
    }
  }

  return { entries, shared, ...(rule ? { rule } : {}) }
}

function globToRegex(pattern: string): RegExp {
  let out = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "*" && pattern[i + 1] === "*") {
      out += ".*"
      i++
      if (pattern[i + 1] === "/") i++
    } else if (char === "*") out += "[^/]*"
    else out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`(^|/)${out}$`)
}

/** Whether `pattern`, as the board writes it, covers `file`. */
export function matchesPattern(pattern: string, file: string): boolean {
  const path = file.replace(/\\/g, "/").replace(/^\.\//, "")
  const clean = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "/**")
  if (!clean.includes("/")) return globToRegex(clean).test(path.split("/").pop() ?? path)
  return globToRegex(clean).test(path)
}

/** What `ade-msg who-owns` prints for one file. */
export function whoOwns(table: OwnerTable, file: string): string {
  const owners = table.entries.filter((entry) => matchesPattern(entry.pattern, file))
  const shared = table.shared.filter((entry) => matchesPattern(entry.pattern, file))
  const lines: string[] = [file]
  if (owners.length === 0 && shared.length === 0) {
    lines.push("  nessun proprietario nella bacheca: annuncialo prima di toccarlo")
    return `${lines.join("\n")}\n`
  }
  const seen = new Set<string>()
  for (const entry of owners) {
    const line = `  ${entry.owner}${entry.note ? `: ${entry.note}` : ""}`
    if (seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
  for (const entry of shared) lines.push(`  condiviso: ${entry.rule}`)
  if (table.rule) lines.push(`regola: ${table.rule}`)
  return `${lines.join("\n")}\n`
}

/**
 * Where the board is, for a project: its own `.ade/TEAM.md`, or an
 * `ade-team/TEAM.md` beside it, which is where a team working across several
 * worktrees of one repository keeps it.
 */
export function boardCandidates(projectRoot: string): string[] {
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "")
  const parent = root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : root
  return [`${root}/.ade/TEAM.md`, `${parent}/ade-team/TEAM.md`]
}

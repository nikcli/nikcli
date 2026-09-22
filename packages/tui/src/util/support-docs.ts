import path from "path"

const DOC_ROOTS: Array<{ pattern: string; description: string; max?: number }> = [
  {
    pattern: "AGENTS.md",
    description: "Root AGENTS.md (project-wide guidelines)",
  },
  { pattern: "README.md", description: "Root README" },
  { pattern: "packages/*/AGENTS.md", description: "Per-package AGENTS.md" },
  { pattern: "packages/*/README.md", description: "Per-package README" },
  {
    pattern: "packages/nikcli/AGENTS.md",
    description: "nikcli package guidelines",
  },
  {
    pattern: "packages/nikcli/specs/**/*.md",
    description: "Architecture & protocol specs",
    max: 40,
  },
  {
    pattern: "packages/nikcli/docs/**/*.md",
    description: "In-tree user docs",
  },
  { pattern: "docs/**/*.md", description: "Workspace user docs" },
  { pattern: "CHANGELOG.md", description: "Changelog (if present)" },
]

const MAX_TOTAL = 120

/**
 * Build a markdown block describing the available nikcli documentation files
 * inside `root`. The block is injected into the support agent's system prompt
 * so it knows which files to `read` to answer user questions.
 *
 * The index is read-only and best-effort: missing files / unreadable dirs are
 * silently skipped. The result is cached in-memory for the process lifetime.
 */
const cache = new Map<string, string>()

export async function buildSupportDocsIndex(root: string): Promise<string> {
  const cached = cache.get(root)
  if (cached) return cached

  const lines: string[] = []
  lines.push("<docs_index>")
  lines.push("Local nikcli documentation available via `read`. Sizes are approximate.")
  lines.push("")

  let total = 0
  for (const { pattern, description, max } of DOC_ROOTS) {
    if (total >= MAX_TOTAL) break
    const matches = await globSafe(pattern, root)
    if (matches.length === 0) continue
    const capped = max ? matches.slice(0, max) : matches
    lines.push(`### ${description} (\`${pattern}\`)`)
    for (const m of capped) {
      const rel = toRel(root, m)
      const size = await sizeSafe(m)
      lines.push(`- \`${rel}\`${size ? ` (${size})` : ""}`)
      total++
      if (total >= MAX_TOTAL) break
    }
    lines.push("")
  }

  if (total === 0) {
    lines.push("No documentation files found in this workspace.")
    lines.push("Use `webfetch https://nikcli-ai.dev/docs` for the online reference.")
  } else {
    lines.push("## How to use")
    lines.push("- Use `read <path>` to open a file.")
    lines.push(
      '- Use `grep` to search across all docs for keywords (e.g. `grep -n "keybinds" packages/nikcli/specs/`).',
    )
    lines.push("- Use `webfetch https://nikcli-ai.dev/docs/<topic>` for the latest online docs.")
    lines.push("- Use `websearch` for release notes, GitHub issues, or recent changes.")
  }
  lines.push("</docs_index>")

  const out = lines.join("\n")
  cache.set(root, out)
  return out
}

/** Clear the in-memory cache (used in tests / when the workspace changes). */
export function clearSupportDocsCache(root?: string) {
  if (root) cache.delete(root)
  else cache.clear()
}

async function globSafe(pattern: string, cwd: string): Promise<string[]> {
  try {
    const g = new Bun.Glob(pattern)
    const out: string[] = []
    for await (const match of g.scan({ cwd, dot: false, onlyFiles: true })) {
      out.push(path.join(cwd, match))
    }
    return out
  } catch {
    return []
  }
}

async function sizeSafe(file: string): Promise<string | null> {
  try {
    const stat = await Bun.file(file).stat()
    if (!stat) return null
    const kb = stat.size / 1024
    if (kb < 1) return `${stat.size} B`
    if (kb < 1024) return `${Math.round(kb)} KB`
    return `${(kb / 1024).toFixed(1)} MB`
  } catch {
    return null
  }
}

function toRel(root: string, file: string): string {
  const rel = path.relative(root, file)
  return rel.startsWith("..") ? file : rel
}

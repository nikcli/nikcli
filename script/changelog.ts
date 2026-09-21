#!/usr/bin/env bun

import { $ } from "bun"
import { createNikcli } from "@nikcli-ai/sdk/server"
import { parseArgs } from "util"
import path from "path"

export const team = ["actions-user", "nikcli", "nikcli-agent[bot]"]

const CHANGELOG_PATH = path.resolve(import.meta.dir, "../CHANGELOG.md")
const UNRELEASED_START = "<!-- UNRELEASED:START -->"
const UNRELEASED_END = "<!-- UNRELEASED:END -->"

export async function getLatestRelease() {
  return fetch("https://api.github.com/repos/nikcli/nikcli/releases/latest")
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText)
      return res.json()
    })
    .then((data: any) => data.tag_name.replace(/^v/, ""))
}

type Commit = {
  hash: string
  author: string | null
  message: string
  areas: Set<string>
}

export async function getCommits(from: string, to: string): Promise<Commit[]> {
  const fromRef = from.startsWith("v") ? from : `v${from}`
  const toRef = to === "HEAD" ? to : to.startsWith("v") ? to : `v${to}`

  // Get commit data with GitHub usernames from the API
  const compare =
    await $`gh api "/repos/nikcli/nikcli/compare/${fromRef}...${toRef}" --jq '.commits[] | {sha: .sha, login: .author.login, message: .commit.message}'`.text()

  const commitData = new Map<string, { login: string | null; message: string }>()
  for (const line of compare.split("\n").filter(Boolean)) {
    if (!line.trim().startsWith("{")) continue
    try {
      const data = JSON.parse(line) as { sha: string; login: string | null; message: string }
      commitData.set(data.sha, { login: data.login, message: data.message.split("\n")[0] ?? "" })
    } catch {
      // skip invalid lines
    }
  }

  // Get commits that touch the relevant packages
  const log =
    await $`git log ${fromRef}..${toRef} --oneline --format="%H" -- packages/nikcli packages/sdk packages/plugin packages/desktop packages/mobile packages/app sdks/vscode packages/extensions github`.text()
  const hashes = log.split("\n").filter(Boolean)

  const commits: Commit[] = []
  for (const hash of hashes) {
    const data = commitData.get(hash)
    if (!data) continue

    const message = data.message
    if (message.match(/^(ignore:|test:|chore:|ci:|release:)/i)) continue

    const files = await $`git diff-tree --no-commit-id --name-only -r ${hash}`.text()
    const areas = new Set<string>()

    for (const file of files.split("\n").filter(Boolean)) {
      if (file.startsWith("packages/nikcli/src/cli/cmd/")) areas.add("tui")
      else if (file.startsWith("packages/nikcli/")) areas.add("core")
      else if (file.startsWith("packages/desktop/src-tauri/")) areas.add("tauri")
      else if (file.startsWith("packages/desktop/")) areas.add("app")
      else if (file.startsWith("packages/mobile/")) areas.add("mobile")
      else if (file.startsWith("packages/app/")) areas.add("app")
      else if (file.startsWith("packages/sdk/")) areas.add("sdk")
      else if (file.startsWith("packages/plugin/")) areas.add("plugin")
      else if (file.startsWith("packages/extensions/")) areas.add("extensions/zed")
      else if (file.startsWith("sdks/vscode/")) areas.add("extensions/vscode")
      else if (file.startsWith("github/")) areas.add("github")
    }

    if (areas.size === 0) continue

    commits.push({
      hash: hash.slice(0, 7),
      author: data.login,
      message,
      areas,
    })
  }

  return filterRevertedCommits(commits)
}

function filterRevertedCommits(commits: Commit[]): Commit[] {
  const revertPattern = /^Revert "(.+)"$/
  const seen = new Map<string, Commit>()

  for (const commit of commits) {
    const match = commit.message.match(revertPattern)
    if (match) {
      // It's a revert - remove the original if we've seen it
      const original = match[1]!
      if (seen.has(original)) seen.delete(original)
      else seen.set(commit.message, commit) // Keep revert if original not in range
    } else {
      // Regular commit - remove if its revert exists, otherwise add
      const revertMsg = `Revert "${commit.message}"`
      if (seen.has(revertMsg)) seen.delete(revertMsg)
      else seen.set(commit.message, commit)
    }
  }

  return [...seen.values()]
}

const sections = {
  core: "Core",
  tui: "TUI",
  app: "Desktop",
  tauri: "Desktop",
  mobile: "Mobile",
  sdk: "SDK",
  plugin: "SDK",
  "extensions/zed": "Extensions",
  "extensions/vscode": "Extensions",
  github: "Extensions",
} as const

function getSection(areas: Set<string>): string {
  // Priority order for multi-area commits
  const priority = [
    "core",
    "tui",
    "app",
    "tauri",
    "mobile",
    "sdk",
    "plugin",
    "extensions/zed",
    "extensions/vscode",
    "github",
  ]
  for (const area of priority) {
    if (areas.has(area)) return sections[area as keyof typeof sections]
  }
  return "Core"
}

async function summarizeCommit(nikcli: Awaited<ReturnType<typeof createNikcli>>, message: string): Promise<string> {
  console.log("summarizing commit:", message)
  const session = await nikcli.client.session.create()
  const result = await nikcli.client.session
    .prompt({
      path: { id: session.data!.id },
      body: {
        model: { providerID: "nikcli", modelID: "claude-sonnet-4-5" },
        tools: {
          "*": false,
        },
        parts: [
          {
            type: "text",
            text: `Summarize this commit message for a changelog entry. Return ONLY a single line summary starting with a capital letter. Be concise but specific. If the commit message is already well-written, just clean it up (capitalize, fix typos, proper grammar). Do not include any prefixes like "fix:" or "feat:".

Commit: ${message}`,
          },
        ],
      },
      signal: AbortSignal.timeout(120_000),
    })
    .then((x) => x.data?.parts?.find((y) => y.type === "text")?.text ?? message)
  return result.trim()
}

export async function generateChangelog(commits: Commit[], nikcli: Awaited<ReturnType<typeof createNikcli>>) {
  // Summarize commits in parallel with max 10 concurrent requests
  const BATCH_SIZE = 10
  const summaries: string[] = []
  for (let i = 0; i < commits.length; i += BATCH_SIZE) {
    const batch = commits.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map((c) => summarizeCommit(nikcli, c.message)))
    summaries.push(...results)
  }

  const grouped = new Map<string, string[]>()
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]!
    const section = getSection(commit.areas)
    const attribution = commit.author && !team.includes(commit.author) ? ` (@${commit.author})` : ""
    const entry = `- ${summaries[i]}${attribution}`

    if (!grouped.has(section)) grouped.set(section, [])
    grouped.get(section)!.push(entry)
  }

  const sectionOrder = ["Core", "TUI", "Desktop", "Mobile", "SDK", "Extensions"]
  const lines: string[] = []
  for (const section of sectionOrder) {
    const entries = grouped.get(section)
    if (!entries || entries.length === 0) continue
    if (lines.length > 0) lines.push("")
    lines.push(`## ${section}`, "")
    lines.push(...entries)
  }

  return lines
}

// Build changelog lines directly from commit messages, without AI summarization.
// Used in CI (the --raw mode) so no running nikcli server / API key is required.
export function buildRawChangelog(commits: Commit[]): string[] {
  const grouped = new Map<string, string[]>()
  for (const commit of commits) {
    const section = getSection(commit.areas)
    const attribution = commit.author && !team.includes(commit.author) ? ` (@${commit.author})` : ""
    // Strip the conventional-commit prefix (e.g. "feat(cli): ") and capitalize.
    const message = commit.message.replace(/^(\w+)(\([^)]*\))?!?:\s*/, "")
    const cleaned = message.charAt(0).toUpperCase() + message.slice(1)
    const entry = `- ${cleaned}${attribution}`

    if (!grouped.has(section)) grouped.set(section, [])
    grouped.get(section)!.push(entry)
  }

  const sectionOrder = ["Core", "TUI", "Desktop", "Mobile", "SDK", "Extensions"]
  const lines: string[] = []
  for (const section of sectionOrder) {
    const entries = grouped.get(section)
    if (!entries || entries.length === 0) continue
    if (lines.length > 0) lines.push("")
    lines.push(`## ${section}`, "")
    lines.push(...entries)
  }

  return lines
}

// Replace (or insert) the marker-delimited "Unreleased" block at the top of
// CHANGELOG.md with the freshly generated notes. Idempotent: running it again
// with the same commits leaves the file unchanged.
export async function writeChangelogFile(notes: string[]) {
  const file = Bun.file(CHANGELOG_PATH)
  let content = (await file.exists()) ? await file.text() : "# Changelog\n"

  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
  const block =
    notes.length > 0
      ? `${UNRELEASED_START}\n## Unreleased (${date})\n\n${notes.join("\n")}\n${UNRELEASED_END}`
      : `${UNRELEASED_START}\n${UNRELEASED_END}`

  const startIdx = content.indexOf(UNRELEASED_START)
  const endIdx = content.indexOf(UNRELEASED_END)
  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + block + content.slice(endIdx + UNRELEASED_END.length)
  } else {
    const titleMatch = content.match(/^#\s+Changelog\s*$/m)
    if (titleMatch && titleMatch.index !== undefined) {
      const insertAt = titleMatch.index + titleMatch[0].length
      content = content.slice(0, insertAt) + "\n\n" + block + "\n" + content.slice(insertAt)
    } else {
      content = `# Changelog\n\n${block}\n\n${content}`
    }
  }

  await Bun.write(CHANGELOG_PATH, content)
  console.log(`updated ${CHANGELOG_PATH}`)
}

// Write the generated notes into the body of an existing GitHub release.
export async function writeReleaseNotes(tag: string, notes: string[]) {
  const tagRef = tag.startsWith("v") ? tag : `v${tag}`
  const body = notes.join("\n") || `Release ${tagRef}`
  await $`gh release edit ${tagRef} --notes ${body}`
  console.log(`updated release notes for ${tagRef}`)
}

// Add a permanent, versioned section for a release to CHANGELOG.md and clear the
// Unreleased block (its commits are now shipped). Called from publish-start.ts so
// the CHANGELOG update is part of the "release: vX" commit — no separate bot push.
export async function writeReleaseSection(version: string, notes: string[]) {
  const file = Bun.file(CHANGELOG_PATH)
  let content = (await file.exists()) ? await file.text() : "# Changelog\n"

  const v = version.replace(/^v/, "")
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })
  const section = `## v${v} (${date})\n\n${notes.join("\n") || "- No notable changes"}\n`

  // Reset the Unreleased block to empty markers (these commits are now released).
  const startIdx = content.indexOf(UNRELEASED_START)
  const endIdx = content.indexOf(UNRELEASED_END)
  if (startIdx !== -1 && endIdx !== -1) {
    content =
      content.slice(0, startIdx) +
      `${UNRELEASED_START}\n${UNRELEASED_END}` +
      content.slice(endIdx + UNRELEASED_END.length)
  }

  // Insert the new version section after the Unreleased markers (or after the title).
  const anchor = content.indexOf(UNRELEASED_END)
  if (anchor !== -1) {
    const insertAt = anchor + UNRELEASED_END.length
    content = content.slice(0, insertAt) + `\n\n${section}` + content.slice(insertAt)
  } else {
    const titleMatch = content.match(/^#\s+Changelog\s*$/m)
    if (titleMatch && titleMatch.index !== undefined) {
      const insertAt = titleMatch.index + titleMatch[0].length
      content = content.slice(0, insertAt) + `\n\n${section}` + content.slice(insertAt)
    } else {
      content = `# Changelog\n\n${section}\n${content}`
    }
  }

  // Collapse any accidental runs of blank lines introduced by the insert.
  content = content.replace(/\n{3,}/g, "\n\n")

  await Bun.write(CHANGELOG_PATH, content)
  console.log(`wrote v${v} section to ${CHANGELOG_PATH}`)
}

export async function getContributors(from: string, to: string) {
  const fromRef = from.startsWith("v") ? from : `v${from}`
  const toRef = to === "HEAD" ? to : to.startsWith("v") ? to : `v${to}`
  const compare =
    await $`gh api "/repos/nikcli/nikcli/compare/${fromRef}...${toRef}" --jq '.commits[] | {login: .author.login, message: .commit.message}'`.text()
  const contributors = new Map<string, Set<string>>()

  for (const line of compare.split("\n").filter(Boolean)) {
    const { login, message } = JSON.parse(line) as { login: string | null; message: string }
    const title = message.split("\n")[0] ?? ""
    if (title.match(/^(ignore:|test:|chore:|ci:|release:)/i)) continue

    if (login && !team.includes(login)) {
      if (!contributors.has(login)) contributors.set(login, new Set())
      contributors.get(login)!.add(title)
    }
  }

  return contributors
}

export async function buildNotes(from: string, to: string, options: { raw?: boolean } = {}) {
  const commits = await getCommits(from, to)

  if (commits.length === 0) {
    return []
  }

  const notes: string[] = []

  if (options.raw) {
    // Skip AI summarization entirely — group commit messages by area directly.
    notes.push(...buildRawChangelog(commits))
  } else {
    console.log("generating changelog since " + from)

    const nikcli = await createNikcli({ port: 5044 })

    try {
      const lines = await generateChangelog(commits, nikcli)
      notes.push(...lines)
      console.log("---- Generated Changelog ----")
      console.log(notes.join("\n"))
      console.log("-----------------------------")
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        console.log("Changelog generation timed out, using raw commits")
        notes.push(...buildRawChangelog(commits))
      } else {
        throw error
      }
    } finally {
      nikcli.server.close()
    }
  }

  const contributors = await getContributors(from, to)

  if (contributors.size > 0) {
    notes.push("")
    notes.push(`**Thank you to ${contributors.size} community contributor${contributors.size > 1 ? "s" : ""}:**`)
    notes.push("")
    for (const [username, userCommits] of contributors) {
      notes.push(`- @${username}:`)
      for (const c of userCommits) {
        notes.push(`  - ${c}`)
      }
    }
  }

  return notes
}

// CLI entrypoint
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      from: { type: "string", short: "f" },
      to: { type: "string", short: "t", default: "HEAD" },
      write: { type: "boolean", short: "w", default: false },
      release: { type: "string", short: "r" },
      raw: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: bun script/changelog.ts [options]

Options:
  -f, --from <version>   Starting version (default: latest GitHub release)
  -t, --to <ref>         Ending ref (default: HEAD)
  -w, --write            Update CHANGELOG.md (rewrites the "Unreleased" section)
  -r, --release <tag>    Write the generated notes into the given GitHub release
      --raw              Skip AI summarization (no nikcli server required — used in CI)
  -h, --help             Show this help message

Examples:
  bun script/changelog.ts                     # Latest release to HEAD (print only)
  bun script/changelog.ts --write --raw       # Refresh the Unreleased section of CHANGELOG.md
  bun script/changelog.ts --release v0.0.8    # Write notes into release v0.0.8
  bun script/changelog.ts -f 1.0.200 -t 1.0.205
`)
    process.exit(0)
  }

  const to = values.release ?? values.to!
  const from = values.from ?? (await getLatestRelease())

  console.log(`Generating changelog: v${from} -> ${to}\n`)

  const notes = await buildNotes(from, to, { raw: values.raw })

  if (values.write) await writeChangelogFile(notes)
  if (values.release) await writeReleaseNotes(values.release, notes)

  if (!values.write && !values.release) {
    console.log("\n=== Final Notes ===")
    console.log(notes.join("\n"))
  }
}

/**
 * Whether the commits since the last ADE release deserve a new one, and which.
 *
 * The commit subject is the whole signal: `feat(ade): …` asks for a minor
 * version, `fix` / `perf` / `revert` for a patch, a `!` before the colon (or a
 * `BREAKING CHANGE:` footer) for a major. Everything else — docs, tests,
 * chores, refactors — ships with the next release that has something a user
 * would notice, but never causes one on its own.
 *
 * Pure, in a `.ts`, so the rule can be tested under `bun test`; the git and
 * GitHub plumbing lives in `script/release-plan.ts`.
 */

import { parseVersion } from "./release"

export const COMMIT_TYPES = ["feat", "fix", "perf", "revert", "refactor", "docs", "test", "chore", "build", "ci", "style"] as const
export type CommitType = (typeof COMMIT_TYPES)[number]

/** Written anywhere in a commit message, keeps that commit from causing a release. */
export const SKIP_MARKER = "[skip release]"

export interface Commit {
  readonly sha: string
  readonly subject: string
  readonly body: string
}

export interface ParsedSubject {
  readonly type: CommitType
  readonly scope?: string
  readonly breaking: boolean
  readonly description: string
}

export type Bump = "major" | "minor" | "patch"

export interface ReleasePlan {
  readonly version: string
  readonly bump: Bump
  readonly notes: string
}

const SUBJECT = /^([a-z]+)(?:\(([a-z0-9][a-z0-9,/-]*)\))?(!)?: (\S.*)$/

/** `type(scope)!: description`, or undefined when the subject does not follow the format. */
export function parseSubject(subject: string): ParsedSubject | undefined {
  const match = SUBJECT.exec(subject.trim())
  if (!match) return undefined
  const type = match[1] as CommitType
  if (!COMMIT_TYPES.includes(type)) return undefined
  return {
    type,
    ...(match[2] ? { scope: match[2] } : {}),
    breaking: match[3] === "!",
    description: match[4]!,
  }
}

/**
 * Subjects that break the format, with the reason. Merge commits are git's
 * own wording and are left alone.
 */
export function invalidSubjects(commits: readonly Commit[]): { sha: string; subject: string }[] {
  return commits
    .filter((c) => !c.subject.startsWith("Merge ") && !parseSubject(c.subject))
    .map((c) => ({ sha: c.sha, subject: c.subject }))
}

function bumpOf(commit: Commit): Bump | undefined {
  if (commit.subject.includes(SKIP_MARKER) || commit.body.includes(SKIP_MARKER)) return undefined
  const parsed = parseSubject(commit.subject)
  if (!parsed) return undefined
  if (parsed.breaking || /^BREAKING[ -]CHANGE:/m.test(commit.body)) return "major"
  if (parsed.type === "feat") return "minor"
  if (parsed.type === "fix" || parsed.type === "perf" || parsed.type === "revert") return "patch"
  return undefined
}

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 }

/**
 * The next version after `last` for these commits, or undefined when none of
 * them asks for a release.
 *
 * Before 1.0 a breaking change moves the minor number, not the major: `0.x` is
 * already the promise that anything may change, and jumping to 1.0 is a
 * decision for a person, not for a commit subject.
 */
export function planRelease(last: string | undefined, commits: readonly Commit[]): ReleasePlan | undefined {
  let bump: Bump | undefined
  for (const commit of commits) {
    const own = bumpOf(commit)
    if (own && (!bump || RANK[own] > RANK[bump])) bump = own
  }
  if (!bump) return undefined

  const [major, minor, patch] = (last && parseVersion(last)) || [0, 0, 0]
  const effective: Bump = bump === "major" && major === 0 ? "minor" : bump
  const next =
    effective === "major" ? [major + 1, 0, 0] : effective === "minor" ? [major, minor + 1, 0] : [major, minor, patch + 1]

  return { version: next.join("."), bump, notes: releaseNotes(commits) }
}

const SECTIONS: readonly { title: string; types: readonly CommitType[] }[] = [
  { title: "Novità", types: ["feat"] },
  { title: "Correzioni", types: ["fix", "revert"] },
  { title: "Prestazioni", types: ["perf"] },
]

/** Markdown notes: what a user would notice, grouped, newest first as git lists them. */
export function releaseNotes(commits: readonly Commit[]): string {
  const parts: string[] = []
  for (const section of SECTIONS) {
    const lines = commits.flatMap((c) => {
      const parsed = parseSubject(c.subject)
      if (!parsed || !section.types.includes(parsed.type)) return []
      const scope = parsed.scope ? `**${parsed.scope}:** ` : ""
      return [`- ${scope}${parsed.description}${parsed.breaking ? " ⚠️" : ""}`]
    })
    if (lines.length > 0) parts.push(`### ${section.title}\n\n${lines.join("\n")}`)
  }
  return parts.join("\n\n")
}

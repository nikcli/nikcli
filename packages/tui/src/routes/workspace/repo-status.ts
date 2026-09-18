import path from "node:path"

/**
 * Repository status for the workspace strip and the repo actions menu.
 *
 * Every panel in the workspace already shells out to git for its own view
 * (commits, branches, a diff). What none of them had was the one line that
 * answers "where am I and is it safe to push": branch, upstream drift and how
 * much is uncommitted. That line is what gates the action menu, so it lives
 * here rather than in any single panel.
 */

export type RepoDirty = {
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
}

export type RepoCommit = {
  hash: string
  subject: string
  relative: string
}

export type RepoStatus = {
  directory: string
  /** `owner/name` for a GitHub remote, otherwise the directory basename. */
  name: string
  /** Set only when the remote is a GitHub repo — gates the `gh` actions. */
  slug?: string
  remoteUrl?: string
  branch: string
  detached: boolean
  upstream?: string
  ahead: number
  behind: number
  stashes: number
  dirty: RepoDirty
  lastCommit?: RepoCommit
  /** Set when the directory is not a git work tree, or git failed outright. */
  error?: string
}

export const EMPTY_DIRTY: RepoDirty = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }

export function dirtyCount(dirty: RepoDirty) {
  return dirty.staged + dirty.unstaged + dirty.untracked + dirty.conflicts
}

export function isClean(status: RepoStatus | undefined) {
  if (!status || status.error) return true
  return dirtyCount(status.dirty) === 0
}

/** `git@github.com:owner/name.git` / `https://github.com/owner/name` -> `owner/name`. */
export function parseRemoteSlug(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/, "")
  if (!trimmed) return undefined
  const ssh = trimmed.match(/github\.com[:/](.+?\/.+?)$/)
  if (ssh) return ssh[1]
  try {
    const url = new URL(trimmed)
    if (url.hostname.includes("github.com")) return url.pathname.replace(/^\//, "") || undefined
  } catch {}
  return undefined
}

/** Browser URL for a remote, for the "open on GitHub" action. */
export function remoteWebUrl(remote: string | undefined): string | undefined {
  if (!remote) return undefined
  const slug = parseRemoteSlug(remote)
  if (slug) return `https://github.com/${slug}`
  const trimmed = remote.trim().replace(/\.git$/, "")
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed
  return undefined
}

export type ParsedStatus = {
  branch: string
  detached: boolean
  upstream?: string
  ahead: number
  behind: number
  dirty: RepoDirty
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * v2 rather than v1 because only v2 reports the upstream and the ahead/behind
 * pair in the same call; v1 would have cost a second `rev-list` spawn per
 * refresh.
 */
export function parseStatus(output: string): ParsedStatus {
  const result: ParsedStatus = {
    branch: "",
    detached: false,
    ahead: 0,
    behind: 0,
    dirty: { ...EMPTY_DIRTY },
  }
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd()
    if (!line) continue
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim()
      result.detached = head === "(detached)"
      result.branch = result.detached ? "detached" : head
      continue
    }
    if (line.startsWith("# branch.upstream ")) {
      result.upstream = line.slice("# branch.upstream ".length).trim() || undefined
      continue
    }
    if (line.startsWith("# branch.ab ")) {
      const ab = line.slice("# branch.ab ".length).trim().split(/\s+/)
      for (const token of ab) {
        const value = Number.parseInt(token.slice(1), 10)
        if (Number.isNaN(value)) continue
        if (token.startsWith("+")) result.ahead = value
        else if (token.startsWith("-")) result.behind = value
      }
      continue
    }
    if (line.startsWith("#")) continue
    if (line.startsWith("? ")) {
      result.dirty.untracked += 1
      continue
    }
    if (line.startsWith("! ")) continue
    if (line.startsWith("u ")) {
      result.dirty.conflicts += 1
      continue
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // `<type> <XY> <sub> …` — X is the index status, Y the worktree status.
      const xy = line.split(" ")[1] ?? ".."
      if (xy[0] && xy[0] !== ".") result.dirty.staged += 1
      if (xy[1] && xy[1] !== ".") result.dirty.unstaged += 1
    }
  }
  return result
}

/** `↑2 ↓1`, or an empty string when the branch is level (or has no upstream). */
export function formatAheadBehind(ahead: number, behind: number) {
  const parts: string[] = []
  if (ahead > 0) parts.push(`↑${ahead}`)
  if (behind > 0) parts.push(`↓${behind}`)
  return parts.join(" ")
}

/** Compact `3 staged · 2 changed · 1 untracked` for the actions menu subtitle. */
export function formatDirty(dirty: RepoDirty) {
  const parts: string[] = []
  if (dirty.conflicts > 0) parts.push(`${dirty.conflicts} conflicted`)
  if (dirty.staged > 0) parts.push(`${dirty.staged} staged`)
  if (dirty.unstaged > 0) parts.push(`${dirty.unstaged} changed`)
  if (dirty.untracked > 0) parts.push(`${dirty.untracked} untracked`)
  if (parts.length === 0) return "clean"
  return parts.join(" · ")
}

const FIELD = "\x1f"

export type RunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run a binary in `directory` and never throw for a non-zero exit.
 *
 * The callers here are a status refresh and a menu action: the first wants a
 * silent empty result on failure, the second wants git's own stderr verbatim
 * in the toast. A thrown error served neither well.
 */
export async function run(
  binary: string,
  args: string[],
  directory: string,
  options: { timeoutMs?: number } = {},
): Promise<RunResult> {
  const resolved = binary === "git" ? (Bun.which("git") ?? "git") : Bun.which(binary)
  if (!resolved) return { stdout: "", stderr: `${binary} not found`, exitCode: 127 }
  const proc = Bun.spawn([resolved, ...args], {
    windowsHide: true,
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, options.timeoutMs ?? 30_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  if (timedOut) return { stdout, stderr: `${binary} timed out`, exitCode: exitCode || 124 }
  return { stdout, stderr, exitCode }
}

/** stdout of a successful run, or `undefined` when the command failed. */
export async function runText(binary: string, args: string[], directory: string) {
  const result = await run(binary, args, directory)
  if (result.exitCode !== 0) return undefined
  return result.stdout
}

export function runErrorMessage(result: RunResult) {
  const stderr = result.stderr.trim()
  if (stderr) return stderr.split("\n")[0]
  const stdout = result.stdout.trim()
  if (stdout) return stdout.split("\n")[0]
  return `exited with ${result.exitCode}`
}

export function parseLastCommit(output: string | undefined): RepoCommit | undefined {
  if (!output) return undefined
  const [hash = "", subject = "", relative = ""] = output.trim().split(FIELD)
  if (!hash) return undefined
  return { hash, subject, relative }
}

export async function loadRepoStatus(directory: string): Promise<RepoStatus> {
  const base: RepoStatus = {
    directory,
    name: path.basename(directory) || directory,
    branch: "",
    detached: false,
    ahead: 0,
    behind: 0,
    stashes: 0,
    dirty: { ...EMPTY_DIRTY },
  }

  const status = await run("git", ["status", "--porcelain=v2", "--branch"], directory)
  if (status.exitCode !== 0) {
    return { ...base, error: runErrorMessage(status) }
  }

  const [remote, stash, last] = await Promise.all([
    runText("git", ["remote", "get-url", "origin"], directory),
    runText("git", ["stash", "list"], directory),
    runText("git", ["log", "-1", `--format=%h${FIELD}%s${FIELD}%cr`], directory),
  ])

  const parsed = parseStatus(status.stdout)
  const remoteUrl = remote?.trim() || undefined
  const slug = remoteUrl ? parseRemoteSlug(remoteUrl) : undefined

  return {
    ...base,
    name: slug ?? base.name,
    slug,
    remoteUrl,
    branch: parsed.branch || "detached",
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    stashes: stash ? stash.split("\n").filter((line) => line.trim().length > 0).length : 0,
    dirty: parsed.dirty,
    lastCommit: parseLastCommit(last),
  }
}

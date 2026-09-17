import { type Host } from "../host/shell"
import { parseUnifiedDiff, type FileDiff } from "./diff"
import { t } from "../i18n"

export interface SessionDiff {
  files: FileDiff[]
  added: number
  removed: number
  truncated: boolean
  error?: string
}

export async function loadSessionDiff(input: {
  host: Host
  cwd: string
  baseRef: string
}): Promise<SessionDiff> {
  const { host, cwd, baseRef } = input

  /*
   * Staging happens in a throwaway index so reviewing never disturbs what the
   * user has staged. Where that index file lives has to be asked for rather
   * than assumed: inside a session worktree `.git` is a file pointing at the
   * real gitdir, so a hardcoded `.git/…` path names a directory that does not
   * exist and every git call below fails.
   */
  const indexPath = await host.run("git", ["rev-parse", "--git-path", "ade-review-index"], cwd)
  if (indexPath.code !== 0) {
    return {
      files: [],
      added: 0,
      removed: 0,
      truncated: false,
      error: t("review.error.noGit"),
    }
  }
  const env = { GIT_INDEX_FILE: indexPath.stdout.trim() }

  // The session's own checkout must never be staged into its own review.
  const addResult = await host.run("git", ["add", "-A", "--", ":!.ade-trees"], cwd, env)
  if (addResult.code !== 0) {
    return { files: [], added: 0, removed: 0, truncated: false, error: t("review.error.status") }
  }

  const statResult = await host.run("git", ["diff", "--cached", "--shortstat", baseRef], cwd, env)
  if (statResult.code !== 0) {
    return { files: [], added: 0, removed: 0, truncated: false, error: t("review.error.stats") }
  }

  let added = 0
  let removed = 0
  const matchAdded = statResult.stdout.match(/(\d+)\s+insertion/)
  if (matchAdded) added = parseInt(matchAdded[1], 10)
  const matchRemoved = statResult.stdout.match(/(\d+)\s+deletion/)
  if (matchRemoved) removed = parseInt(matchRemoved[1], 10)

  const totalChanges = added + removed
  const MAX_CHANGES = 2000

  let files: FileDiff[] = []
  let truncated = false

  if (totalChanges > MAX_CHANGES) {
    truncated = true
    const nameStatusResult = await host.run("git", ["diff", "--cached", "--name-status", baseRef], cwd, env)
    if (nameStatusResult.code === 0) {
      files = parseNameStatus(nameStatusResult.stdout)
    } else {
      return { files: [], added: 0, removed: 0, truncated: false, error: t("review.error.files") }
    }
  } else {
    const diffResult = await host.run("git", ["diff", "--cached", baseRef], cwd, env)
    if (diffResult.code === 0) {
      files = parseUnifiedDiff(diffResult.stdout)
    } else {
      return { files: [], added: 0, removed: 0, truncated: false, error: "Impossibile calcolare i dettagli delle modifiche." }
    }
  }

  return { files, added, removed, truncated }
}

function parseNameStatus(text: string): FileDiff[] {
  const lines = text.trim().split("\n")
  const files: FileDiff[] = []
  for (const line of lines) {
    if (!line) continue
    const parts = line.split("\t")
    const status = parts[0][0]
    let fileDiff: FileDiff = {
      path: "",
      status: "modified",
      added: 0,
      removed: 0,
      binary: false,
      hunks: [],
    }
    if (status === "A") {
      fileDiff.status = "added"
      fileDiff.path = parts[1]
    } else if (status === "D") {
      fileDiff.status = "deleted"
      fileDiff.path = parts[1]
    } else if (status === "R") {
      fileDiff.status = "renamed"
      fileDiff.oldPath = parts[1]
      fileDiff.path = parts[2]
    } else {
      fileDiff.status = "modified"
      fileDiff.path = parts[1]
    }
    files.push(fileDiff)
  }
  return files
}

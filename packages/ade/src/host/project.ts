/**
 * Project discovery.
 *
 * A "project" is just a directory ADE is pointed at, possibly inside a git
 * repository. The module figures out the repo root and branch using the Host
 * abstraction, so it never touches the filesystem directly — which makes it
 * testable without a real git repo on disk.
 */

import type { Host } from "./shell"
import { normalizePath, basename } from "./path"
import { isRemoteRoot, parseRemoteRoot, remoteName, remoteRoot, type RemoteTarget } from "../remote/ssh"

export interface Project {
  /** Set for a remote Space: sessions open over ssh, and nothing on the local disk belongs to it. */
  remote?: RemoteTarget
  /** Absolute, normalised root of the repository (or of the chosen directory). */
  root: string
  /** Display name: basename of the root. */
  name: string
  /** Current branch, or undefined when detached / not a git repo. */
  branch?: string
  /** True when the root is inside a git repository. */
  git: boolean
}

/**
 * Resolves the project that owns `startDir`.
 *
 * Runs `git rev-parse --show-toplevel` and `--abbrev-ref HEAD` through `host`.
 * When git is absent or `startDir` is not inside a repo the returned Project
 * has `git: false` and uses `startDir` as root — ADE must open on any folder,
 * just without worktree isolation.
 */
export async function discoverProject(host: Host, startDir: string): Promise<Project> {
  /*
   * A remote Space is known by its root alone. Nothing local is asked about
   * it — no git, no write root — and every place a project is opened from
   * (restore, recents, the palette) comes through here, so none of them runs
   * `git` in a directory called `ssh://…`.
   */
  if (isRemoteRoot(startDir)) {
    const remote = parseRemoteRoot(startDir)
    if (remote) return { root: remoteRoot(remote), name: remoteName(remote), git: false, remote }
  }
  const toplevel = await host.run("git", ["rev-parse", "--show-toplevel"], startDir)

  if (toplevel.code !== 0 || !toplevel.stdout.trim()) {
    // Not a git repo — still a valid project, just without isolation.
    const root = normalizePath(startDir)
    await allowWrites(host, root)
    return { root, name: basename(root), git: false }
  }

  const root = normalizePath(toplevel.stdout.trim())
  await allowWrites(host, root)
  const branchResult = await host.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root)
  const rawBranch = branchResult.stdout.trim()
  // "HEAD" is what git returns when detached.
  const branch = rawBranch && rawBranch !== "HEAD" ? rawBranch : undefined

  return { root, name: basename(root), branch, git: true }
}

/**
 * Tells the host this root may be written to.
 *
 * Here rather than at each call site because this function is the only way a
 * Project comes into existence — opening one, reopening a recent one, restoring
 * the last session — and a root that is granted in three places out of four is
 * a save that fails on a Tuesday. The host decides what the grant means; the
 * browser harness has no such method and needs none.
 */
async function allowWrites(host: Host, root: string): Promise<void> {
  await host.allowWriteRoot?.(root)
}

/**
 * Lets the user pick a directory, then discovers the project rooted there.
 * Returns `undefined` when the user cancels the dialog.
 */
export async function openProject(host: Host): Promise<Project | undefined> {
  if (!host.pickDirectory) return undefined
  const dir = await host.pickDirectory("Apri progetto")
  if (!dir) return undefined
  return discoverProject(host, dir)
}

import { dirtyCount, formatAheadBehind, formatDirty, type RepoStatus } from "./repo-status"

/**
 * The repository action catalog.
 *
 * Kept separate from the dialog that renders it so the gating — which action is
 * even possible given the current branch, upstream and working tree — is a pure
 * function over `RepoStatus` and can be tested without a terminal. Disabled
 * entries stay in the list on purpose: an action that silently disappears when
 * the branch has no upstream teaches nothing, one that says "no upstream" does.
 */

export type RepoActionID =
  | "fetch"
  | "pull"
  | "pull-rebase"
  | "push"
  | "publish"
  | "push-force"
  | "branch-create"
  | "branch-switch"
  | "branch-rename"
  | "branch-delete"
  | "stage-all"
  | "unstage-all"
  | "commit"
  | "amend"
  | "stash"
  | "stash-pop"
  | "discard"
  | "open-remote"
  | "copy-remote"
  | "copy-branch"
  | "pr-create"
  | "pr-view"
  | "refresh"

export type RepoActionCategory = "Sync" | "Branch" | "Changes" | "Repository"

export type RepoAction = {
  id: RepoActionID
  title: string
  category: RepoActionCategory
  description?: string
  /** Set when the action cannot run right now; the string is the reason. */
  disabled?: string
  /** Rewrites history or destroys work — the runner confirms these first. */
  danger?: boolean
}

export type RepoActionEnv = {
  /** `gh` on PATH. The PR actions are unreachable without it. */
  gh: boolean
}

export function buildRepoActions(status: RepoStatus | undefined, env: RepoActionEnv): RepoAction[] {
  const noRepo = !status || !!status.error ? "not a git repository" : undefined
  const upstream = status?.upstream
  const dirty = status ? dirtyCount(status.dirty) : 0
  const conflicts = status?.dirty.conflicts ?? 0
  const detached = status?.detached ?? false
  const drift = status ? formatAheadBehind(status.ahead, status.behind) : ""
  const noGh = env.gh ? undefined : "gh not installed"
  const noRemote = status?.remoteUrl ? undefined : "no origin remote"

  const actions: RepoAction[] = [
    {
      id: "fetch",
      title: "Fetch all",
      category: "Sync",
      description: "git fetch --all --prune",
      disabled: noRepo ?? noRemote,
    },
    {
      id: "pull",
      title: "Pull",
      category: "Sync",
      description: upstream ? `Fast-forward from ${upstream}${drift ? ` (${drift})` : ""}` : "git pull --ff-only",
      disabled: noRepo ?? (upstream ? undefined : "no upstream branch"),
    },
    {
      id: "pull-rebase",
      title: "Pull (rebase)",
      category: "Sync",
      description: "git pull --rebase — replays local commits on top",
      disabled:
        noRepo ?? (upstream ? undefined : "no upstream branch") ?? (dirty > 0 ? "working tree dirty" : undefined),
    },
    {
      id: "push",
      title: "Push",
      category: "Sync",
      description: upstream
        ? `To ${upstream}${status && status.ahead > 0 ? ` · ${status.ahead} ahead` : ""}`
        : "git push",
      disabled: noRepo ?? (upstream ? undefined : "no upstream branch"),
    },
    {
      id: "publish",
      title: "Publish branch",
      category: "Sync",
      description: status ? `git push -u origin ${status.branch}` : "git push -u origin <branch>",
      disabled:
        noRepo ?? noRemote ?? (upstream ? "already tracking" : undefined) ?? (detached ? "detached HEAD" : undefined),
    },
    {
      id: "push-force",
      title: "Force push (with lease)",
      category: "Sync",
      description: "git push --force-with-lease — overwrites the remote branch",
      danger: true,
      disabled: noRepo ?? (upstream ? undefined : "no upstream branch"),
    },
    {
      id: "branch-create",
      title: "Create branch…",
      category: "Branch",
      description: status ? `Branch from ${status.branch}` : undefined,
      disabled: noRepo,
    },
    {
      id: "branch-switch",
      title: "Switch branch…",
      category: "Branch",
      description: dirty > 0 ? "Uncommitted changes travel with you" : undefined,
      disabled: noRepo,
    },
    {
      id: "branch-rename",
      title: "Rename branch…",
      category: "Branch",
      description: status ? `Rename ${status.branch}` : undefined,
      disabled: noRepo ?? (detached ? "detached HEAD" : undefined),
    },
    {
      id: "branch-delete",
      title: "Delete branch…",
      category: "Branch",
      danger: true,
      disabled: noRepo,
    },
    {
      id: "stage-all",
      title: "Stage all",
      category: "Changes",
      description: "git add -A",
      disabled: noRepo ?? (dirty === 0 ? "nothing to stage" : undefined),
    },
    {
      id: "unstage-all",
      title: "Unstage all",
      category: "Changes",
      description: "git reset",
      disabled: noRepo ?? (status && status.dirty.staged > 0 ? undefined : "nothing staged"),
    },
    {
      id: "commit",
      title: "Commit…",
      category: "Changes",
      description: status ? formatDirty(status.dirty) : undefined,
      disabled:
        noRepo ??
        (dirty === 0 ? "nothing to commit" : undefined) ??
        (conflicts > 0 ? "resolve conflicts first" : undefined),
    },
    {
      id: "amend",
      title: "Amend last commit",
      category: "Changes",
      description: status?.lastCommit ? `${status.lastCommit.hash} ${status.lastCommit.subject}` : undefined,
      danger: true,
      disabled: noRepo ?? (status?.lastCommit ? undefined : "no commits yet"),
    },
    {
      id: "stash",
      title: "Stash changes",
      category: "Changes",
      description: "git stash push --include-untracked",
      disabled: noRepo ?? (dirty === 0 ? "nothing to stash" : undefined),
    },
    {
      id: "stash-pop",
      title: "Pop stash",
      category: "Changes",
      description: status && status.stashes > 0 ? `${status.stashes} stashed` : undefined,
      disabled: noRepo ?? (status && status.stashes > 0 ? undefined : "no stash entries"),
    },
    {
      id: "discard",
      title: "Discard all changes",
      category: "Changes",
      description: "Restores tracked files and removes untracked ones",
      danger: true,
      disabled: noRepo ?? (dirty === 0 ? "nothing to discard" : undefined),
    },
    {
      id: "pr-create",
      title: "Create pull request",
      category: "Repository",
      description: "gh pr create --web",
      disabled: noRepo ?? noGh ?? (status?.slug ? undefined : "not a GitHub remote"),
    },
    {
      id: "pr-view",
      title: "Open pull request",
      category: "Repository",
      description: "gh pr view --web for the current branch",
      disabled: noRepo ?? noGh ?? (status?.slug ? undefined : "not a GitHub remote"),
    },
    {
      id: "open-remote",
      title: "Open repository in browser",
      category: "Repository",
      disabled: noRepo ?? noRemote,
    },
    {
      id: "copy-remote",
      title: "Copy remote URL",
      category: "Repository",
      description: status?.remoteUrl,
      disabled: noRepo ?? noRemote,
    },
    {
      id: "copy-branch",
      title: "Copy branch name",
      category: "Repository",
      description: status?.branch,
      disabled: noRepo ?? (detached ? "detached HEAD" : undefined),
    },
    {
      id: "refresh",
      title: "Refresh repository status",
      category: "Repository",
    },
  ]

  return actions
}

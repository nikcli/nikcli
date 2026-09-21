import { describe, expect, it } from "bun:test"
import { buildRepoActions, type RepoActionID } from "@tui/routes/workspace/repo-actions"
import type { RepoStatus } from "@tui/routes/workspace/repo-status"

const CLEAN: RepoStatus = {
  directory: "/tmp/repo",
  name: "nikcli/nikcli",
  slug: "nikcli/nikcli",
  remoteUrl: "git@github.com:nikcli/nikcli.git",
  branch: "live-main",
  detached: false,
  upstream: "origin/live-main",
  ahead: 0,
  behind: 0,
  stashes: 0,
  dirty: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
  lastCommit: { hash: "abc1234", subject: "release: v1.368.0", relative: "1 hour ago" },
}

function reasons(status: RepoStatus | undefined, gh = true) {
  const map = new Map<RepoActionID, string | undefined>()
  for (const action of buildRepoActions(status, { gh })) map.set(action.id, action.disabled)
  return map
}

describe("buildRepoActions", () => {
  it("offers every action id exactly once", () => {
    const actions = buildRepoActions(CLEAN, { gh: true })
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length)
  })

  it("keeps refresh reachable even outside a repository", () => {
    const map = reasons(undefined)
    expect(map.get("refresh")).toBeUndefined()
    expect(map.get("fetch")).toBe("not a git repository")
    expect(map.get("commit")).toBe("not a git repository")
  })

  it("disables everything when git itself failed", () => {
    const map = reasons({ ...CLEAN, error: "fatal: not a git repository" })
    expect(map.get("push")).toBe("not a git repository")
    expect(map.get("branch-create")).toBe("not a git repository")
  })

  it("swaps push for publish when the branch has no upstream", () => {
    const map = reasons({ ...CLEAN, upstream: undefined })
    expect(map.get("push")).toBe("no upstream branch")
    expect(map.get("pull")).toBe("no upstream branch")
    expect(map.get("push-force")).toBe("no upstream branch")
    expect(map.get("publish")).toBeUndefined()
  })

  it("hides publish once the branch already tracks a remote", () => {
    expect(reasons(CLEAN).get("publish")).toBe("already tracking")
  })

  it("has nothing to commit, stash or discard on a clean tree", () => {
    const map = reasons(CLEAN)
    expect(map.get("commit")).toBe("nothing to commit")
    expect(map.get("stage-all")).toBe("nothing to stage")
    expect(map.get("stash")).toBe("nothing to stash")
    expect(map.get("discard")).toBe("nothing to discard")
    expect(map.get("unstage-all")).toBe("nothing staged")
    expect(map.get("stash-pop")).toBe("no stash entries")
  })

  it("opens the change actions as soon as the tree is dirty", () => {
    const map = reasons({ ...CLEAN, dirty: { staged: 1, unstaged: 2, untracked: 0, conflicts: 0 }, stashes: 2 })
    expect(map.get("commit")).toBeUndefined()
    expect(map.get("stage-all")).toBeUndefined()
    expect(map.get("unstage-all")).toBeUndefined()
    expect(map.get("discard")).toBeUndefined()
    expect(map.get("stash-pop")).toBeUndefined()
    // A rebase over a dirty tree is the classic way to lose an afternoon.
    expect(map.get("pull-rebase")).toBe("working tree dirty")
  })

  it("blocks a commit while a merge is conflicted", () => {
    const map = reasons({ ...CLEAN, dirty: { staged: 0, unstaged: 1, untracked: 0, conflicts: 2 } })
    expect(map.get("commit")).toBe("resolve conflicts first")
  })

  it("refuses branch renames and copies on a detached head", () => {
    const map = reasons({ ...CLEAN, detached: true, branch: "detached", upstream: undefined })
    expect(map.get("branch-rename")).toBe("detached HEAD")
    expect(map.get("copy-branch")).toBe("detached HEAD")
    expect(map.get("publish")).toBe("detached HEAD")
  })

  it("needs gh and a GitHub remote for the PR actions", () => {
    expect(reasons(CLEAN, false).get("pr-create")).toBe("gh not installed")
    const noGithub = reasons({ ...CLEAN, slug: undefined, remoteUrl: "git@gitlab.com:group/project.git" })
    expect(noGithub.get("pr-view")).toBe("not a GitHub remote")
    expect(noGithub.get("open-remote")).toBeUndefined()
  })

  it("needs an origin remote to fetch or publish", () => {
    const map = reasons({ ...CLEAN, remoteUrl: undefined, slug: undefined, upstream: undefined })
    expect(map.get("fetch")).toBe("no origin remote")
    expect(map.get("publish")).toBe("no origin remote")
    expect(map.get("open-remote")).toBe("no origin remote")
  })

  it("marks the history-rewriting actions as dangerous", () => {
    const danger = buildRepoActions(CLEAN, { gh: true })
      .filter((action) => action.danger)
      .map((action) => action.id)
      .sort()
    expect(danger).toEqual(["amend", "branch-delete", "discard", "push-force"])
  })

  it("cannot amend a repository without commits", () => {
    expect(reasons({ ...CLEAN, lastCommit: undefined }).get("amend")).toBe("no commits yet")
  })
})

import { describe, expect, it } from "bun:test"
import {
  dirtyCount,
  formatAheadBehind,
  formatDirty,
  isClean,
  parseLastCommit,
  parseRemoteSlug,
  parseStatus,
  remoteWebUrl,
  runErrorMessage,
  type RepoStatus,
} from "@tui/routes/workspace/repo-status"

const PORCELAIN = [
  "# branch.oid 1a2b3c4d",
  "# branch.head live-main",
  "# branch.upstream origin/live-main",
  "# branch.ab +3 -2",
  "1 M. N... 100644 100644 100644 aaa bbb packages/tui/src/app.tsx",
  "1 .M N... 100644 100644 100644 ccc ddd packages/tui/src/routes/workspace/index.tsx",
  "1 MM N... 100644 100644 100644 eee fff packages/tui/src/util/keys.ts",
  "2 R. N... 100644 100644 100644 ggg hhh R100 new.ts\told.ts",
  "u UU N... 100644 100644 100644 100644 iii jjj kkk conflicted.ts",
  "? untracked-one.ts",
  "? untracked-two.ts",
  "! ignored.log",
  "",
].join("\n")

describe("parseStatus", () => {
  const parsed = parseStatus(PORCELAIN)

  it("reads the branch header", () => {
    expect(parsed.branch).toBe("live-main")
    expect(parsed.detached).toBe(false)
    expect(parsed.upstream).toBe("origin/live-main")
    expect(parsed.ahead).toBe(3)
    expect(parsed.behind).toBe(2)
  })

  it("counts a file in both the index and the worktree once per side", () => {
    // `MM` is staged *and* unstaged; `R.` is a staged rename only.
    expect(parsed.dirty.staged).toBe(3)
    expect(parsed.dirty.unstaged).toBe(2)
    expect(parsed.dirty.untracked).toBe(2)
    expect(parsed.dirty.conflicts).toBe(1)
    expect(dirtyCount(parsed.dirty)).toBe(8)
  })

  it("ignores ignored files", () => {
    expect(parseStatus("! whatever.log\n").dirty).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
    })
  })

  it("reports a detached head as detached", () => {
    const detached = parseStatus("# branch.oid abc\n# branch.head (detached)\n")
    expect(detached.detached).toBe(true)
    expect(detached.branch).toBe("detached")
    expect(detached.upstream).toBeUndefined()
  })

  it("survives empty output", () => {
    const empty = parseStatus("")
    expect(empty.branch).toBe("")
    expect(dirtyCount(empty.dirty)).toBe(0)
  })
})

describe("parseRemoteSlug", () => {
  it("handles ssh, https and trailing .git", () => {
    expect(parseRemoteSlug("git@github.com:nikomatt69/nikcli.git")).toBe("nikomatt69/nikcli")
    expect(parseRemoteSlug("https://github.com/nikomatt69/nikcli")).toBe("nikomatt69/nikcli")
    expect(parseRemoteSlug("https://github.com/nikomatt69/nikcli.git")).toBe("nikomatt69/nikcli")
  })

  it("returns nothing for a non-GitHub remote", () => {
    expect(parseRemoteSlug("git@gitlab.com:group/project.git")).toBeUndefined()
    expect(parseRemoteSlug("")).toBeUndefined()
  })
})

describe("remoteWebUrl", () => {
  it("builds a browser URL for GitHub and passes through plain https", () => {
    expect(remoteWebUrl("git@github.com:nikomatt69/nikcli.git")).toBe("https://github.com/nikomatt69/nikcli")
    expect(remoteWebUrl("https://gitlab.com/group/project.git")).toBe("https://gitlab.com/group/project")
  })

  it("has no URL for ssh on another host", () => {
    expect(remoteWebUrl("git@gitlab.com:group/project.git")).toBeUndefined()
    expect(remoteWebUrl(undefined)).toBeUndefined()
  })
})

describe("formatting", () => {
  it("shows only the non-zero side of the drift", () => {
    expect(formatAheadBehind(0, 0)).toBe("")
    expect(formatAheadBehind(2, 0)).toBe("↑2")
    expect(formatAheadBehind(0, 5)).toBe("↓5")
    expect(formatAheadBehind(2, 5)).toBe("↑2 ↓5")
  })

  it("summarises the working tree", () => {
    expect(formatDirty({ staged: 0, unstaged: 0, untracked: 0, conflicts: 0 })).toBe("clean")
    expect(formatDirty({ staged: 1, unstaged: 2, untracked: 3, conflicts: 4 })).toBe(
      "4 conflicted · 1 staged · 2 changed · 3 untracked",
    )
  })
})

describe("isClean", () => {
  const base: RepoStatus = {
    directory: "/tmp/repo",
    name: "repo",
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    stashes: 0,
    dirty: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
  }

  it("treats a missing or broken repository as clean", () => {
    expect(isClean(undefined)).toBe(true)
    expect(isClean({ ...base, error: "not a git repository" })).toBe(true)
  })

  it("is false as soon as anything is dirty", () => {
    expect(isClean(base)).toBe(true)
    expect(isClean({ ...base, dirty: { ...base.dirty, untracked: 1 } })).toBe(false)
  })
})

describe("parseLastCommit", () => {
  it("splits the three unit-separated fields", () => {
    expect(parseLastCommit("abc1234\x1ffix: the thing\x1f2 hours ago")).toEqual({
      hash: "abc1234",
      subject: "fix: the thing",
      relative: "2 hours ago",
    })
  })

  it("returns nothing for an empty log", () => {
    expect(parseLastCommit("")).toBeUndefined()
    expect(parseLastCommit(undefined)).toBeUndefined()
  })
})

describe("runErrorMessage", () => {
  it("prefers the first line of stderr", () => {
    expect(runErrorMessage({ stdout: "", stderr: "fatal: no upstream\nhint: set one", exitCode: 1 })).toBe(
      "fatal: no upstream",
    )
  })

  it("falls back to stdout, then to the exit code", () => {
    expect(runErrorMessage({ stdout: "nothing to commit", stderr: "", exitCode: 1 })).toBe("nothing to commit")
    expect(runErrorMessage({ stdout: "", stderr: "", exitCode: 128 })).toBe("exited with 128")
  })
})

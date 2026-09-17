import { describe, it, expect, mock } from "bun:test"
import { loadSessionDiff } from "./load"
import type { Host } from "../host/shell"

describe("loadSessionDiff", () => {
  it("loads and parses small diff", async () => {
    const host: Host = {
      run: mock(async (cmd, args) => {
        if (args.includes("--shortstat")) {
          return { code: 0, stdout: " 1 file changed, 2 insertions(+), 1 deletion(-)", stderr: "" }
        }
        if (args.includes("--cached") && !args.includes("--name-status")) {
          if (args.includes("-A")) return { code: 0, stdout: "", stderr: "" } // for git add -A
          return {
            code: 0,
            stdout: `diff --git a/test b/test\n--- a/test\n+++ b/test\n@@ -1,1 +1,2 @@\n-a\n+b\n+c`,
            stderr: ""
          }
        }
        return { code: 0, stdout: "", stderr: "" }
      })
    } as any

    const diff = await loadSessionDiff({ host, cwd: "/test", baseRef: "main" })
    expect(diff.error).toBeUndefined()
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(1)
    expect(diff.truncated).toBe(false)
    expect(diff.files.length).toBe(1)
    expect(diff.files[0].path).toBe("test")
  })

  it("truncates large diffs", async () => {
    const host: Host = {
      run: mock(async (cmd, args) => {
        if (args.includes("--shortstat")) {
          return { code: 0, stdout: " 10 files changed, 2500 insertions(+), 10 deletions(-)", stderr: "" }
        }
        if (args.includes("--name-status")) {
          return { code: 0, stdout: "M\tfile1\nA\tfile2\n", stderr: "" }
        }
        return { code: 0, stdout: "", stderr: "" }
      })
    } as any

    const diff = await loadSessionDiff({ host, cwd: "/test", baseRef: "main" })
    expect(diff.error).toBeUndefined()
    expect(diff.added).toBe(2500)
    expect(diff.removed).toBe(10)
    expect(diff.truncated).toBe(true)
    expect(diff.files.length).toBe(2)
    expect(diff.files[0].path).toBe("file1")
    expect(diff.files[1].path).toBe("file2")
    expect(diff.files[0].hunks.length).toBe(0)
  })

  /*
   * The case this got wrong first: inside a session worktree `.git` is a file,
   * so the throwaway index has to be placed where git says, not where a normal
   * repository would keep it.
   */
  it("asks git where to put the throwaway index, and stages into it", async () => {
    const calls: { args: string[]; env?: Record<string, string> }[] = []
    const host: Host = {
      run: mock(async (_cmd: string, args: string[], _cwd?: string, env?: Record<string, string>) => {
        calls.push({ args, env })
        if (args.includes("--git-path")) {
          return { code: 0, stdout: "C:/repo/.git/worktrees/s1/ade-review-index\n", stderr: "" }
        }
        if (args.includes("--shortstat")) {
          return { code: 0, stdout: " 1 file changed, 1 insertion(+)", stderr: "" }
        }
        return { code: 0, stdout: "", stderr: "" }
      }),
    } as unknown as Host

    await loadSessionDiff({ host, cwd: "/tree", baseRef: "main" })

    const stage = calls.find((call) => call.args[0] === "add")
    expect(stage?.env?.GIT_INDEX_FILE).toBe("C:/repo/.git/worktrees/s1/ade-review-index")
    // The session's own checkouts must not end up inside its review.
    expect(stage?.args).toContain(":!.ade-trees")
  })

  it("reports a folder that is not a repository instead of throwing", async () => {
    const host: Host = {
      run: mock(async () => ({ code: 128, stdout: "", stderr: "not a git repository" })),
    } as unknown as Host

    const diff = await loadSessionDiff({ host, cwd: "/tmp", baseRef: "main" })
    expect(diff.error).toBe("Questa cartella non è un repository git.")
    expect(diff.files).toEqual([])
  })
})

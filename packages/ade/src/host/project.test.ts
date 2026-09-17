import { describe, it, expect } from "bun:test"
import { discoverProject, openProject } from "./project"
import type { Host } from "./shell"

/** Minimal fake Host — only `run` and `pickDirectory` are needed here. */
function fakeHost(overrides: Partial<Host> = {}): Host {
  return {
    probe: async () => null,
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    spawn: async () => ({ kill: () => {}, write: () => {}, resize: () => {} }),
    readDir: async () => [],
    readTextFile: async () => ({ text: "", truncated: false, bytes: 0 }),
    currentDir: async () => "C:/",
    homeDir: async () => "C:/Users/test",
    exists: async () => false,
    pickDirectory: async () => undefined,
    ...overrides,
  }
}

describe("discoverProject", () => {
  it("a remote Space is known by its root, without running git or granting writes", async () => {
    const calls: string[] = []
    const host = fakeHost({
      run: async (cmd) => {
        calls.push(cmd)
        return { code: 0, stdout: "", stderr: "" }
      },
      allowWriteRoot: async (path) => {
        calls.push(`allow ${path}`)
      },
    })
    const p = await discoverProject(host, "ssh://niko@devbox:2222/srv/app")
    expect(p).toEqual({
      root: "ssh://niko@devbox:2222/srv/app",
      name: "app @ devbox",
      git: false,
      remote: { destination: "niko@devbox", port: 2222, dir: "/srv/app" },
    })
    expect(calls).toEqual([])
  })

  it("returns a git project when rev-parse succeeds", async () => {
    const host = fakeHost({
      run: async (_cmd, args) => {
        if (args.includes("--show-toplevel")) return { code: 0, stdout: "C:\\Users\\nik\\repo\n", stderr: "" }
        if (args.includes("--abbrev-ref")) return { code: 0, stdout: "main\n", stderr: "" }
        return { code: 1, stdout: "", stderr: "" }
      },
    })
    const p = await discoverProject(host, "C:/Users/nik/repo/sub")
    expect(p.root).toBe("C:/Users/nik/repo")
    expect(p.name).toBe("repo")
    expect(p.branch).toBe("main")
    expect(p.git).toBe(true)
  })

  it("handles detached HEAD", async () => {
    const host = fakeHost({
      run: async (_cmd, args) => {
        if (args.includes("--show-toplevel")) return { code: 0, stdout: "C:/repo\n", stderr: "" }
        if (args.includes("--abbrev-ref")) return { code: 0, stdout: "HEAD\n", stderr: "" }
        return { code: 1, stdout: "", stderr: "" }
      },
    })
    const p = await discoverProject(host, "C:/repo")
    expect(p.branch).toBeUndefined()
    expect(p.git).toBe(true)
  })

  it("falls back to startDir when not a git repo", async () => {
    const host = fakeHost() // run returns code 1 by default
    const p = await discoverProject(host, "C:\\Users\\nik\\plain-folder")
    expect(p.root).toBe("C:/Users/nik/plain-folder")
    expect(p.name).toBe("plain-folder")
    expect(p.git).toBe(false)
    expect(p.branch).toBeUndefined()
  })
})

describe("openProject", () => {
  it("returns undefined when the user cancels", async () => {
    const host = fakeHost()
    expect(await openProject(host)).toBeUndefined()
  })

  it("discovers the project for the chosen directory", async () => {
    const host = fakeHost({
      pickDirectory: async () => "C:/Users/nik/picked",
      run: async (_cmd, args) => {
        if (args.includes("--show-toplevel")) return { code: 0, stdout: "C:/Users/nik/picked\n", stderr: "" }
        if (args.includes("--abbrev-ref")) return { code: 0, stdout: "dev\n", stderr: "" }
        return { code: 1, stdout: "", stderr: "" }
      },
    })
    const p = await openProject(host)
    expect(p).toBeDefined()
    expect(p!.root).toBe("C:/Users/nik/picked")
    expect(p!.branch).toBe("dev")
  })
})

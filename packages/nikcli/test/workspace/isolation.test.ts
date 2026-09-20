import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * EOT-16 workspace isolation contract.
 *
 * Per `specs/effect-tui/16-workspace-isolation.md`:
 *  - A workspace is identified by a `wrk_…` id (`Schema.isStartsWith("wrk")`).
 *  - `WorkspaceRef` is the Effect scope that carries the workspace id.
 *  - The instance scope can pin a workspace via `locallyWorkspace`.
 *  - B31: workspaces on one directory currently share the `InstanceScope`
 *    resources; promoting workspace to its own scope is the open work.
 *
 * These structural tests pin the contract so a refactor cannot silently
 * break it. They read source and assert shape, not behavior — behavior is
 * pinned in `test/effect/instance-scope.test.ts` and `test/workspace/`.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const WORKSPACE_INDEX = path.join(REPO_ROOT, "packages", "nikcli", "src", "workspace", "index.ts")
const INSTANCE_SCOPE = path.join(REPO_ROOT, "packages", "nikcli", "src", "effect", "instance-scope.ts")
const INSTANCE_REF = path.join(REPO_ROOT, "packages", "nikcli", "src", "effect", "instance-ref.ts")

function read(file: string): string {
  return readFileSync(file, "utf8")
}

describe("EOT-16 workspace id prefix", () => {
  it("workspace ids start with `wrk` enforced by Schema.isStartsWith", () => {
    const source = read(WORKSPACE_INDEX)
    expect(source).toMatch(/wrk/)
    expect(source).toMatch(/isStartsWith\(\s*["']wrk["']\s*\)/)
  })
})

describe("EOT-16 WorkspaceRef boundary", () => {
  it("WorkspaceRef is exported from effect/instance-ref.ts", () => {
    const source = read(INSTANCE_REF)
    expect(source).toMatch(/export.*WorkspaceRef/)
  })

  it("locallyWorkspace is exported and pins the workspace id", () => {
    const source = read(INSTANCE_REF)
    expect(source).toMatch(/export.*locallyWorkspace/)
    expect(source).toMatch(/WorkspaceRef/)
  })

  it("InstanceScope.with pins a WorkspaceRef when workspaceID is present", () => {
    const source = read(INSTANCE_SCOPE)
    // The bridge must consult `input.workspaceID` and, when present, wrap
    // the effect in `locallyWorkspace({ id: input.workspaceID }, ...)`.
    expect(source).toMatch(/input\.workspaceID/)
    expect(source).toMatch(/locallyWorkspace\(\s*\{\s*id:\s*input\.workspaceID/)
  })

  it("the header comment cites EOT-16 and names the open B31 gap", () => {
    const source = read(INSTANCE_SCOPE)
    expect(source).toMatch(/16-workspace-isolation/)
    // The comment must say workspaces are a value carried alongside the
    // instance today, so a future refactor that promotes them to a scope
    // updates the comment too.
    expect(source).toMatch(/value carried alongside/i)
  })
})

describe("EOT-16 workspace lifecycle ownership", () => {
  it("workspace/index.ts does NOT register its own SIGINT/SIGTERM handlers", () => {
    // Connection lifecycle owns process.once("SIGINT"...) — workspace itself
    // must not double-handle. A duplicate handler would run finalizers twice.
    const source = read(WORKSPACE_INDEX)
    expect(source).not.toMatch(/process\.once\(\s*["']SIGINT["']/)
    expect(source).not.toMatch(/process\.once\(\s*["']SIGTERM["']/)
  })

  it("workspace-server/server.ts hosts a per-workspace Bun.serve", () => {
    // A workspace gets its own listener; the main server is on 4096,
    // this is the per-workspace container listener.
    const wsServer = path.join(REPO_ROOT, "packages", "nikcli", "src", "workspace", "workspace-server", "server.ts")
    const source = read(wsServer)
    expect(source).toMatch(/Bun\.serve/)
    // The per-workspace server provides WorkspaceContext + withInstanceAsync
    // on POST — a remote workspace is an instance, not the engine itself.
    expect(source).toMatch(/WorkspaceContext\.provide/)
    expect(source).toMatch(/withInstanceAsync/)
  })
})

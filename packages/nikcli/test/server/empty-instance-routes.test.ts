import { afterAll, describe, expect, it } from "bun:test"
import { preserveTestEnv } from "../helpers/env"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * A fresh install must not 400.
 *
 * Both open-payload bugs EOT-10 inherited had the same shape and the same
 * victim: a handler wrote `undefined` into a field the response schema declared
 * with `Schema.optionalKey`, the encoder rejected a *present* `undefined`, and
 * the route answered an empty 400 — to exactly the users whose state was empty.
 * `GET /tui/config` did it for every user with no plugins, and the TUI read the
 * empty body as a config with no keybinds. Nothing was logged.
 *
 * Neither a type nor a schema catches that: the schema is right and the handler
 * type-checks. It only shows on the wire, on an instance with nothing in it —
 * which is the one state no fixture usually bothers to build. So this boots
 * one and calls every parameterless GET the contract declares.
 *
 * `specs/effect-tui/10-contracts-errors-security.md`.
 */

const home = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-empty-routes-"))
process.env.NIKCLI_TEST_HOME = home
process.env.NIKCLI_TEST_MODE = "1"
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
process.env.XDG_DATA_HOME = path.join(home, "data")
process.env.XDG_CACHE_HOME = path.join(home, "cache")
process.env.XDG_CONFIG_HOME = path.join(home, "config")
process.env.XDG_STATE_HOME = path.join(home, "state")

// `preload.ts` deletes every `NIKCLI_*` / `XDG_*` before the first test, so a
// module-scope assignment that is not declared here is silently reverted and
// the suite falls back to the real user database. `env-discipline.test.ts`
// fails the run when one is missing — it was, from the commit that added this
// file until 2026-09-21.
preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_TEST_MODE",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "NIKCLI_DISABLE_MODELS_FETCH",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { publicRoutes } = await import("@/server/httpapi/inventory")
const { Server } = await import("@/server/server")
const { Instance } = await import("@/project/instance")

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined)
})

/** Routes that never answer, or answer only when something happens elsewhere. */
const STREAMING = /\/event$|\/stream$|\/control\/next$|\/sse$|\/watch$/

/**
 * Routes whose 400 is the *request* being incomplete, not the response failing
 * to encode — they declare required query parameters this probe does not
 * supply. Listed rather than skipped by pattern so a new 400 has to be looked
 * at: the whole point is that an encoder failure looks identical from here.
 */
const REQUIRES_QUERY: Record<string, string> = {
  "/find": "required `pattern`",
  "/find/file": "required `query`",
  "/find/symbol": "required `query`",
  "/file": "required `path`",
  "/file/content": "required `path`",
  "/file/status": "required `path`",
  "/experimental/tool": "required tool id",
  "/experimental/managed-worktree/children": "required worktree id",
  "/experimental/managed-worktree/ancestors": "required worktree id",
  "/vcs/diff/raw": "required `ref`",
  "/mobile/memory/search": "required `query`",
  "/sync/outbox": "required projectID",
}

/** Routes that answer an auth challenge before any handler runs. */
const REQUIRES_AUTH: Record<string, string> = {
  "/mobile/github/repos": "GitHub token, absent on a fresh install",
}

async function call(pathname: string): Promise<number> {
  try {
    const response = (await Promise.race([
      Server.fetch(new Request(`http://localhost:4096${pathname}`, { method: "GET" })),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
    ])) as Response
    await response.body?.cancel().catch(() => undefined)
    return response.status
  } catch (error) {
    return String(error).includes("timeout") ? -1 : -2
  }
}

describe("every parameterless GET on an empty instance (EOT-10)", () => {
  const routes = publicRoutes()
    .filter((route) => route.method.toUpperCase() === "GET")
    .filter((route) => !route.path.includes("{"))
    .filter((route) => !STREAMING.test(route.path))
    .map((route) => route.path)
    .sort()

  it("finds a meaningful number of routes to call", () => {
    // Guards the failure mode of a gate like this: an inventory that stops
    // matching leaves a test that passes because it checked nothing.
    expect(routes.length).toBeGreaterThan(80)
  })

  it("answers without an encoder failure, a hang, or a throw", async () => {
    const unexpected: string[] = []
    for (const route of routes) {
      const status = await call(route)
      if (status === -1) unexpected.push(`${route}: never answered`)
      else if (status === -2) unexpected.push(`${route}: threw`)
      else if (status === 400 && !(route in REQUIRES_QUERY)) {
        // The signature of the bug: an empty 400 on a route that was given a
        // complete request. Either the response failed to encode, or the
        // route grew a required parameter and belongs in REQUIRES_QUERY.
        unexpected.push(`${route}: 400 with a complete request`)
      } else if (status === 401 && !(route in REQUIRES_AUTH)) {
        unexpected.push(`${route}: 401 without a declared reason`)
      } else if (status >= 500) {
        unexpected.push(`${route}: ${status}`)
      }
    }
    expect(unexpected).toEqual([])
  }, 240_000)

  it("keeps the exemption lists honest", () => {
    // An exemption for a route that no longer exists hides the next one that
    // starts failing under the same name.
    const known = new Set(routes)
    const stale = [...Object.keys(REQUIRES_QUERY), ...Object.keys(REQUIRES_AUTH)].filter((p) => !known.has(p))
    expect(stale).toEqual([])
  })
})

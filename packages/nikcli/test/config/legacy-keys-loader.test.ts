import { preserveTestEnv } from "../helpers/env"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * The three top-level legacy keys, through the real loader.
 *
 * `test/config/legacy-keys.test.ts` covers the mappings that are pure — the
 * agent schema's `.transform()` and `Policy.legacyProviderStatements`. These
 * three (`mode` → `agent`, top-level `tools` → `permission`, `autoshare` →
 * `share`) run inside the file-loading pipeline, so they cannot be reached by
 * parsing a literal: they need a document on disk and an instance to read it.
 * That is the gap `specs/v2/config.md`'s `Missing` row named, and this file is
 * it.
 *
 * The document goes in the **global** config directory. `loadState` merges
 * `global()` unconditionally, before project files, so this exercises the whole
 * pipeline without involving `findUp` — one fewer thing that can make a case
 * pass for a reason it did not intend.
 *
 * Environment first, dynamic imports after. Several modules here read flags at
 * import time (`specs/effect-tui/12-identity-onboarding-auth.md` — eight tests
 * failed for a year on exactly that ordering), and `bun test` shares one module
 * registry across a run, so a static import would take whichever home the first
 * file to load it happened to set.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-legacy-keys-home-"))
process.env.NIKCLI_TEST_HOME = testHome
// findUp is not under test here; the global document is.
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
// `installDependencies` runs `bun install` in a config directory that has no
// node_modules. A temp directory never does, so without this the suite would
// reach the network to answer a question about key renaming.
process.env.NIKCLI_SKIP_PLUGIN_INSTALL = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "NIKCLI_SKIP_PLUGIN_INSTALL",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { InstanceScope } = await import("@/effect")
const { Config } = await import("@/config/config")
const { Global } = await import("@nikcli-ai/util/global")
const { Instance } = await import("@/project/instance")

const projectDirs: string[] = []

/**
 * Write the global `nikcli.json` and read it back through a fresh instance.
 *
 * A fresh project directory per case on purpose: `Config` is per-instance state,
 * so reusing one directory would serve the first case's cached document to the
 * second and every assertion after it would be about the wrong file.
 */
async function loadGlobal(document: Record<string, unknown>) {
  await fs.mkdir(Global.Path.config, { recursive: true })
  await fs.writeFile(path.join(Global.Path.config, "nikcli.json"), JSON.stringify(document))

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-legacy-keys-project-"))
  const directory = await fs.realpath(dir)
  projectDirs.push(directory)

  return Effect.runPromise(
    InstanceScope.with(
      { directory },
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.get()
      }).pipe(Effect.provide(Config.defaultLayer)),
    ),
  )
}

describe("autoshare → share", () => {
  it('maps `autoshare: true` to `share: "auto"`', async () => {
    const config = await loadGlobal({ autoshare: true })

    expect(config.share).toBe("auto")
  })

  it("leaves an explicit `share` alone", async () => {
    // The guard is `!result.share`, so this is the half that breaks if someone
    // simplifies the condition away: a user who set both would silently get the
    // legacy answer.
    const config = await loadGlobal({ autoshare: true, share: "manual" })

    expect(config.share).toBe("manual")
  })

  it("maps nothing when `autoshare` is false", async () => {
    // `autoshare: false` is not "share manually", it is the absence of the
    // opt-in — mapping it would invent a setting the user never chose.
    const config = await loadGlobal({ autoshare: false })

    expect(config.share).toBeUndefined()
  })
})

describe("mode → agent", () => {
  it("moves a legacy mode into `agent` and marks it primary", async () => {
    const config = await loadGlobal({
      mode: { reviewer: { prompt: "review it", temperature: 0.2 } },
    })

    expect(config.agent?.reviewer).toMatchObject({ prompt: "review it", mode: "primary" })
  })

  it("does not drop an agent that was already declared under the new key", async () => {
    const config = await loadGlobal({
      mode: { reviewer: { prompt: "legacy" } },
      agent: { builder: { prompt: "new" } },
    })

    expect(config.agent?.builder).toBeTruthy()
    expect(config.agent?.reviewer).toBeTruthy()
  })
})

describe("top-level tools → permission", () => {
  it("maps true to allow and false to deny", async () => {
    const config = await loadGlobal({ tools: { bash: true, webfetch: false } })

    expect(config.permission).toMatchObject({ bash: "allow", webfetch: "deny" })
  })

  it("collapses the edit family onto one `edit` permission", async () => {
    // Same coupling as the agent-level mapping and as
    // `PermissionRuleset.TOOL_PERMISSION` at evaluation time. Three keys in,
    // one out.
    const config = await loadGlobal({ tools: { write: false, patch: false, multiedit: false } })

    expect(config.permission).toMatchObject({ edit: "deny" })
    expect(config.permission).not.toHaveProperty("write")
  })

  it("lets an explicit `permission` win over the legacy `tools` it overlaps", async () => {
    // The merge is `mergeDeep(perms, result.permission)` — legacy first, new on
    // top. Reversing those arguments compiles, keeps every other case green,
    // and silently makes the deprecated key authoritative.
    const config = await loadGlobal({ tools: { bash: false }, permission: { bash: "allow" } })

    expect(config.permission).toMatchObject({ bash: "allow" })
  })
})

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

afterAll(async () => {
  // Teardown of temp directories, not an assertion: Windows can hold a handle
  // for a moment after disposal and `force` only swallows ENOENT.
  for (const dir of [...projectDirs, testHome]) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

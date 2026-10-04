import { preserveTestEnv } from "../helpers/env"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { afterAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { Plugin } from "@/plugin"
import { Instance } from "@/project/instance"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"

/**
 * The gadgets plugin through nikcli's own loader.
 *
 * `packages/gadget-plugin` has its own suite, but that one imports the plugin
 * directly. What only this file can show is that nikcli resolves it the way a
 * user's `nikcli.json` would — as a `file://` plugin, importing
 * `@nikcli-ai/plugin/tool` and `@nikcli-ai/gadget/protocol` from its own
 * location — and that the `gadget` tool it contributes is the one a session
 * would be handed.
 */
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-gadgets-home-"))
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-gadgets-state-"))
const pluginDir = path.resolve(import.meta.dir, "../../../gadget-plugin")

process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.NIKCLI_GADGET_STATE = path.join(stateDir, "device")
// `plugin` in nikcli.json is a list of bare specifiers, so the plugin is configured through its environment.
process.env.NIKCLI_CONFIG_CONTENT = JSON.stringify({
  plugin: [pathToFileURL(path.join(pluginDir, "src", "index.ts")).href],
})
process.env.NIKCLI_GADGET_PORT = "0"
process.env.NIKCLI_GADGET_HOST = "127.0.0.1"
process.env.NIKCLI_GADGET_BRIDGE_FILE = path.join(stateDir, "devices.json")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "NIKCLI_GADGET_STATE",
  "NIKCLI_CONFIG_CONTENT",
  "NIKCLI_GADGET_PORT",
  "NIKCLI_GADGET_HOST",
  "NIKCLI_GADGET_BRIDGE_FILE",
])

const projectDirs: string[] = []

async function withProject<T>(fn: () => Promise<T>): Promise<T> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-gadgets-project-"))
  projectDirs.push(projectDir)
  return Instance.provide({ directory: projectDir, fn })
}

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(projectDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await fs.rm(testHome, { recursive: true, force: true })
  await fs.rm(stateDir, { recursive: true, force: true })
})

type Execute = (
  args: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<{ output: string; metadata?: Record<string, unknown> }>

describe("gadgets plugin loaded by nikcli", () => {
  it("contributes the gadget tool, and a real SDK gadget can pair and run a command through it", async () => {
    await withProject(async () => {
      const hooks = await runPromiseWithLayer(
        Plugin.defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            return yield* plugin.list()
          }),
        ),
      )
      const tool = hooks.find((hook) => hook.tool?.gadget)?.tool?.gadget as unknown as { execute: Execute } | undefined
      expect(tool).toBeDefined()

      const asks: Array<{ permission: string; patterns: string[] }> = []
      const ctx = {
        sessionID: "ses_gadgets",
        messageID: "msg_gadgets",
        callID: "call_gadgets",
        agent: "build",
        abort: new AbortController().signal,
        metadata() {},
        async progress() {},
        async ask(input: { permission: string; patterns: string[] }) {
          asks.push(input)
        },
      }

      const paired = await tool!.execute({ action: "pair" }, ctx)
      const { code, url } = paired.metadata as { code: string; url: string }
      expect(code).toMatch(/^\d{6}$/)

      // The SDK is not a dependency of nikcli, so it is read from its source rather than by package name.
      const { Gadget } = await import(path.resolve(pluginDir, "../gadget/linux/src/index.ts"))
      const gadget = new Gadget({ name: "loader-check", log: () => undefined })
      const pairing = await gadget.pair(url, code)
      const controller = new AbortController()
      const running = gadget.run({ signal: controller.signal, pairing }).catch(() => undefined)
      try {
        const started = Date.now()
        while (!(await tool!.execute({ action: "list" }, ctx)).output.includes("— online")) {
          if (Date.now() - started > 5_000) throw new Error("gadget did not come online")
          await Bun.sleep(20)
        }
        const ran = await tool!.execute(
          { action: "run", device: pairing.id, command: "system.run", args: { argv: ["echo", "through the loader"] } },
          ctx,
        )
        expect(ran.output).toContain("through the loader")
        expect(asks.map((ask) => ask.patterns[0])).toEqual(["pair", `${pairing.id}:system.run`])
        expect(asks.every((ask) => ask.permission === "gadget")).toBe(true)
      } finally {
        controller.abort()
        await running
      }
    })
  }, 30_000)
})

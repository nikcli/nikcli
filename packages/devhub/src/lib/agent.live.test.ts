/**
 * Live protocol check against the real local nikcli service and a real model.
 * Opt in with DEVHUB_LIVE=1 — it spends (free-tier) tokens and needs a running service.
 *
 *   DEVHUB_LIVE=1 DEVHUB_MODEL=minimax-coding-plan/MiniMax-M2 bun test src/lib/agent.live.test.ts
 */
import { expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"

const live = process.env.DEVHUB_LIVE === "1"
const state = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "nikcli")

if (live) {
  const reg = JSON.parse(readFileSync(join(state, "service.json"), "utf8")) as { url: string }
  const password = readFileSync(join(state, "service.password"), "utf8").trim()
  // The Rust proxy is replaced by plain fetch with the same Basic auth it would attach.
  mock.module("./native", () => ({
    errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    native: {
      api: async (req: { method: string; path: string; headers?: Record<string, string>; body?: string }) => {
        const t = performance.now()
        const res = await fetch(reg.url + req.path, {
          method: req.method,
          headers: { ...req.headers, authorization: `Basic ${Buffer.from(`nikcli:${password}`).toString("base64")}` },
          body: req.body,
        })
        return { status: res.status, headers: {}, body: await res.text(), elapsedMs: performance.now() - t }
      },
    },
  }))
}

test.skipIf(!live)(
  "the model follows the devhub-action protocol and the result round-trips",
  async () => {
    const { Agent, Gateway, agentLayer, gatewayLayer, textOf } = await import("./agent")
    const { ASSISTANT_TOOLS, SYSTEM_PROMPT, parseActions, wrapUserMessage, renderContext, execute, Host } =
      await import("./actions")
    const [providerID, modelID] = (process.env.DEVHUB_MODEL ?? "minimax-coding-plan/MiniMax-M2").split("/")

    const gw = gatewayLayer(() => "live")
    const agent = agentLayer(() => process.cwd()).pipe(Layer.provideMerge(gw))
    const host = Layer.succeed(
      Host,
      Host.of({
        navigate: () => undefined,
        snapshot: () => undefined,
        tests: async () => [],
        runs: () => [],
        runTask: async () => {
          throw new Error("not used")
        },
        writeScratch: async (n) => n,
        kill: async () => undefined,
        repoRoot: () => process.cwd(),
      }),
    )

    const program = Effect.gen(function* () {
      const a = yield* Agent
      const ctx = renderContext({ page: "overview", repo: process.cwd(), runs: [] })
      const reply = yield* a.ask({
        title: "[devhub] protocol test",
        system: SYSTEM_PROMPT,
        tools: ASSISTANT_TOOLS,
        model: { providerID, modelID },
        text: wrapUserMessage(ctx, "Check the nikcli service health by calling GET /global/health. Use an action."),
      })
      const parsed = yield* parseActions(textOf(reply))
      const first = parsed.find((p) => p.ok)
      if (!first || !first.ok) return { text: textOf(reply), parsed, result: undefined }
      const result = yield* execute(first.action).pipe(Effect.provide(Layer.mergeAll(host, gw, agent)))
      return { text: textOf(reply), parsed, result }
    })

    const out = await Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(agent, gw))))
    console.log("assistant said:\n" + out.text.slice(0, 600))
    expect(out.parsed.some((p) => p.ok)).toBe(true)
    expect(out.result?.output).toContain('"healthy":true')
  },
  180_000,
)

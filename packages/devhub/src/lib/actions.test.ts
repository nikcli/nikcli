import { expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent, Gateway, GatewayError } from "./agent"
import { Host, alwaysConfirm, execute, isSafe, parseActions, renderContext, stripActions, type Action } from "./actions"
import type { Snapshot } from "./native"

const snap = {
  at: 1,
  host: "h",
  os: "macOS",
  uptime: 100,
  cpuCount: 8,
  cpuUsage: 12.5,
  load: [1, 2, 3],
  memTotal: 16e9,
  memUsed: 8e9,
  swapTotal: 0,
  swapUsed: 0,
  procs: [
    {
      pid: 10,
      parent: 1,
      name: "nikcli",
      exe: null,
      cmd: "nikcli serve --service",
      cwd: null,
      category: "service",
      cpu: 1,
      rss: 90e6,
      virt: 1,
      runtime: 50,
      started: 0,
      status: "Run",
      readBytes: 0,
      writtenBytes: 0,
      threads: 4,
    },
    {
      pid: 11,
      parent: 10,
      name: "mcp",
      exe: null,
      cmd: "mcp",
      cwd: null,
      category: "child",
      cpu: 0,
      rss: 10e6,
      virt: 1,
      runtime: 10,
      started: 0,
      status: "Run",
      readBytes: 0,
      writtenBytes: 0,
      threads: 1,
    },
  ],
} as unknown as Snapshot

const navigated: string[] = []
const killed: number[] = []
const HostTest = Layer.succeed(
  Host,
  Host.of({
    navigate: (p) => void navigated.push(p),
    snapshot: () => snap,
    tests: async () => [{ package: "nikcli", path: "test/a.test.ts", size: 1, modified: 1 }],
    runs: () => [],
    runTask: async () => {
      throw new Error("not used")
    },
    writeScratch: async (n) => `.devhub/${n}`,
    kill: async (pid) => void killed.push(pid),
    repoRoot: () => "/repo",
  }),
)
const GatewayTest = Layer.succeed(
  Gateway,
  Gateway.of({
    raw: (req) => Effect.succeed({ status: 200, headers: {}, body: `{"echo":"${req.path}"}`, elapsedMs: 1 }),
    json: () => Effect.fail(new GatewayError({ message: "unused" })),
  }),
)
const unused = () => Effect.die("unused in this test")
const AgentTest = Layer.succeed(
  Agent,
  Agent.of({
    createSession: unused,
    exists: unused,
    prompt: unused,
    messages: unused,
    abort: unused,
    remove: unused,
    ask: unused,
  }),
)
const env = Layer.mergeAll(HostTest, GatewayTest, AgentTest)
const run = <A, E>(e: Effect.Effect<A, E, Host | Agent | Gateway>) => Effect.runPromise(e.pipe(Effect.provide(env)))

test("parses blocks, arrays, and rejects unknown or malformed actions without throwing", async () => {
  const text = [
    "Checking.",
    "```devhub-action",
    '{"action":"navigate","page":"tests"}',
    "```",
    "```devhub-action",
    '[{"action":"processes","limit":5},{"action":"rm_rf","path":"/"}]',
    "```",
    "```devhub-action",
    "{not json",
    "```",
  ].join("\n")
  const parsed = await Effect.runPromise(parseActions(text))
  expect(parsed.map((p) => p.ok)).toEqual([true, true, false, false])
  expect(parsed[0].ok && parsed[0].action).toEqual({ action: "navigate", page: "tests" })
  expect(parsed[2].ok).toBe(false)
  expect(!parsed[3].ok && parsed[3].error).toContain("not valid JSON")
  expect(stripActions(text)).toBe("Checking.")
})

test("rejects a bad page and a wrongly typed field", async () => {
  const parsed = await Effect.runPromise(
    parseActions(
      '```devhub-action\n{"action":"navigate","page":"nope"}\n```\n```devhub-action\n{"action":"kill","pid":"7"}\n```',
    ),
  )
  expect(parsed.every((p) => !p.ok)).toBe(true)
})

test("safety policy: reads run freely, writes ask, kill always confirms", () => {
  const a = (x: unknown) => x as Action
  expect(isSafe(a({ action: "snapshot" }))).toBe(true)
  expect(isSafe(a({ action: "http", path: "/doctor" }))).toBe(true)
  expect(isSafe(a({ action: "http", method: "POST", path: "/x" }))).toBe(false)
  expect(isSafe(a({ action: "run_tests", package: "nikcli" }))).toBe(false)
  expect(alwaysConfirm(a({ action: "kill", pid: 1 }))).toBe(true)
})

test("executes against the host port with real data", async () => {
  expect((await run(execute({ action: "navigate", page: "benchmarks" }))).title).toBe("Opened benchmarks")
  expect(navigated).toEqual(["benchmarks"])
  const procs = await run(execute({ action: "processes", category: "child" }))
  expect(procs.output).toContain("11\tchild")
  expect(procs.output).not.toContain("service")
  const http = await run(execute({ action: "http", path: "/global/health" }))
  expect(http.title).toBe("GET /global/health → 200")
  expect(http.output).toContain('"echo":"/global/health"')
  await run(execute({ action: "kill", pid: 11 }))
  expect(killed).toEqual([11])
})

test("reports precise failures as typed errors", async () => {
  const exit = await Effect.runPromiseExit(execute({ action: "run_tests", package: "ghost" }).pipe(Effect.provide(env)))
  expect(String(exit)).toContain('unknown package "ghost"')
  const missing = await Effect.runPromiseExit(
    execute({ action: "run_tests", package: "nikcli", files: ["test/zzz.test.ts"] }).pipe(Effect.provide(env)),
  )
  expect(String(missing)).toContain("no such test file")
})

test("context block carries the live state", () => {
  const ctx = renderContext({
    page: "processes",
    repo: "/repo",
    snapshot: snap,
    runs: [],
    service: { channel: "shared", url: "http://127.0.0.1:1", version: "1", pid: 10 },
  })
  expect(ctx).toContain("page: processes")
  expect(ctx).toContain("nikcli processes: 2")
  expect(ctx).toContain("nikcli serve --service")
})

test("gateway drops null and GET bodies instead of sending them", async () => {
  const sent: { method: string; body?: string; headers?: Record<string, string> }[] = []
  mock.module("./native", () => ({
    errorText: String,
    native: {
      api: async (req: { method: string; body?: string; headers?: Record<string, string> }) => {
        sent.push(req)
        return { status: 200, headers: {}, body: "{}", elapsedMs: 1 }
      },
    },
  }))
  const { gatewayLayer, Gateway: G } = await import("./agent")
  const layer = gatewayLayer(() => "http://x")
  const call = (method: string, body: unknown) =>
    Effect.runPromise(G.use((g) => g.raw({ method, path: "/p", body })).pipe(Effect.provide(layer)))
  await call("GET", null)
  await call("GET", { a: 1 })
  await call("POST", null)
  await call("POST", { a: 1 })
  expect(sent.map((r) => r.body)).toEqual([undefined, undefined, undefined, '{"a":1}'])
  expect(sent[3].headers?.["content-type"]).toBe("application/json")
  expect(sent[0].headers?.["content-type"]).toBeUndefined()
})

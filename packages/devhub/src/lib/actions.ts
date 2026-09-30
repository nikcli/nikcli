import { Context, Data, Effect, Schema } from "effect"
import { Agent, Gateway, GatewayError, type ModelRef } from "./agent"
import { runModelBench, summarize } from "./modelbench"
import type { ProcCategory, Snapshot, TestFile } from "./native"
import type { Run } from "./tasks"
import { bytes, duration, ms, pct } from "./format"

/**
 * What the chat assistant can do inside DevHub.
 *
 * The agent answers in prose and may append fenced ```devhub-action blocks holding JSON. Each block
 * is decoded against `ActionSchema` (so a malformed or unknown action is reported back to the model,
 * never executed), then run through `execute` against the `Host` port — the app's real state and
 * tools, not a copy. Results flow back to the model as the next turn.
 */

export const PAGES = [
  "overview",
  "processes",
  "tests",
  "benchmarks",
  "playground",
  "telemetry",
  "manage",
  "api",
  "activity",
  "system",
  "settings",
] as const
export type PageId = (typeof PAGES)[number]

const Page = Schema.Literals(PAGES)
const Model = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })

export const ActionSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal("navigate"), page: Page }),
  Schema.Struct({ action: Schema.Literal("snapshot") }),
  Schema.Struct({
    action: Schema.Literal("processes"),
    category: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ action: Schema.Literal("runs"), limit: Schema.optional(Schema.Number) }),
  Schema.Struct({
    action: Schema.Literal("list_tests"),
    package: Schema.String,
    filter: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("run_tests"),
    package: Schema.String,
    files: Schema.optional(Schema.Array(Schema.String)),
    pattern: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    action: Schema.Literal("run_script"),
    kind: Schema.Literals(["script", "test"]),
    name: Schema.optional(Schema.String),
    code: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("run_bench"),
    target: Schema.Literals(["suite", "probe"]),
    samples: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    action: Schema.Literal("http"),
    method: Schema.optional(Schema.String),
    path: Schema.String,
    body: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    action: Schema.Literal("model_bench"),
    prompt: Schema.String,
    models: Schema.Array(Model),
    runs: Schema.optional(Schema.Number),
    system: Schema.optional(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("kill"), pid: Schema.Number, force: Schema.optional(Schema.Boolean) }),
])
export type Action = typeof ActionSchema.Type
export type ActionName = Action["action"]

/** Read-only actions run without asking. Everything else needs a click (or auto-approve); `kill` always asks. */
const SAFE: ReadonlySet<ActionName> = new Set(["navigate", "snapshot", "processes", "runs", "list_tests"])
export const isSafe = (a: Action) =>
  SAFE.has(a.action) || (a.action === "http" && (a.method ?? "GET").toUpperCase() === "GET")
export const alwaysConfirm = (a: Action) => a.action === "kill"

export class ActionError extends Data.TaggedError("ActionError")<{ readonly message: string }> {}

export type ActionResult = { readonly title: string; readonly output: string }

// ── Host port ────────────────────────────────────────────────────────────────

export class Host extends Context.Service<
  Host,
  {
    readonly navigate: (page: PageId) => void
    readonly snapshot: () => Snapshot | undefined
    readonly tests: () => Promise<TestFile[]>
    readonly runs: () => readonly Run[]
    readonly runTask: (input: {
      kind: Run["kind"]
      label: string
      cwd: string
      args: string[]
      env?: Record<string, string>
      junit?: boolean
    }) => Promise<Run>
    readonly writeScratch: (name: string, content: string) => Promise<string>
    readonly kill: (pid: number, force: boolean) => Promise<void>
    readonly repoRoot: () => string | undefined
  }
>()("devhub/Host") {}

// ── parsing ──────────────────────────────────────────────────────────────────

export type ParsedAction = { readonly index: number; readonly raw: string } & (
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly error: string }
)

const FENCE = /```devhub-action[^\n]*\n([\s\S]*?)```/g

/** Extracts and validates every action block in an assistant message, in order. */
export function parseActions(text: string): Effect.Effect<ParsedAction[]> {
  const blocks = [...text.matchAll(FENCE)].map((m) => m[1].trim())
  return Effect.forEach(
    blocks.flatMap((b, i) => splitBlock(b).map((raw) => ({ raw, blockIndex: i }))),
    ({ raw }, index) =>
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: () => new ActionError({ message: "block is not valid JSON" }),
      }).pipe(
        Effect.flatMap((json) =>
          Schema.decodeUnknownEffect(ActionSchema)(json).pipe(
            Effect.mapError(
              (e) => new ActionError({ message: `unknown or malformed action: ${String(e.message).slice(0, 240)}` }),
            ),
          ),
        ),
        Effect.match({
          onFailure: (e): ParsedAction => ({ index, raw, ok: false, error: e.message }),
          onSuccess: (action): ParsedAction => ({ index, raw, ok: true, action }),
        }),
      ),
  )
}

/** A block may hold one object or an array of objects. */
function splitBlock(block: string): string[] {
  try {
    const v = JSON.parse(block)
    return Array.isArray(v) ? v.map((x) => JSON.stringify(x)) : [block]
  } catch {
    return [block]
  }
}

/** Text of a message without its action blocks, for display. */
export const stripActions = (text: string) =>
  text
    .replace(FENCE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

// ── execution ────────────────────────────────────────────────────────────────

const clip = (s: string, max = 6000) =>
  s.length <= max ? s : `…(${s.length - max} chars omitted)\n${s.slice(s.length - max)}`
const fail = (message: string) => Effect.fail(new ActionError({ message }))
const fromGateway = (e: GatewayError) => new ActionError({ message: e.message })

const tail = (run: Run, n = 60) =>
  clip(
    run.lines
      .slice(-n)
      .map((l) => l.line)
      .join("\n"),
  )

function runReport(run: Run): string {
  const s = run.summary
  const head = `${run.label}: ${run.status}${run.code !== undefined && run.code !== null ? ` (exit ${run.code})` : ""}${run.durationMs ? ` in ${duration(run.durationMs / 1000)}` : ""}`
  const counts = s ? `\n${s.pass} pass · ${s.fail} fail · ${s.skip} skip${s.files ? ` · ${s.files} files` : ""}` : ""
  const failed = run.results.filter((r) => r.status === "fail").slice(0, 25)
  const fails = failed.length ? `\nFailures:\n${failed.map((f) => `- ${f.name} (${f.file})`).join("\n")}` : ""
  const slow = [...run.results]
    .filter((r) => r.ms !== undefined)
    .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
    .slice(0, 5)
  const slowest = slow.length ? `\nSlowest: ${slow.map((r) => `${r.name} ${ms(r.ms!)}`).join("; ")}` : ""
  return `${head}${counts}${fails}${slowest}\n--- output tail ---\n${tail(run)}`
}

export function execute(action: Action): Effect.Effect<ActionResult, ActionError, Host | Agent | Gateway> {
  return Effect.gen(function* () {
    const host = yield* Host
    const safe = <A>(label: string, f: () => Promise<A>) =>
      Effect.tryPromise({
        try: f,
        catch: (e) => new ActionError({ message: `${label}: ${e instanceof Error ? e.message : String(e)}` }),
      })

    switch (action.action) {
      case "navigate":
        host.navigate(action.page)
        return { title: `Opened ${action.page}`, output: `Now showing the ${action.page} page.` }

      case "snapshot": {
        const s = host.snapshot()
        if (!s) return yield* fail("no system sample yet")
        return {
          title: "System snapshot",
          output: `host ${s.host ?? "?"} · ${s.os ?? ""} · up ${duration(s.uptime)}\nCPU ${pct(s.cpuUsage)} on ${s.cpuCount} cores · load ${s.load.map((l) => l.toFixed(2)).join(" ")}\nmemory ${bytes(s.memUsed)} / ${bytes(s.memTotal)} · swap ${bytes(s.swapUsed)} / ${bytes(s.swapTotal)}`,
        }
      }

      case "processes": {
        const s = host.snapshot()
        if (!s) return yield* fail("no system sample yet")
        const list = s.procs
          .filter((p) =>
            action.category
              ? p.category === (action.category as ProcCategory)
              : !["editor", "other"].includes(p.category),
          )
          .slice(0, Math.min(action.limit ?? 25, 60))
        return {
          title: `${list.length} processes`,
          output: list.length
            ? list
                .map(
                  (p) =>
                    `${p.pid}\t${p.category}\t${pct(p.cpu)}\t${bytes(p.rss)}\t${duration(p.runtime)}\t${clip(p.cmd || p.name, 140)}`,
                )
                .join("\n")
            : "no matching processes",
        }
      }

      case "runs": {
        const list = host.runs().slice(0, Math.min(action.limit ?? 10, 30))
        return {
          title: `${list.length} recent runs`,
          output: list.length
            ? list
                .map(
                  (r) =>
                    `${r.id}\t${r.kind}\t${r.status}\t${r.label}${r.summary ? `\t${r.summary.pass} pass/${r.summary.fail} fail` : ""}`,
                )
                .join("\n")
            : "no runs yet",
        }
      }

      case "list_tests": {
        const all = yield* safe("scan tests", () => host.tests())
        const q = (action.filter ?? "").toLowerCase()
        const list = all.filter((f) => f.package === action.package && (!q || f.path.toLowerCase().includes(q)))
        return {
          title: `${list.length} test files in ${action.package}`,
          output: clip(list.map((f) => f.path).join("\n") || "none (check the package name)"),
        }
      }

      case "run_tests": {
        const all = yield* safe("scan tests", () => host.tests())
        const known = new Set(all.map((f) => f.package))
        if (!known.has(action.package))
          return yield* fail(`unknown package "${action.package}". Known: ${[...known].join(", ")}`)
        const files = action.files ?? []
        const unknown = files.filter((f) => !all.some((t) => t.package === action.package && t.path === f))
        if (unknown.length) return yield* fail(`no such test file(s) in ${action.package}: ${unknown.join(", ")}`)
        const args =
          action.package === "nikcli" && !files.length && !action.pattern
            ? ["run", "test:ci"]
            : [
                "test",
                "--timeout",
                String(action.timeoutMs ?? 30000),
                ...(action.pattern ? ["-t", action.pattern] : []),
                ...files.map((f) => `./${f}`),
              ]
        const run = yield* safe("run tests", () =>
          host.runTask({
            kind: "test",
            label: `${action.package} · ${files.length ? `${files.length} file(s)` : "all"}${action.pattern ? ` · -t ${action.pattern}` : ""}`,
            cwd: `packages/${action.package}`,
            args,
            junit: true,
          }),
        )
        return { title: `${run.label}: ${run.status}`, output: runReport(run) }
      }

      case "run_script": {
        const root = host.repoRoot()
        if (!root) return yield* fail("repository not found")
        const name = `${(action.name ?? "chat").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "chat"}-${Date.now().toString(36)}.${action.kind === "test" ? "test.ts" : "ts"}`
        const rel = yield* safe("write script", () => host.writeScratch(name, action.code))
        const run = yield* safe("run script", () =>
          host.runTask({
            kind: action.kind === "test" ? "test" : "bench",
            label: `playground · ${name}`,
            cwd: "packages/nikcli",
            args: action.kind === "test" ? ["test", `../../${rel}`] : ["run", `../../${rel}`],
            junit: action.kind === "test",
          }),
        )
        return { title: `${run.label}: ${run.status}`, output: `${runReport(run)}\n(script saved at ${rel})` }
      }

      case "run_bench": {
        const env =
          action.target === "suite" ? { NIKCLI_BENCHMARK_SAVE: "1", NIKCLI_BENCHMARK_PER_FILE: "1" } : undefined
        const args =
          action.target === "suite"
            ? ["run", "test:bench"]
            : [
                "run",
                "script/perf-baseline.ts",
                "--samples",
                String(action.samples ?? 30),
                "--json",
                "../../.devhub/perf-live.json",
              ]
        const run = yield* safe("run benchmark", () =>
          host.runTask({
            kind: "bench",
            label: action.target === "suite" ? "Benchmark suite (test:bench)" : "Perf probe (live routes)",
            cwd: "packages/nikcli",
            args,
            env,
          }),
        )
        return { title: `${run.label}: ${run.status}`, output: runReport(run) }
      }

      case "http": {
        const gw = yield* Gateway
        const method = (action.method ?? "GET").toUpperCase()
        const started = performance.now()
        const res = yield* gw.raw({ method, path: action.path, body: action.body }).pipe(Effect.mapError(fromGateway))
        return {
          title: `${method} ${action.path} → ${res.status}`,
          output: `${res.status} in ${ms(performance.now() - started)}\n${clip(res.body, 5000)}`,
        }
      }

      case "model_bench": {
        if (!action.models.length) return yield* fail("model_bench needs at least one model")
        if (action.models.length > 6) return yield* fail("model_bench is limited to 6 models per call")
        const runs = Math.min(Math.max(action.runs ?? 3, 1), 10)
        const samples = yield* runModelBench({
          prompt: action.prompt,
          system: action.system,
          models: action.models as ModelRef[],
          runs,
          parallel: true,
        })
        const stats = summarize(samples)
        const lines = stats.map(
          (s) =>
            `${s.model.providerID}/${s.model.modelID}: ${s.ok}/${s.ok + s.failed} ok · median ${ms(s.medianMs)} · p95 ${ms(s.p95Ms)}${s.meanTps ? ` · ${s.meanTps.toFixed(1)} tok/s` : ""} · cost $${s.cost.toFixed(4)}`,
        )
        const errors = samples
          .filter((s) => s.error)
          .slice(0, 4)
          .map((s) => `! ${s.model.modelID}: ${s.error}`)
        return {
          title: `Model bench · ${stats.length} models × ${runs} runs`,
          output: [...lines, ...errors].join("\n"),
        }
      }

      case "kill": {
        yield* safe("kill", () => host.kill(action.pid, action.force ?? false))
        return {
          title: `Signalled pid ${action.pid}`,
          output: `${action.force ? "SIGKILL" : "SIGTERM"} sent to ${action.pid}.`,
        }
      }
    }
  })
}

// ── prompt + context ─────────────────────────────────────────────────────────

/**
 * Tools withheld from the chat assistant because DevHub actions do the same job inside the app
 * (and show it to the user). Source reading/editing tools stay available.
 */
export const ASSISTANT_TOOLS = { bash: false, monitor: false, webfetch: false } as const

export const SYSTEM_PROMPT = `You are the assistant built into nikcli DevHub, a local desktop admin dashboard and developer platform for nikcli. You operate DevHub for the user: every message starts with a <devhub-context> block holding the live state of the app (current page, service, host load, nikcli processes, recent runs). Treat it as ground truth and never invent numbers that are not in it or in an action result.

You are running as a nikcli agent, so you also have nikcli's own tools (shell, file read/edit, search). Use those ONLY for work on source code: reading repo files, writing or editing code. For everything DevHub can do itself — inspecting the service, processes or memory, running tests, running benchmarks, calling the nikcli API, comparing models, opening pages — do NOT use your shell or fetch tools: emit an action instead, so the user sees it run inside the app and the result is recorded there.

You can act by appending fenced action blocks to your reply. Each block is JSON (one object, or an array of objects) in a fence named devhub-action:

\`\`\`devhub-action
{"action":"run_tests","package":"nikcli","files":["test/util/x.test.ts"]}
\`\`\`

Actions:
- {"action":"navigate","page":"overview|processes|tests|benchmarks|playground|telemetry|manage|api|activity|system|settings"}
- {"action":"snapshot"} — host CPU, memory, swap, load
- {"action":"processes","category":"service|server|cli|test|dev|child","limit":25}
- {"action":"runs","limit":10} — recent test/benchmark/check runs
- {"action":"list_tests","package":"nikcli","filter":"session"}
- {"action":"run_tests","package":"nikcli","files":["test/a.test.ts"],"pattern":"regex for -t","timeoutMs":30000} — omit files to run the whole package (nikcli uses the sharded suite)
- {"action":"run_script","kind":"script|test","name":"short-name","code":"<complete Bun TypeScript file>"} — use this to CREATE A BENCHMARK FROM A DESCRIPTION: write a self-contained script that measures with performance.now() (warm-up, many iterations, print median/p95/min/max and ops/sec), or a bun:test file for kind "test". It runs with Bun inside packages/nikcli, so it can import repo code via relative paths.
- {"action":"run_bench","target":"suite|probe","samples":30} — the repo benchmark suite, or a live route latency probe
- {"action":"http","method":"GET","path":"/analytics/global","body":null} — request to the nikcli HttpApi
- {"action":"model_bench","prompt":"...","models":[{"providerID":"openai","modelID":"gpt-5.4"}],"runs":3} — same prompt across models; use model ids from the API (GET /provider)
- {"action":"kill","pid":123,"force":false} — terminate a nikcli process (the user is always asked to confirm)

Rules: prefer read-only actions first; explain in one or two sentences before the block; emit only the actions needed now and wait for the results, which arrive in the next message as [devhub results]. After results, summarise what they mean for the user — numbers, regressions, what to do next. Never run destructive or long actions the user did not ask for. Reply in the user's language.`

const OWN: ProcCategory[] = ["service", "server", "cli", "test", "dev", "child"]

export type ContextInput = {
  readonly page: string
  readonly service?: { channel: string; url: string; version: string; pid: number }
  readonly repo?: string
  readonly snapshot?: Snapshot
  readonly runs: readonly Run[]
  readonly packages?: string[]
}

export function renderContext(c: ContextInput): string {
  const s = c.snapshot
  const own = s?.procs.filter((p) => OWN.includes(p.category)) ?? []
  const lines = [
    `page: ${c.page}`,
    c.service
      ? `service: ${c.service.channel} v${c.service.version} at ${c.service.url} (pid ${c.service.pid})`
      : "service: none registered",
    `repo: ${c.repo ?? "not found"}`,
  ]
  if (s) {
    lines.push(
      `host: CPU ${pct(s.cpuUsage)} (${s.cpuCount} cores), memory ${bytes(s.memUsed)}/${bytes(s.memTotal)}, swap ${bytes(s.swapUsed)}`,
    )
    lines.push(
      `nikcli processes: ${own.length}, ${bytes(own.reduce((a, p) => a + p.rss, 0))} resident, ${pct(own.reduce((a, p) => a + p.cpu, 0))} CPU`,
    )
    for (const p of own.slice(0, 6))
      lines.push(`  ${p.pid} ${p.category} ${bytes(p.rss)} ${pct(p.cpu)} ${clip(p.cmd || p.name, 90)}`)
  }
  const running = c.runs.filter((r) => r.status === "running")
  if (running.length) lines.push(`running now: ${running.map((r) => r.label).join("; ")}`)
  const recent = c.runs.filter((r) => r.status !== "running").slice(0, 4)
  if (recent.length)
    lines.push(
      `recent runs: ${recent.map((r) => `${r.label} → ${r.status}${r.summary ? ` (${r.summary.pass} pass/${r.summary.fail} fail)` : ""}`).join("; ")}`,
    )
  if (c.packages?.length) lines.push(`test packages: ${c.packages.join(", ")}`)
  return lines.join("\n")
}

export const wrapUserMessage = (context: string, text: string) =>
  `<devhub-context>\n${context}\n</devhub-context>\n\n${text}`
export const CONTEXT_BLOCK = /<devhub-context>[\s\S]*?<\/devhub-context>\s*/
export const RESULTS_PREFIX = "[devhub results]"

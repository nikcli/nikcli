import { batch, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { native, type TaskEvent, type TaskLine } from "./native"
import { notifyIfBackground } from "./notify"
import { parseJunit, parseLine, type Line, type Summary, type TestResult } from "./bun-parse"

export type { Line, Summary, TestResult }

export type Run = {
  id: string
  kind: "test" | "bench" | "check" | "script"
  label: string
  cwd: string
  args: string[]
  startedAt: number
  endedAt?: number
  durationMs?: number
  code?: number | null
  status: "running" | "passed" | "failed" | "cancelled"
  lines: Line[]
  results: TestResult[]
  summary?: Summary
  currentFile: string
  /** Repo-relative junit report bun wrote for this run (per-test results). */
  junit?: string
}

const MAX_LINES = 20_000
const KEY = "devhub.runs.v1"

type Persisted = Omit<Run, "lines" | "results"> & { tail: Line[]; failed: TestResult[] }

function load(): Run[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Persisted[]
    return raw.map(({ tail, failed, ...r }) => ({
      ...r,
      lines: tail,
      results: failed,
      status: r.status === "running" ? "cancelled" : r.status,
    }))
  } catch {
    return []
  }
}

function persist(runs: Run[]) {
  try {
    const slim: Persisted[] = runs
      .filter((r) => r.status !== "running")
      .slice(0, 40)
      .map(({ lines, results, ...r }) => ({
        ...r,
        tail: lines.slice(-300),
        failed: results.filter((x) => x.status === "fail"),
      }))
    localStorage.setItem(KEY, JSON.stringify(slim))
  } catch {}
}

function createRunner() {
  const [runs, setRuns] = createStore<Run[]>(load())

  // Output events arrive per line; batch them per animation frame to keep the UI responsive.
  let queue: { id: string; stream: TaskLine["stream"]; line: string }[] = []
  let scheduled = false
  const flush = () => {
    scheduled = false
    const items = queue
    queue = []
    batch(() =>
      setRuns(
        produce((all) => {
          for (const e of items) {
            const run = all.find((r) => r.id === e.id)
            if (!run) continue
            const line = { stream: e.stream, line: e.line }
            if (run.lines.length >= MAX_LINES) run.lines.splice(0, 1000)
            run.lines.push(line)
            if (run.kind === "test") parseLine(run, line)
          }
        }),
      ),
    )
  }

  const onExit = (id: string, e: Extract<TaskEvent, { kind: "exit" }>) => {
    flush()
    setRuns(
      produce((all) => {
        const run = all.find((r) => r.id === id)
        if (!run) return
        run.endedAt = Date.now()
        run.durationMs = e.durationMs
        run.code = e.code
        run.status = e.cancelled ? "cancelled" : e.code === 0 ? "passed" : "failed"
      }),
    )
    persist(runs)
    const finish = () => {
      const done = runs.find((r) => r.id === id)
      if (done) {
        waiters.get(id)?.(done)
        if (done.status !== "cancelled") {
          const s = done.summary
          void notifyIfBackground(
            `${done.label} ${done.status}`,
            s
              ? `${s.pass} passed, ${s.fail} failed${done.durationMs ? ` in ${Math.round(done.durationMs / 1000)}s` : ""}`
              : `exit ${done.code ?? "?"}`,
          )
        }
      }
      waiters.delete(id)
    }
    const junit = runs.find((r) => r.id === id)?.junit
    if (!junit) return finish()
    // The junit file is the source of truth for per-test results; console output only has totals.
    void native
      .readRepoFile(junit)
      .then((xml) => {
        const parsed = parseJunit(xml)
        setRuns(
          produce((all) => {
            const run = all.find((r) => r.id === id)
            if (!run) return
            run.results = parsed.results
            run.summary = { ...parsed.summary, ms: run.summary?.ms }
          }),
        )
        persist(runs)
      })
      .catch(() => undefined)
      .finally(finish)
  }

  const waiters = new Map<string, (run: Run) => void>()
  const handle = (id: string) => (e: TaskEvent) => {
    if (e.kind === "lines") {
      for (const l of e.lines) queue.push({ id, ...l })
      if (!scheduled) ((scheduled = true), requestAnimationFrame(flush))
    } else onExit(id, e)
  }

  return {
    runs,
    active: () => runs.filter((r) => r.status === "running"),
    async start(input: {
      kind: Run["kind"]
      label: string
      cwd: string
      args: string[]
      env?: Record<string, string>
      junit?: boolean
    }) {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const junit = input.junit && input.args[0] === "test" ? `.devhub/junit-${id}.xml` : undefined
      const args = junit ? [...input.args, "--reporter=junit", `--reporter-outfile=../../${junit}`] : input.args
      const run: Run = {
        id,
        kind: input.kind,
        label: input.label,
        cwd: input.cwd,
        args,
        junit,
        startedAt: Date.now(),
        status: "running",
        lines: [],
        results: [],
        currentFile: "",
      }
      setRuns((all) => [run, ...all])
      try {
        await native.taskStart({ id, cwd: input.cwd, args, env: input.env }, handle(id))
      } catch (e) {
        setRuns(
          produce((all) => {
            const r = all.find((x) => x.id === id)
            if (!r) return
            r.status = "failed"
            r.endedAt = Date.now()
            r.lines.push({ stream: "stderr", line: String(e) })
          }),
        )
        throw e
      }
      return id
    },
    cancel: (id: string) => native.taskCancel(id),
    /** Resolves with the finished run (or immediately if it already finished). */
    waitFor: (id: string) =>
      new Promise<Run>((resolve) => {
        const run = runs.find((r) => r.id === id)
        if (run && run.status !== "running") return resolve(run)
        waiters.set(id, resolve)
      }),
    clear() {
      setRuns((all) => all.filter((r) => r.status === "running"))
      persist(runs)
    },
  }
}

export const runner = createRoot(createRunner)

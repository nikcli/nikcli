import { Channel, invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

export type ServiceInfo = {
  file: string
  channel: string
  id: string
  pid: number
  url: string
  version: string
  startedAt: number
  hasPassword: boolean
  alive: boolean
}

export type ProcCategory = "service" | "server" | "cli" | "test" | "dev" | "child" | "devhub" | "editor" | "other"

export type ProcInfo = {
  pid: number
  parent: number | null
  name: string
  exe: string | null
  cmd: string
  cwd: string | null
  category: ProcCategory
  cpu: number
  rss: number
  virt: number
  runtime: number
  started: number
  status: string
  readBytes: number
  writtenBytes: number
  threads: number | null
}

export type Snapshot = {
  at: number
  host: string | null
  os: string | null
  uptime: number
  cpuCount: number
  cpuUsage: number
  load: [number, number, number]
  memTotal: number
  memUsed: number
  swapTotal: number
  swapUsed: number
  procs: ProcInfo[]
}

export type ModelRow = {
  providerId: string
  providerName: string
  modelId: string
  name: string
  inputCost: number | null
  outputCost: number | null
  context: number | null
  reasoning: boolean
}
export type TestFile = { package: string; path: string; size: number; modified: number }
export type StorageEntry = { name: string; location: "data" | "state"; path: string; size: number; isDir: boolean }
export type LogFile = { name: string; size: number; modified: number }

export type BenchRecord = {
  runId: string
  timestamp: string
  suite: string
  module: string
  scenario: string
  iterations: number
  value: number
  unit: string
  valuePerIteration?: number
}
export type BenchRun = { runId: string; createdAt: string; records: BenchRecord[] }
export type PerfRoute = {
  name: string
  method: string
  path: string
  n: number
  min: number
  median: number
  p95: number
  max: number
}
export type PerfBaseline = {
  version: number
  recordedAt: string
  samples: number
  host: Record<string, unknown>
  routes: PerfRoute[]
}
export type Benchmarks = { runs: BenchRun[]; baseline: PerfBaseline | null; runsDir: string }

export type ApiResponse = { status: number; headers: Record<string, string>; body: string; elapsedMs: number }
export type TaskLine = { stream: "stdout" | "stderr"; line: string }
export type TaskEvent =
  | { kind: "lines"; lines: TaskLine[] }
  | { kind: "exit"; code: number | null; durationMs: number; cancelled: boolean }
export type UiCommand = "assistant" | "palette" | "sample"
export type StreamEvent =
  | { kind: "connection"; state: "live" | "reconnecting" | "error"; detail: string | null }
  | { kind: "event"; data: { directory?: string; payload: { type: string; properties: Record<string, unknown> } } }
export type SignedIn = { accountId: string; email: string | null; provisioned: boolean }

export const native = {
  services: () => invoke<ServiceInfo[]>("discover_services"),
  api: (req: {
    serviceUrl: string
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
    timeoutSecs?: number
  }) => invoke<ApiResponse>("api_request", { req }),
  snapshot: () => invoke<Snapshot>("system_snapshot"),
  /** One native sampler pushes snapshots over an IPC channel (also keeps the tray title live). */
  subscribeSystem: (onSnapshot: (s: Snapshot) => void, intervalMs: number) => {
    const channel = new Channel<Snapshot>()
    channel.onmessage = onSnapshot
    return invoke<void>("system_subscribe", { onSnapshot: channel, intervalMs })
  },
  /** Keeps an authenticated SSE connection open natively and pushes parsed events over a channel. */
  eventStream: (id: string, serviceUrl: string, path: string, onEvent: (e: StreamEvent) => void) => {
    const channel = new Channel<StreamEvent>()
    channel.onmessage = onEvent
    return invoke<void>("event_stream", { id, serviceUrl, path, onEvent: channel })
  },
  /** Connected-provider models, reduced natively (the raw /provider document is ~6 MB). */
  providerModels: (serviceUrl: string) => invoke<ModelRow[]>("provider_models", { serviceUrl }),
  eventStop: (id: string) => invoke<void>("event_stop", { id }),
  accountComplete: (serviceUrl: string, deviceCode: string, expiresIn?: number) =>
    invoke<SignedIn>("account_complete", { serviceUrl, deviceCode, expiresIn }),
  accountSignOut: (serviceUrl: string) => invoke<void>("account_sign_out", { serviceUrl }),
  windowEffects: () => invoke<boolean>("window_effects"),
  kill: (pid: number, force: boolean) => invoke<void>("kill_process", { pid, force }),
  repoRoot: () => invoke<string>("repo_root"),
  setRepoRoot: (path: string) => invoke<string>("set_repo_root", { path }),
  readRepoFile: (rel: string) => invoke<string>("read_repo_file", { rel }),
  writeScratch: (name: string, content: string) => invoke<string>("write_scratch", { name, content }),
  tests: () => invoke<TestFile[]>("list_tests"),
  benchmarks: () => invoke<Benchmarks>("read_benchmarks"),
  storage: () => invoke<StorageEntry[]>("storage_report"),
  logs: () => invoke<LogFile[]>("list_logs"),
  tailLog: (name: string, bytes: number) => invoke<string>("tail_log", { name, bytes }),
  /** Output and exit arrive as ordered, batched events on a dedicated channel. */
  taskStart: (
    req: { id: string; cwd: string; args: string[]; env?: Record<string, string> },
    onEvent: (e: TaskEvent) => void,
  ) => {
    const channel = new Channel<TaskEvent>()
    channel.onmessage = onEvent
    return invoke<number>("task_start", { req, onEvent: channel })
  },
  taskCancel: (id: string) => invoke<void>("task_cancel", { id }),
  onNav: (fn: (page: string) => void): Promise<UnlistenFn> => listen<string>("nav", (e) => fn(e.payload)),
  onUi: (fn: (cmd: UiCommand) => void): Promise<UnlistenFn> => listen<UiCommand>("ui", (e) => fn(e.payload)),
}

export const errorText = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e)

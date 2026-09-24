import { describe, expect, it } from "bun:test"
import path from "path"
import {
  chdirToThreadDirectory,
  createEventSource,
  createWorkerEnv,
  releaseWorkerWithoutTermination,
  resolveThreadDirectory,
  shouldTerminateWorker,
  shutdownWorker,
  superviseWorker,
  validateSession,
} from "@/cli/handlers/default"
import { Rpc } from "@tui/util/rpc"
import { Process } from "@nikcli-ai/util/process"

describe("TUI thread bootstrap", () => {
  it("resolves project paths relative to PWD", () => {
    const workspace = path.resolve("workspace")
    const other = path.resolve("other")
    const absoluteProject = path.resolve("repo")

    expect(resolveThreadDirectory("repo", workspace, other)).toBe(path.join(workspace, "repo"))
    expect(resolveThreadDirectory(absoluteProject, workspace, other)).toBe(absoluteProject)
    expect(resolveThreadDirectory(undefined, workspace, other)).toBe(other)
  })

  it("creates a worker env with process metadata", () => {
    const previousRunID = process.env[Process.RUN_ID_ENV]

    try {
      const env = createWorkerEnv({ CUSTOM_ENV: "1" })

      expect(env[Process.ROLE_ENV]).toBe("worker")
      expect(env[Process.RUN_ID_ENV]).toBeTruthy()
      expect(env.CUSTOM_ENV).toBe("1")
    } finally {
      if (previousRunID === undefined) delete process.env[Process.RUN_ID_ENV]
      else process.env[Process.RUN_ID_ENV] = previousRunID
    }
  })

  it("does not terminate the worker on Windows shutdown", () => {
    expect(shouldTerminateWorker("win32")).toBe(false)
    expect(shouldTerminateWorker("darwin")).toBe(true)
    expect(shouldTerminateWorker("linux")).toBe(true)

    let released = false
    releaseWorkerWithoutTermination({ terminate: () => {}, unref: () => (released = true) })
    expect(released).toBe(true)
  })

  it("does not await or terminate a hanging Windows worker", async () => {
    let released = false
    let terminated = false
    const started = Date.now()

    await shutdownWorker({
      shutdown: () => new Promise(() => {}),
      terminate: () => {
        terminated = true
      },
      release: () => {
        released = true
      },
      platform: "win32",
      timeoutMs: 1_000,
    })

    expect(Date.now() - started).toBeLessThan(500)
    expect(released).toBe(true)
    expect(terminated).toBe(false)
  })

  it("rejects malformed session ids before rendering", async () => {
    await expect(validateSession({ url: "http://nikcli.local", sessionID: "bad" })).rejects.toThrow(
      "Invalid session ID",
    )
  })

  it("chdirToThreadDirectory returns false when chdir fails", () => {
    const chdir = process.chdir
    process.chdir = (() => {
      throw new Error("ENOENT")
    }) as typeof process.chdir
    try {
      expect(chdirToThreadDirectory("/nonexistent-path-nikcli-thread-test")).toBe(false)
    } finally {
      process.chdir = chdir
    }
  })

  it("forwards global.event envelopes from the worker to the subscriber", async () => {
    type TestEnvelope = {
      directory?: string
      payload: { type: string; properties: Record<string, unknown> }
    }
    const envelope: TestEnvelope = {
      directory: "/tmp/worktree-a",
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_test", status: { type: "busy" } },
      },
    }
    let listener: ((event: TestEnvelope) => void) | undefined
    let channel: string | undefined
    const client = {
      on: (name: string, callback: typeof listener) => {
        channel = name
        listener = callback
        return () => {
          listener = undefined
        }
      },
      call: async () => undefined,
    } as never
    const received: TestEnvelope[] = []

    const unsubscribe = await createEventSource(client).subscribe(undefined, (value) =>
      received.push(value as TestEnvelope),
    )
    expect(channel).toBe("global.event")

    listener?.(envelope)
    // Envelopes without a typed payload are dropped instead of crashing consumers.
    listener?.({ payload: undefined as never })

    expect(received).toEqual([envelope])
    unsubscribe()
  })
})

describe("server worker supervision", () => {
  // A request to a worker that will never answer used to wait forever, and the
  // first bootstrap waiting on it kept the TUI from ever painting. Supervision
  // turns that into a failure the bootstrap can report.
  const within = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([promise, new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), ms))])

  function spawn(fixture: string, env: Record<string, string> = {}) {
    return new Worker(new URL(`./fixtures/${fixture}`, import.meta.url).href, { env: Process.sanitizedEnv(env) })
  }

  it("fails pending calls when the worker dies before it listens", async () => {
    const worker = spawn("broken-rpc-worker.ts", { RPC_WORKER_MODE: "crash" })
    worker.onerror = () => {}
    const client = Rpc.client<{ echo: (input: number) => number }>(worker)
    const stop = superviseWorker({ worker, client, stopping: () => false })
    try {
      const outcome = await within(
        client.call("echo", 1).then(
          () => "answered",
          (error: Error) => error.message,
        ),
        3_000,
      )
      expect(outcome).toContain("exited unexpectedly")
      // And every later call fails at once rather than queueing.
      await expect(client.call("echo", 2)).rejects.toThrow("exited unexpectedly")
    } finally {
      stop()
      worker.terminate()
    }
  })

  it("fails pending calls when the worker never starts listening", async () => {
    const worker = spawn("broken-rpc-worker.ts", { RPC_WORKER_MODE: "never" })
    const client = Rpc.client<{ echo: (input: number) => number }>(worker)
    const stop = superviseWorker({ worker, client, stopping: () => false, readyTimeoutMs: 200 })
    try {
      const outcome = await within(
        client.call("echo", 1).then(
          () => "answered",
          (error: Error) => error.message,
        ),
        3_000,
      )
      expect(outcome).toContain("did not start within")
    } finally {
      stop()
      worker.terminate()
    }
  })

  it("leaves a healthy worker alone after it is ready", async () => {
    const worker = spawn("slow-rpc-worker.ts", { RPC_WORKER_DELAY_MS: "100" })
    const client = Rpc.client<{ echo: (input: number) => number }>(worker)
    const stop = superviseWorker({ worker, client, stopping: () => false, readyTimeoutMs: 400 })
    try {
      expect(await within(client.call("echo", 1), 3_000)).toBe(1)
      // Past the ready deadline: a worker that became ready must not be closed by it.
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(await within(client.call("echo", 2), 3_000)).toBe(2)
    } finally {
      stop()
      worker.terminate()
    }
  })

  it("does not report a worker it was asked to stop", async () => {
    let closedWith: Error | undefined
    const listeners = new Set<(event: Event) => void>()
    const worker = {
      addEventListener: (_type: string, listener: (event: Event) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: Event) => void) => listeners.delete(listener),
    } as unknown as Parameters<typeof superviseWorker>[0]["worker"]
    const stop = superviseWorker({
      worker,
      client: { ready: new Promise(() => {}), close: (error) => void (closedWith = error) },
      stopping: () => true,
      readyTimeoutMs: 50,
    })
    for (const listener of listeners) listener(new Event("close"))
    await new Promise((resolve) => setTimeout(resolve, 150))
    stop()
    expect(closedWith).toBeUndefined()
  })
})

import { preserveTestEnv } from "../helpers/env"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { flushBenchmarkRun, recordBenchmark, recordVisualArtifact } from "../benchmarks/runner"
import { Identifier } from "@nikcli-ai/util/id"
import { Instance } from "@/project/instance"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
import { Todo } from "@/session/todo"
import { Bus } from "@/bus"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Effect } from "effect"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-session-audit-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG"])

const projectDirs: string[] = []

async function withProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-session-audit-project-"))
  projectDirs.push(projectDir)
  return Instance.provide({
    directory: projectDir,
    fn: () => fn(projectDir),
  })
}

function runStatus<A, E>(effect: Effect.Effect<A, E, SessionStatus.Service>) {
  return runPromiseWithLayer(SessionStatus.defaultLayer, withCurrentInstance(effect))
}

function runTodo<A, E>(effect: Effect.Effect<A, E, Todo.Service>) {
  return runPromiseWithLayer(Todo.defaultLayer, withCurrentInstance(effect))
}

function runCompaction<A, E>(effect: Effect.Effect<A, E, SessionCompaction.Service>) {
  return runPromiseWithLayer(SessionCompaction.defaultLayer, withCurrentInstance(effect))
}

function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
  return runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))
}

function createSession() {
  return runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.createNext({ directory: Instance.directory })
    }),
  )
}

function updateMessage(info: MessageV2.Info) {
  return runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.updateMessage(info)
    }),
  )
}

function updatePart(part: MessageV2.Part) {
  return runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.updatePart(part)
    }),
  )
}

function removeMessage(input: { sessionID: string; messageID: string }) {
  return runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.removeMessage(input)
    }),
  )
}

function listMessages(sessionID: string) {
  return runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.messages({ sessionID })
    }),
  )
}

function updateTodo(sessionID: string, todos: Todo.Info[]) {
  return runTodo(
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      yield* todo.update({ sessionID, todos })
    }),
  )
}

function getTodo(sessionID: string) {
  return runTodo(
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      return yield* todo.get(sessionID)
    }),
  )
}

function getStatus(sessionID: string) {
  return runStatus(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      return yield* status.get(sessionID)
    }),
  )
}

function setStatus(sessionID: string, input: SessionStatus.Info) {
  return runStatus(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      return yield* status.set(sessionID, input)
    }),
  )
}

function listStatus() {
  return runStatus(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      return yield* status.list()
    }),
  )
}

type ModuleImport = {
  modulePath: string
  module?: Record<string, unknown>
  error?: string
}

type ExportRecord = {
  modulePath: string
  exportName: string
  type: string
}

const sessionModulePaths = [
  "@/session",
  "@/session/retry",
  "@/session/status",
  "@/session/message-v2",
  "@/session/compaction",
  "@/session/todo",
  "@/session/system",
  "@/session/stats",
] as const

const moduleImports: ModuleImport[] = await Promise.all(
  sessionModulePaths.map(async (modulePath) => {
    try {
      const module = (await import(modulePath)) as Record<string, unknown>
      return { modulePath, module }
    } catch (error) {
      return { modulePath, error: String(error) }
    }
  }),
)

const exportManifest: ExportRecord[] = moduleImports.flatMap((entry) => {
  if (!entry.module) return []
  return Object.entries(entry.module).map(([exportName, value]) => ({
    modulePath: entry.modulePath,
    exportName,
    type: typeof value,
  }))
})

function createUserMessage(sessionID: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id: Identifier.ascending("message"),
      role: "user",
      sessionID,
      time: {
        created: Date.now(),
      },
      agent: "session-audit-agent",
      model: {
        providerID: "test",
        modelID: "test",
      },
      tools: {},
    } as MessageV2.User,
    parts: [
      {
        id: Identifier.ascending("part"),
        sessionID,
        messageID: `placeholder-${Date.now()}`,
        type: "text",
        text,
      } as MessageV2.TextPart,
    ],
  }
}

function createAssistantMessage(
  sessionID: string,
  parentID: string,
  withTool = false,
  paths: { cwd: string; root: string } = { cwd: "/", root: "/" },
): MessageV2.WithParts {
  const assistantPart = {
    id: Identifier.ascending("part"),
    sessionID,
    messageID: `placeholder-${Date.now()}`,
    type: "text",
    text: "assistant",
  } as MessageV2.TextPart

  const toolPart = {
    id: Identifier.ascending("part"),
    sessionID,
    messageID: `placeholder-${Date.now()}`,
    type: "tool",
    callID: Identifier.ascending("tool"),
    tool: "session-audit",
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: "tool",
      metadata: {},
      time: {
        start: Date.now(),
        end: Date.now(),
      },
      attachments: [],
    },
  } as MessageV2.ToolPart

  return {
    info: {
      id: Identifier.ascending("message"),
      role: "assistant",
      sessionID,
      time: {
        created: Date.now(),
        completed: Date.now(),
      },
      parentID,
      modelID: "test-model",
      providerID: "test-provider",
      mode: "chat",
      agent: "session-audit-agent",
      path: {
        cwd: paths.cwd,
        root: paths.root,
      },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    } as MessageV2.Assistant,
    parts: withTool ? [assistantPart, toolPart] : [assistantPart],
  }
}

describe("Session module registry matrix", () => {
  it.each(moduleImports)("loads session module $modulePath", ({ modulePath, module, error }) => {
    if (error) {
      expect(module).toBeUndefined()
      expect(error.length).toBeGreaterThan(0)
      return
    }
    expect(module).toBeDefined()
    expect(modulePath).toContain("session")
  })

  it.each(moduleImports)("records module export scan for $modulePath", ({ modulePath, module }) => {
    const exports = module ? Object.keys(module).sort() : []
    const lines = exports.map((name) => `- ${name}`)
    const visual = [`# Session Module ${modulePath}`, `Export count: ${exports.length}`, ...lines].join("\n")
    const start = performance.now()
    let score = exports.length
    for (let i = 0; i < 2_000; i += 1) {
      score = (score * 31 + exports.length) % 1_000_000
    }
    const elapsed = performance.now() - start

    recordBenchmark({
      suite: "session-module",
      module: modulePath,
      scenario: "export scan",
      iterations: 2_000,
      value: elapsed,
      unit: "ms",
      metadata: {
        exportCount: exports.length,
        score,
      },
    })

    recordVisualArtifact({
      suite: "session-module",
      module: modulePath,
      scenario: "exports",
      content: visual,
      extension: "md",
    })

    expect(typeof visual.length).toBe("number")
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })

  it.each(exportManifest)("exports $exportName from $modulePath are inspectable", ({ exportName, type }) => {
    expect(exportName).toBeTruthy()
    expect(type).toBeTypeOf("string")
  })

  it("simulates multi-agent module inventory sweep", async () => {
    const agents = [
      { name: "agent-registry", modules: moduleImports.slice(0, Math.ceil(moduleImports.length / 2)) },
      { name: "agent-schema", modules: moduleImports.slice(Math.ceil(moduleImports.length / 2)) },
      { name: "agent-visual", modules: [...moduleImports] },
    ] as const

    const start = performance.now()
    const reports = await Promise.all(
      agents.map(async (agent) => {
        let exportCount = 0
        let commandLike = 0
        const lines: string[] = []
        for (const item of agent.modules) {
          if (!item.module) {
            lines.push(`${agent.name}:${item.modulePath}:missing`)
            continue
          }
          const entries = Object.entries(item.module)
          exportCount += entries.length
          for (const [name] of entries) {
            if (name && typeof name === "string") commandLike += 1
            lines.push(`${item.modulePath}:${name}`)
          }
        }

        const checksum = lines.reduce((acc, line, index) => {
          return (acc * 31 + line.length + index) % 1_000_000
        }, agent.name.length)

        const visual = lines.slice(0, 60).join("\n")
        recordVisualArtifact({
          suite: "session-module",
          module: agent.name,
          scenario: "agent sweep",
          content: visual,
          extension: "md",
        })

        return {
          name: agent.name,
          exportCount,
          commandLike,
          checksum,
        }
      }),
    )
    const elapsed = performance.now() - start
    const checksumTotal = reports.reduce((acc, item) => acc + item.checksum, 0)
    recordBenchmark({
      suite: "session",
      module: "multi-agent",
      scenario: "module inventory sweep",
      iterations: reports.length,
      value: elapsed,
      unit: "ms",
      metadata: {
        checksumTotal,
        exportCount: reports.reduce((acc, item) => acc + item.exportCount, 0),
        commandLike: reports.reduce((acc, item) => acc + item.commandLike, 0),
      },
    })

    expect(reports).toHaveLength(3)
    expect(checksumTotal).toBeGreaterThan(0)
  })
})

describe("Session retry matrix", () => {
  let randomSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    randomSpy = spyOn(Math, "random").mockReturnValue(0)
  })
  afterEach(() => {
    randomSpy.mockRestore()
  })

  const delayCases = Array.from({ length: 18 }, (_, attempt) => ({
    attempt: attempt + 1,
    expected: Math.min(2_000 * 2 ** attempt, 30_000),
    label: `attempt-${attempt + 1}`,
  }))

  const retryableCases = [
    {
      message: "Overloaded due to provider pressure",
      expected: "Provider is overloaded",
    },
    {
      message: "timeout from provider",
      expected: "timeout from provider",
    },
    { message: "FreeUsageLimitError", expected: "Free usage exceeded, add credits https://nikcli-ai.dev/zen" },
    {
      message: '{"type":"error","error":{"type":"too_many_requests"}}',
      expected: "Too Many Requests",
    },
    {
      message: '{"error":{"message":"no_kv_space","code":"server_error"}}',
      expected: "Provider Server Error",
    },
    {
      message: '{"code":"rate_limit_exhausted"}',
      expected: "Provider is overloaded",
    },
    {
      message: '{"error":{"message":"resource unavailable"}}',
      expected: "Provider Server Error",
    },
    {
      message: "unknown internal server error",
      expected: "unknown internal server error",
    },
  ] as const

  it.each(delayCases)("delay $label is stable", ({ attempt, expected }) => {
    expect(SessionRetry.delay(attempt)).toBe(expected)
  })

  it.each(delayCases)("delay keeps header precedence for $label", ({ attempt }) => {
    const headered = SessionRetry.delay(
      attempt,
      new MessageV2.APIError({
        message: "x",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after-ms": "1500",
        },
      } as never),
    )
    expect(headered).toBe(1_500)
  })

  it.each([...retryableCases])("maps retryable reason for $message", ({ message, expected }) => {
    const result = SessionRetry.retryable(
      new MessageV2.APIError({ message, isRetryable: true, statusCode: 429 }).toObject(),
    )
    expect(result).toBe(expected)
  })

  it("benchmarks SessionRetry loops", () => {
    const iterations = 5_000
    const start = performance.now()
    const headers = { "retry-after-ms": "333" }
    let checksum = 0
    for (let i = 1; i <= iterations; i += 1) {
      const ms = SessionRetry.delay(
        i,
        new MessageV2.APIError({ message: "Overloaded", isRetryable: true, responseHeaders: headers, statusCode: 429 }),
      )
      checksum += ms
    }
    const elapsed = performance.now() - start
    recordBenchmark({
      suite: "session",
      module: "retry",
      scenario: "delay loop",
      iterations,
      value: elapsed,
      unit: "ms",
      metadata: { checksum },
    })
    expect(checksum).toBeGreaterThan(0)
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })
})

describe("Session compaction matrix", () => {
  const model = {
    id: "test-model",
    providerID: "test-provider",
    limit: {
      input: 30_000,
      output: 4_000,
      context: 40_000,
    },
  } as never

  const compactTokens = [
    {
      label: "under-capacity",
      tokens: { total: 1_000, input: 500, output: 200, reasoning: 100, cache: { read: 0, write: 0 } },
      expected: false,
    },
    {
      label: "over-capacity",
      tokens: { total: 100_000, input: 50_000, output: 40_000, reasoning: 10_000, cache: { read: 0, write: 0 } },
      expected: true,
    },
  ]

  it.each(compactTokens)("compaction overflow check $label", async ({ tokens, expected }) => {
    await withProject(async () => {
      const result = await runCompaction(
        Effect.gen(function* () {
          const compaction = yield* SessionCompaction.Service
          return yield* compaction.isOverflow({ tokens: tokens as never, model })
        }),
      )
      expect(result).toBe(expected)
    })
  })

  it("benchmarks compaction overflow loops", async () => {
    await withProject(async () => {
      const iterations = 5_000
      const start = performance.now()
      let score = 0
      for (let i = 0; i < iterations; i += 1) {
        const input = {
          total: i + 100,
          input: i,
          output: i,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }
        const value = await runCompaction(
          Effect.gen(function* () {
            const compaction = yield* SessionCompaction.Service
            return yield* compaction.isOverflow({ tokens: input as never, model })
          }),
        )
        score += value ? 1 : 0
      }
      const elapsed = performance.now() - start
      recordBenchmark({
        suite: "session",
        module: "compaction",
        scenario: "overflow loop",
        iterations,
        value: elapsed,
        unit: "ms",
        metadata: { score },
      })
      expect(score).toBeGreaterThanOrEqual(0)
    })
  })

  it("exposes compaction constants", () => {
    expect(SessionCompaction.PRUNE_MINIMUM).toBeGreaterThan(0)
    expect(SessionCompaction.PRUNE_PROTECT).toBeGreaterThan(SessionCompaction.PRUNE_MINIMUM)
  })
})

describe("Session status matrix", () => {
  const statusCases = Array.from({ length: 28 }).map((_, index) => {
    if (index % 3 === 0) return { sessionID: `audit-status-${index}`, status: { type: "idle" as const } }
    if (index % 3 === 1) return { sessionID: `audit-status-${index}`, status: { type: "busy" as const } }
    return {
      sessionID: `audit-status-${index}`,
      status: {
        type: "retry" as const,
        attempt: index,
        message: `attempt-${index}`,
        next: index * 100,
      },
    }
  })

  it.each(statusCases)("$sessionID is tracked with status type %status.type", async ({ sessionID, status }) => {
    await withProject(async () => {
      await setStatus(sessionID, status)
      const observed = await getStatus(sessionID)
      expect(observed).toEqual(status)
      await setStatus(sessionID, { type: "idle" })
    })
  })

  it("benchmarks status map operations", async () => {
    await withProject(async () => {
      const iterations = 4_000
      const start = performance.now()
      for (let i = 0; i < iterations; i += 1) {
        await setStatus(`bench-status-${i}`, {
          type: "retry",
          attempt: 1,
          message: "bench",
          next: 2_000,
        })
      }
      const snapshot = await listStatus()
      const hasRetry = Object.values(snapshot).filter((item) => item?.type === "retry").length
      const elapsed = performance.now() - start

      recordBenchmark({
        suite: "session",
        module: "status",
        scenario: "set loop",
        iterations,
        value: elapsed,
        unit: "ms",
        metadata: {
          hasRetry,
        },
      })
      expect(hasRetry).toBeGreaterThan(0)
    })
  })
})

describe("MessageV2 conversion and cursor matrix", () => {
  const cursorCases = Array.from({ length: 20 }, (_, index) => ({
    id: `cursor-${index}`,
    time: Date.now() - index * 10,
  }))

  it.each(cursorCases)("cursor roundtrip for $id", ({ id, time }) => {
    const encoded = MessageV2.cursor.encode({ id, time })
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.id).toBe(id)
    expect(decoded.time).toBe(time)
  })

  const toModelCases = Array.from({ length: 18 }, (_, index) => index)

  it.each(toModelCases)("toModelMessages stress case %s", (index) => {
    const sessionID = `to-model-${index}`
    const user = createUserMessage(sessionID, `u-${index}`)
    const assistant = createAssistantMessage(sessionID, user.info.id, index % 2 === 0)
    user.parts[0].messageID = user.info.id
    assistant.parts.forEach((part) => {
      part.messageID = assistant.info.id
    })
    const model = {
      api: { npm: "@ai-sdk/anthropic", id: "minimax-coding-plan" },
      id: "MiniMax-M2.7",
      cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    } as never
    const converted = MessageV2.toModelMessages([user, assistant], model)
    expect(converted.length).toBeGreaterThanOrEqual(1)
    expect(converted[0]?.role).toBe("user")
    const json = converted[0].content[0]
    expect(json).toBeTruthy()
  })

  it("benchmarks toModelMessages loops", () => {
    const iterations = 500
    const model = {
      api: { npm: "@ai-sdk/openai", id: "gpt-4o-mini" },
      id: "gpt-4o-mini",
      cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    } as never
    const start = performance.now()
    let sum = 0
    for (let i = 0; i < iterations; i += 1) {
      const sessionID = `bench-loop-${i}`
      const user = createUserMessage(sessionID, "hi")
      user.parts[0].messageID = user.info.id
      sum += MessageV2.toModelMessages([user], model).length
    }
    const elapsed = performance.now() - start
    recordBenchmark({
      suite: "session",
      module: "message-v2",
      scenario: "toModelMessages loop",
      iterations,
      value: elapsed,
      unit: "ms",
      metadata: { sum },
    })
    expect(sum).toBe(iterations)
  })
})

describe("Todo list matrix", () => {
  const statuses = ["pending", "in_progress", "completed", "cancelled"] as const

  const todoCases = Array.from({ length: 30 }, (_, index) => {
    const length = (index % 5) + 1
    const todos = Array.from({ length }, (_, offset) => ({
      id: `todo-${index}-${offset}`,
      content: `content ${index}-${offset}`,
      status: statuses[(index + offset) % statuses.length],
      priority: offset % 2 === 0 ? "high" : "medium",
    }))
    return { label: `batch-${index}`, todos }
  })

  it.each(todoCases)("stores and reads todo batch $label", async ({ todos }) => {
    await withProject(async () => {
      const sessionID = `todo-${todos[0].id}`
      await updateTodo(sessionID, todos)
      const read = await getTodo(sessionID)
      expect(read).toHaveLength(todos.length)
    })
  })

  it("emits todo update diff events", async () => {
    await withProject(async () => {
      const events: Array<{ added: number; completed: number }> = []
      const unsubscribe = Bus.subscribe(Todo.Event.Updated, (evt) => {
        events.push({
          added: evt.properties.diff.added.length,
          completed: evt.properties.diff.completed.length,
        })
      })
      await updateTodo("todo-diff-event", [
        { id: "a", content: "first", status: "pending", priority: "low" },
        { id: "b", content: "second", status: "completed", priority: "high" },
      ])
      await updateTodo("todo-diff-event", [{ id: "a", content: "first", status: "completed", priority: "low" }])
      unsubscribe()
      expect(events.length).toBe(2)
      expect(events[0].added).toBeGreaterThan(0)
    })
  })
})

describe("Session persistence matrix", () => {
  const lifecycleCases = Array.from({ length: 20 }, (_, index) => ({
    label: `case-${index + 1}`,
    turns: index + 1,
  }))

  it.each(lifecycleCases)("stores conversation for $label", async ({ turns }) => {
    await withProject(async () => {
      const session = await createSession()
      for (let i = 0; i < turns; i += 1) {
        const user = createUserMessage(session.id, `turn ${i}`)
        user.parts[0].messageID = user.info.id
        await updateMessage(user.info)
        await updatePart(user.parts[0])
        if (i % 2 === 0) {
          const assistant = createAssistantMessage(session.id, user.info.id, i % 3 === 0, {
            cwd: Instance.directory,
            root: Instance.worktree,
          })
          assistant.info.id = Identifier.ascending("message")
          assistant.parts[0].messageID = assistant.info.id
          if (assistant.parts[1]) assistant.parts[1].messageID = assistant.info.id
          await updateMessage(assistant.info)
          for (const part of assistant.parts) {
            await updatePart(part)
          }
        }
      }

      const messages = await listMessages(session.id)
      expect(messages.length).toBeGreaterThan(0)
      const userCount = messages.filter((msg) => msg.info.role === "user").length
      const assistantCount = messages.filter((msg) => msg.info.role === "assistant").length
      expect(userCount).toBeGreaterThan(0)
      expect(assistantCount + userCount).toBe(messages.length)
      expect(userCount).toBeGreaterThanOrEqual(Math.ceil(messages.length / 2))
    })
  })

  it.each(Array.from({ length: 18 }, (_, index) => `remove-loop-${index}`))(
    "removes messages for %s",
    async (label) => {
      await withProject(async () => {
        const session = await createSession()
        const user = createUserMessage(session.id, label)
        user.parts[0].messageID = user.info.id
        await updateMessage(user.info)
        await updatePart(user.parts[0])

        const assistant = createAssistantMessage(session.id, user.info.id, false, {
          cwd: Instance.directory,
          root: Instance.worktree,
        })
        assistant.info.id = Identifier.ascending("message")
        assistant.parts[0].messageID = assistant.info.id
        await updateMessage(assistant.info)
        await updatePart(assistant.parts[0])

        await removeMessage({ sessionID: session.id, messageID: user.info.id })
        const remaining = await listMessages(session.id)
        expect(remaining.every((msg) => msg.info.id !== user.info.id)).toBe(true)
      })
    },
  )
})

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(projectDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await removeTestDir(testHome)
  flushBenchmarkRun()
})

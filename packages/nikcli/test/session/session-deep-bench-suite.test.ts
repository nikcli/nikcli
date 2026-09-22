import { preserveTestEnv } from "../helpers/env"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { Instance } from "@/project/instance"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/index"
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
import { SystemPrompt } from "@/session/system"
import { flushBenchmarkRun, recordBenchmark, recordVisualArtifact } from "../benchmarks/runner"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Effect } from "effect"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-session-deep-bench-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG"])

const projectDirs: string[] = []

async function withProject<T>(fn: () => Promise<T> | T): Promise<T> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-deep-bench-project-"))
  projectDirs.push(projectDir)
  return Instance.provide({
    directory: projectDir,
    fn,
  })
}

function runStatus<A, E>(effect: Effect.Effect<A, E, SessionStatus.Service>) {
  return runPromiseWithLayer(SessionStatus.defaultLayer, withCurrentInstance(effect))
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

function createApiError(
  message: string,
  responseHeaders?: Record<string, string>,
  responseBody?: string,
  isRetryable = true,
) {
  return new MessageV2.APIError({
    message,
    isRetryable,
    statusCode: 429,
    ...(responseBody !== undefined && { responseBody }),
    ...(responseHeaders !== undefined && { responseHeaders }),
  })
}

function createProviderModel(
  npm: string,
  id: string,
  costs: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
) {
  return {
    api: {
      npm,
      id,
    },
    id,
    cost: {
      input: costs.input,
      output: costs.output,
      cache: {
        read: costs.cacheRead ?? 0,
        write: costs.cacheWrite ?? 0,
      },
    },
  } as unknown as {
    api: { npm: string; id: string }
    id: string
    cost: {
      input: number
      output: number
      cache?: {
        read: number
        write: number
      }
      experimentalOver200K?: {
        input: number
        output: number
        cache?: {
          read: number
          write: number
        }
      }
    }
  }
}

function createMessageV2User(
  id: string,
  text: string,
  extraParts: MessageV2.Part[] = [],
  ignoredText = false,
): MessageV2.WithParts {
  const msg = {
    id,
    sessionID: "session-v2-deep",
    role: "user",
    time: {
      created: 1,
    },
    agent: "t-user-agent",
    model: {
      providerID: "openai",
      modelID: "gpt-4o-mini",
    },
    tools: {},
    metadata: {
      time: {
        created: 1,
      },
      sessionID: "session-v2-deep",
      tool: {},
      assistant: {
        system: ["sys"],
        modelID: "gpt-4o-mini",
        providerID: "openai",
        path: {
          cwd: "/",
          root: "/",
        },
        cost: 0,
        tokens: {
          input: 10,
          output: 3,
          reasoning: 2,
          cache: {
            read: 0,
            write: 0,
          },
        },
      },
      snapshot: "snapshot://base",
    },
    format: {
      type: "text",
    },
    summary: {
      title: "user summary",
      body: "body",
      diffs: [],
    },
  } as unknown as MessageV2.Info & { format: MessageV2.OutputFormat; summary?: MessageV2.User["summary"] }

  const basePart = {
    id: `part-${id}`,
    sessionID: msg.sessionID,
    messageID: id,
    type: "text",
    text,
    ignored: ignoredText,
  } as MessageV2.TextPart
  const parts = [basePart, ...extraParts] as MessageV2.Part[]

  return {
    info: msg,
    parts,
  }
}

function createMessageV2Assistant(
  id: string,
  parentID: string,
  parts: MessageV2.Part[],
  options: { summary?: boolean; finish?: string } = {},
): MessageV2.WithParts {
  const info = {
    id,
    sessionID: "session-v2-deep",
    role: "assistant",
    time: {
      created: 1,
      completed: 2,
    },
    parentID,
    modelID: "gpt-4o-mini",
    providerID: "openai",
    mode: "chat",
    agent: "assistant-agent",
    path: {
      cwd: "/",
      root: "/",
    },
    cost: 0.12,
    tokens: {
      total: 15,
      input: 10,
      output: 3,
      reasoning: 2,
      cache: {
        read: 0,
        write: 0,
      },
    },
    summary: options.summary ?? false,
    finish: options.finish,
    synthetic: false,
  } as unknown as MessageV2.Info

  return {
    info,
    parts,
  }
}

describe("Session status subsystem", () => {
  const idleID = "idle-session-status"

  it("defaults to idle for unknown session", async () => {
    await withProject(async () => {
      const status = await getStatus(idleID)
      expect(status.type).toBe("idle")
    })
  })

  const statusCases = [
    { sessionID: "session-status-01", status: { type: "idle" as const } },
    { sessionID: "session-status-02", status: { type: "busy" as const, since: Date.now() } },
    { sessionID: "session-status-03", status: { type: "retry" as const, attempt: 1, message: "first", next: 1_000 } },
    { sessionID: "session-status-04", status: { type: "busy" as const, since: Date.now() } },
    { sessionID: "session-status-05", status: { type: "retry" as const, attempt: 2, message: "second", next: 2_000 } },
    { sessionID: "session-status-06", status: { type: "retry" as const, attempt: 3, message: "thrid", next: 4_000 } },
    { sessionID: "session-status-07", status: { type: "busy" as const, since: Date.now() } },
    { sessionID: "session-status-08", status: { type: "idle" as const } },
  ]

  it.each(statusCases)("status lifecycle $sessionID", async ({ sessionID, status }) => {
    await withProject(async () => {
      await setStatus(sessionID, status)
      const observed = await getStatus(sessionID)
      expect(observed).toEqual(status)
      await setStatus(sessionID, { type: "idle" })
    })
  })

  it("aggregates status map values", async () => {
    await withProject(async () => {
      for (let i = 0; i < 9; i += 1) {
        await setStatus(`aggregate-${i}`, {
          type: i % 3 === 0 ? "idle" : "retry",
          attempt: 1,
          message: `msg-${i}`,
          next: 1,
        })
      }
      const snapshot = await listStatus()
      const retry = Object.keys(snapshot).filter(
        (id) => id.startsWith("aggregate-") && snapshot[id]?.type === "retry",
      ).length
      const known = Object.keys(snapshot).filter((id) => id.startsWith("aggregate-")).length

      expect(known).toBe(6)
      expect(retry).toBe(6)
      expect(snapshot["aggregate-0"]).toBeUndefined()
      expect(snapshot["aggregate-3"]).toBeUndefined()
      expect(snapshot["aggregate-6"]).toBeUndefined()

      for (let i = 0; i < 12; i += 1) {
        await setStatus(`aggregate-${i}`, { type: "idle" })
      }
    })
  })

  it("benchmarks status set/get operations", async () => {
    await withProject(async () => {
      const iterations = 5_000
      const start = performance.now()
      let last: SessionStatus.Info | undefined

      for (let i = 0; i < iterations; i += 1) {
        const sessionID = `bench-status-${i}`
        await setStatus(sessionID, { type: "retry", attempt: i % 4, message: `attempt-${i}`, next: i * 10 })
        last = await getStatus(sessionID)
        expect(last?.type).toBe("retry")
        if (i % 2 === 0) await setStatus(sessionID, { type: "idle" })
      }

      const elapsed = performance.now() - start
      recordBenchmark({
        suite: "session",
        module: "status",
        scenario: "set/get status loop",
        iterations,
        value: elapsed,
        unit: "ms",
        metadata: {
          lastSession: last?.type ?? "none",
          operations: iterations * 2,
        },
      })
      expect(elapsed).toBeGreaterThanOrEqual(0)
    })
  })
})

describe("Session retry helpers", () => {
  let randomSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    randomSpy = spyOn(Math, "random").mockReturnValue(0)
  })
  afterEach(() => {
    randomSpy.mockRestore()
  })

  const delayCases = [
    { attempt: 1, expected: 2_000 },
    { attempt: 2, expected: 4_000 },
    { attempt: 3, expected: 8_000 },
    { attempt: 4, expected: 16_000 },
    { attempt: 5, expected: 30_000 },
    { attempt: 6, expected: 30_000 },
    { headers: { "retry-after-ms": "150" }, attempt: 4, expected: 150 },
    { headers: { "retry-after": "3" }, attempt: 4, expected: 3_000 },
    { headers: { "retry-after": "invalid" }, attempt: 3, expected: 8_000 },
  ] as const

  it.each([...delayCases])("delay case for attempt $attempt", (entry) => {
    const headers = "headers" in entry ? entry.headers : undefined
    const error = headers ? createApiError("retry", headers) : undefined
    expect(SessionRetry.delay(entry.attempt, error)).toBe(entry.expected)
  })

  it("handles future retry-after date header", () => {
    const retryAfter = new Date(Date.now() + 1200).toUTCString()
    const error = createApiError("retry", { "retry-after": retryAfter })
    const delay = SessionRetry.delay(3, error)
    expect(delay).toBeGreaterThan(200)
    expect(delay).toBeLessThan(2_000)
  })

  const retryableCases = [
    {
      input: createApiError("Overloaded due to provider pressure", { header: "1" }),
      expected: "Provider is overloaded",
      label: "api error overloaded",
    },
    {
      input: createApiError("FreeUsageLimitError"),
      expected: "Free usage exceeded, add credits https://nikcli-ai.dev/zen",
      label: "free usage",
    },
    {
      input: createApiError('{"type":"error","error":{"type":"too_many_requests"}}'),
      expected: "Too Many Requests",
      label: "too many requests",
    },
    {
      input: createApiError('{"error":{"message":"no_kv_space","code":"server_error"}}'),
      expected: "Provider Server Error",
      label: "provider server",
    },
    {
      input: createApiError('{"code":"rate_limit_exhausted"}'),
      expected: "Provider is overloaded",
      label: "rate limit exhausted",
    },
    {
      input: createApiError('{"error":{"message":"server_error"}}'),
      expected: "Provider Server Error",
      label: "server_error",
    },
  ] as const

  it.each([...retryableCases])("$label is mapped", ({ input, expected }) => {
    expect(SessionRetry.retryable(input.toObject())).toBe(expected)
  })

  it("returns undefined for unsupported retry reason", () => {
    const nonRetry = createApiError("temporary issue", undefined, undefined, false)
    expect(SessionRetry.retryable(nonRetry.toObject())).toBeUndefined()
  })

  it("benchmarks retry delay and retryable parsing", () => {
    const retryErrors = [
      createApiError("Overloaded"),
      createApiError('{"type":"error","error":{"type":"too_many_requests"}'),
      createApiError("FreeUsageLimitError"),
      createApiError("random non-json"),
      new Error("generic error"),
      { data: { message: '{"error":{"code":"exhausted"}}' } },
    ].map((input) =>
      typeof (input as { toObject?: () => unknown }).toObject === "function" ? input : (input as never),
    )

    const iterations = 4_000
    const startDelay = performance.now()
    let accumulator = 0
    for (let i = 0; i < iterations; i += 1) {
      accumulator += Math.round(SessionRetry.delay((i % 5) + 1, createApiError("x")))
    }
    const elapsedDelay = performance.now() - startDelay

    const startRetry = performance.now()
    for (const error of retryErrors) {
      SessionRetry.retryable(error as never)
    }
    const elapsedRetry = performance.now() - startRetry

    recordBenchmark({
      suite: "session",
      module: "retry",
      scenario: "delay loop",
      iterations,
      value: elapsedDelay,
      unit: "ms",
      metadata: {
        accumulator,
      },
    })
    recordBenchmark({
      suite: "session",
      module: "retry",
      scenario: "retryable loop",
      iterations: retryErrors.length,
      value: elapsedRetry,
      unit: "ms",
      metadata: {
        uniqueErrors: retryErrors.length,
      },
    })
    expect(accumulator).toBeGreaterThan(0)
    expect(elapsedDelay).toBeGreaterThanOrEqual(0)
    expect(elapsedRetry).toBeGreaterThanOrEqual(0)
  })
})

describe("Session system prompt helpers", () => {
  const providerCases = [
    { id: "gpt-5", label: "gpt-5", providerID: "openai/gpt-5" },
    { id: "gpt-4.1", label: "gpt-4", providerID: "openai/gpt-4.1" },
    { id: "o1-mini", label: "o1", providerID: "openai/o1-mini" },
    { id: "gemini-3", label: "gemini", providerID: "google/gemini-3-2025" },
    { id: "gemini-2.5", label: "gemini old", providerID: "google/gemini-2.5" },
    { id: "claude", label: "anthropic", providerID: "anthropic/claude-3-7-sonnet" },
    { id: "custom", label: "fallback", providerID: "custom/custom" },
  ]

  it.each(providerCases)("provider prompt route for %label", ({ id, providerID }) => {
    const prompt = SystemPrompt.provider({
      api: {
        id,
        npm: providerID,
      },
      id,
      providerID,
      name: providerID,
    } as never)
    expect(Array.isArray(prompt)).toBe(true)
    expect(prompt.length).toBe(1)
    expect(prompt[0].trim().length).toBeGreaterThan(0)
  })

  it.each([
    { providerID: "anthropic-advanced", expected: 1 },
    { providerID: "openai", expected: 0 },
    { providerID: "custom", expected: 0 },
  ])("header for $providerID", ({ providerID, expected }) => {
    const header = SystemPrompt.header(providerID)
    expect(header.length).toBe(expected)
  })

  it("returns non-empty system instructions", () => {
    expect(SystemPrompt.instructions()).toBeTruthy()
    expect(SystemPrompt.instructions().length).toBeGreaterThan(10)
  })

  it("benchmarks system prompt provider selection", () => {
    const iterations = 20_000
    const models = providerCases.map((item) => ({
      api: { id: item.id, npm: item.providerID },
      id: item.id,
      providerID: item.providerID,
      name: item.providerID,
    }))
    const start = performance.now()

    let outputSize = 0
    for (let i = 0; i < iterations; i += 1) {
      for (const model of models) {
        const prompts = SystemPrompt.provider(model as never)
        outputSize += prompts[0]?.length ?? 0
      }
    }
    const elapsed = performance.now() - start

    const snapshot = [
      "# System prompt provider snapshot",
      ...providerCases.map((item) => `${item.label}: ${item.id} (${item.providerID})`),
      `iterations: ${iterations}`,
      `output-size: ${outputSize}`,
    ].join("\n")

    recordBenchmark({
      suite: "session",
      module: "system",
      scenario: "provider prompt loop",
      iterations,
      value: elapsed,
      unit: "ms",
      metadata: {
        providerCount: models.length,
        outputSize,
      },
    })
    recordVisualArtifact({
      suite: "session",
      module: "system",
      scenario: "provider routes",
      content: snapshot,
      extension: "md",
    })

    expect(outputSize).toBeGreaterThan(0)
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })
})

describe("MessageV2 cursor suite", () => {
  const cursorCases = Array.from({ length: 24 }, (_, i) => ({
    id: `session-cursor-${i}`,
    time: 1_700_000_000_000 + i * 1_000,
  }))

  it.each(cursorCases)("cursor roundtrip $id", ({ id, time }) => {
    const encoded = MessageV2.cursor.encode({ id, time })
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.id).toBe(id)
    expect(decoded.time).toBe(time)
  })

  it.each(cursorCases.map((item) => `${item.id}-${item.time}`))(
    "cursor decode failures for corrupted tokens #%s",
    (token) => {
      expect(() => MessageV2.cursor.decode(token)).toThrow()
    },
  )

  it("benchmarks cursor encode/decode", () => {
    const iterations = 10_000
    const start = performance.now()
    let total = 0
    for (let i = 0; i < iterations; i += 1) {
      const encoded = MessageV2.cursor.encode({ id: `bench-${i}`, time: i })
      const decoded = MessageV2.cursor.decode(encoded)
      total += decoded.id.length + decoded.time
    }
    const elapsed = performance.now() - start
    recordBenchmark({
      suite: "session",
      module: "message-v2",
      scenario: "cursor encode/decode",
      iterations,
      value: elapsed,
      unit: "ms",
      metadata: {
        total,
      },
    })
    expect(total).toBeGreaterThan(0)
  })
})

describe("MessageV2 toModelMessages and error conversion", () => {
  const openAIModel = {
    api: { npm: "@ai-sdk/anthropic", id: "minimax-coding-plan" },
    id: "MiniMax-M2.7",
  }
  const customModel = {
    api: { npm: "@my-org/custom", id: "custom-1" },
    id: "custom-1",
  }

  const toolMessages: MessageV2.WithParts[] = [
    createMessageV2Assistant("assistant-text", "user-tool-1", [
      {
        id: "part-a",
        sessionID: "session-v2-deep",
        messageID: "assistant-text",
        type: "text",
        text: "summary from assistant",
      },
    ]),
    createMessageV2Assistant("assistant-reason", "user-tool-1", [
      {
        id: "part-b",
        sessionID: "session-v2-deep",
        messageID: "assistant-reason",
        type: "reasoning",
        text: "analyze data",
        metadata: {},
        time: { start: 1, end: 1 },
      },
    ]),
    createMessageV2Assistant("assistant-step", "user-tool-1", [
      {
        id: "part-c",
        sessionID: "session-v2-deep",
        messageID: "assistant-step",
        type: "step-start",
      },
    ]),
  ]

  const imageFilePart: MessageV2.FilePart = {
    id: "file-image",
    sessionID: "session-v2-deep",
    messageID: "assistant-tool-complete",
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,iVBORw0KGgo=",
  }
  const pdfFilePart: MessageV2.FilePart = {
    id: "file-pdf",
    sessionID: "session-v2-deep",
    messageID: "assistant-tool-complete",
    type: "file",
    mime: "application/pdf",
    url: "data:application/pdf;base64,JVBERi0x",
  }
  const nonMediaFilePart: MessageV2.FilePart = {
    id: "file-txt",
    sessionID: "session-v2-deep",
    messageID: "assistant-tool-complete",
    type: "file",
    mime: "application/json",
    url: "data:application/json;base64,e30=",
  }

  it("converts user text and files to model format", () => {
    const message = createMessageV2User("user-only", "hello world", [])
    const converted = MessageV2.toModelMessages([message], openAIModel as never)
    expect(converted.length).toBe(1)
    expect(converted[0].role).toBe("user")
    expect((converted[0] as unknown as { content: unknown[] }).content[0]).toHaveProperty("type", "text")
  })

  it.each([
    {
      label: "user ignored text should be filtered",
      messages: [
        createMessageV2User("user-ignored", "visible", [
          {
            id: "x",
            sessionID: "session-v2-deep",
            messageID: "user-ignored",
            type: "text",
            text: "hidden",
            ignored: true,
          },
        ]),
      ],
      model: openAIModel as never,
      expected: 1,
      hasVisual: false,
    },
    {
      label: "user text/plain file becomes text-only",
      messages: [
        createMessageV2User("user-textfile", "hello", [
          {
            id: "file-plain",
            sessionID: "session-v2-deep",
            messageID: "user-textfile",
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "file:///tmp/note.txt",
          },
        ]),
      ],
      model: openAIModel as never,
      expected: 1,
      hasVisual: false,
    },
    {
      label: "user image file becomes model file part",
      messages: [
        createMessageV2User("user-image", "hello", [
          {
            id: "file-img",
            sessionID: "session-v2-deep",
            messageID: "user-image",
            type: "file",
            mime: "image/png",
            filename: "image.png",
            url: "data:image/png;base64,abc",
          },
        ]),
      ],
      model: openAIModel as never,
      expected: 1,
      hasVisual: true,
    },
    {
      label: "assistant text + reasoning",
      messages: [
        createMessageV2Assistant("assistant-full", "user-text", [
          {
            id: "text-a",
            sessionID: "session-v2-deep",
            messageID: "assistant-full",
            type: "text",
            text: "thinking",
          },
          {
            id: "reasoning-a",
            sessionID: "session-v2-deep",
            messageID: "assistant-full",
            type: "reasoning",
            text: "analysis",
            metadata: {},
            time: { start: 1, end: 1 },
          },
        ]),
      ],
      model: openAIModel as never,
      expected: 1,
      hasVisual: false,
    },
    {
      label: "assistant pending tool becomes tool message pair",
      messages: [
        createMessageV2Assistant("assistant-tool-pending", "user-tool", [
          {
            id: "tool-pending",
            sessionID: "session-v2-deep",
            messageID: "assistant-tool-pending",
            type: "tool",
            callID: "call-1",
            tool: "search",
            state: {
              status: "pending",
              input: { term: "abc" },
              time: { start: 1 },
            } as any,
          },
        ]),
      ],
      model: openAIModel as never,
      expected: 2,
      hasVisual: false,
    },
    {
      label: "assistant completed tool with media on unsupported model adds user followup",
      messages: [
        createMessageV2Assistant("assistant-tool-complete", "user-tool", [
          {
            id: "tool-complete",
            sessionID: "session-v2-deep",
            messageID: "assistant-tool-complete",
            type: "tool",
            callID: "call-2",
            tool: "image_tool",
            state: {
              status: "completed",
              input: { term: "abc" },
              output: "done",
              title: "Image done",
              metadata: {},
              time: { start: 1, end: 2 },
              attachments: [imageFilePart, pdfFilePart],
            },
          },
        ]),
      ],
      model: customModel as never,
      expected: 3,
      hasVisual: true,
    },
    {
      label: "assistant completed tool keeps non-media attachments",
      messages: [
        createMessageV2Assistant("assistant-tool-nonmedia", "user-tool", [
          {
            id: "tool-complete-nonmedia",
            sessionID: "session-v2-deep",
            messageID: "assistant-tool-nonmedia",
            type: "tool",
            callID: "call-3",
            tool: "code_tool",
            state: {
              status: "completed",
              input: { path: "/tmp" },
              output: "{ code }",
              title: "Code done",
              metadata: {},
              time: { start: 1, end: 2 },
              attachments: [nonMediaFilePart],
            },
          },
        ]),
      ],
      model: openAIModel as never,
      expected: 2,
      hasVisual: false,
    },
    {
      label: "assistant with compaction text marker",
      messages: [
        createMessageV2Assistant("assistant-comp", "user-comp", [
          {
            id: "comp-1",
            sessionID: "session-v2-deep",
            messageID: "assistant-comp",
            type: "text",
            text: "before",
          },
          {
            id: "comp-2",
            sessionID: "session-v2-deep",
            messageID: "assistant-comp",
            type: "compaction",
            auto: false,
          },
        ] as MessageV2.Part[]),
      ],
      model: openAIModel as never,
      expected: 1,
      hasVisual: false,
    },
    {
      label: "assistant with error is skipped",
      messages: [
        createMessageV2Assistant("assistant-error", "user-error", [
          {
            id: "err-1",
            sessionID: "session-v2-deep",
            messageID: "assistant-error",
            type: "text",
            text: "fail",
          },
        ] as MessageV2.Part[]),
      ],
      model: openAIModel as never,
      expected: 0,
    },
  ])("toModelMessages: $label", ({ label: _label, messages, model, expected, hasVisual }) => {
    if (_label === "assistant with error is skipped") {
      ;(messages[0].info as unknown as MessageV2.Assistant).error = {
        name: "MessageOutputLengthError" as const,
        data: {} as Record<string, never>,
      }
    }
    const converted = MessageV2.toModelMessages(messages as unknown as MessageV2.WithParts[], model as never)
    expect(converted.length).toBe(expected)
    if (hasVisual) {
      expect(
        converted.some(
          (message) =>
            message.role === "user" &&
            Array.isArray((message as unknown as { content: unknown[] }).content) &&
            (message as unknown as { content: Array<{ type: string }> }).content.some((part) => part.type === "file"),
        ),
      ).toBe(true)
    }
  })

  it("toModelMessages preserves step-start while filtering empty tool messages", () => {
    const message = toolMessages[2]
    const converted = MessageV2.toModelMessages([message], openAIModel as never)
    expect(converted.length).toBe(0)
  })

  it("filters compacted user streams", async () => {
    const compactingStream = MessageV2.filterCompacted(
      (async function* () {
        yield createMessageV2Assistant(
          "assistant-done",
          "user-first",
          [
            {
              id: "assistant-done-text",
              sessionID: "session-v2-deep",
              messageID: "assistant-done",
              type: "text",
              text: "done",
            },
          ],
          { summary: true, finish: "finish" },
        )
        yield createMessageV2User("user-first", "old summary", [
          {
            id: "compaction",
            sessionID: "session-v2-deep",
            messageID: "user-first",
            type: "compaction",
            auto: false,
          },
        ])
      })(),
    )

    const filtered = await compactingStream
    expect(filtered.length).toBe(2)
    expect(filtered[0].info.id).toBe("user-first")
    expect(filtered[1].info.id).toBe("assistant-done")
  })

  it.each([
    { label: "AbortError maps to MessageAbortedError", error: new DOMException("abort", "AbortError") },
    { label: "Error maps to Unknown", error: new Error("oops") },
    { label: "unknown object", error: { random: 1 } },
  ])("fromError for $label", ({ error }) => {
    const parsed = MessageV2.fromError(error as never, { providerID: "openai" })
    expect(parsed.name).toBeTruthy()
    expect(parsed).toHaveProperty("name")
    expect(parsed).toHaveProperty("data")
  })

  it("benchmarks toModelMessages and filterCompacted", async () => {
    const baselineMessages = [
      createMessageV2User("bench-user", "hello", []),
      ...toolMessages,
      createMessageV2Assistant(
        "bench-summary",
        "bench-user",
        [
          {
            id: "bench-summary-text",
            sessionID: "session-v2-deep",
            messageID: "bench-summary",
            type: "text",
            text: "ok",
          },
        ],
        { summary: true, finish: "done" },
      ),
    ]

    const toModelIterations = 400
    const filterIterations = 120

    const modelSet = [openAIModel, customModel]
    const startConvert = performance.now()
    let partCount = 0
    for (let i = 0; i < toModelIterations; i += 1) {
      const model = modelSet[i % modelSet.length]
      const output = MessageV2.toModelMessages(baselineMessages as MessageV2.WithParts[], model as never)
      partCount += output.length
    }
    const elapsedConvert = performance.now() - startConvert

    const startFilter = performance.now()
    let compactedSum = 0
    for (let i = 0; i < filterIterations; i += 1) {
      const stream = (async function* () {
        for (const msg of baselineMessages) {
          yield msg
        }
      })()
      compactedSum += (await MessageV2.filterCompacted(stream)).length
    }
    const elapsedFilter = performance.now() - startFilter

    recordBenchmark({
      suite: "session",
      module: "message-v2",
      scenario: "toModelMessages loop",
      iterations: toModelIterations,
      value: elapsedConvert,
      unit: "ms",
      metadata: {
        partCount,
      },
    })

    recordBenchmark({
      suite: "session",
      module: "message-v2",
      scenario: "filterCompacted loop",
      iterations: filterIterations,
      value: elapsedFilter,
      unit: "ms",
      metadata: {
        compactedSum,
      },
    })

    expect(partCount).toBeGreaterThan(toModelIterations - 1)
    expect(compactedSum).toBeGreaterThanOrEqual(filterIterations)
    expect(elapsedConvert).toBeGreaterThanOrEqual(0)
    expect(elapsedFilter).toBeGreaterThanOrEqual(0)
  })
})

describe("Session usage and ids", () => {
  const usageCases = [
    {
      model: createProviderModel("@ai-sdk/anthropic", "claude-3", {
        input: 5,
        output: 10,
        cacheRead: 2,
        cacheWrite: 1,
      }),
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        reasoningTokens: 15,
        totalTokens: 175,
        cachedInputTokens: 0,
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 2,
          usage: {
            cacheWriteInputTokens: 1,
          },
        },
      },
      expectedTotal: 162,
      label: "anthropic",
    },
    {
      model: createProviderModel("@ai-sdk/openai", "gpt-4", { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }),
      usage: {
        inputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 25,
        totalTokens: 360,
      },
      metadata: {},
      expectedTotal: 360,
      label: "openai",
    },
    {
      model: createProviderModel("@ai-sdk/amazon-bedrock", "sonnet", {
        input: 3,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
      }),
      usage: {
        inputTokens: 90,
        outputTokens: 20,
        reasoningTokens: 5,
        totalTokens: 130,
      },
      metadata: {
        bedrock: {
          usage: {
            cacheWriteInputTokens: 2,
          },
        },
      },
      expectedTotal: 110,
      label: "bedrock",
    },
    {
      model: createProviderModel("@ai-sdk/google", "gemini-3-pro", {
        input: 9,
        output: 9,
        cacheRead: 1,
        cacheWrite: 2,
      }),
      usage: {
        inputTokens: 500,
        outputTokens: 100,
        reasoningTokens: 50,
        totalTokens: 650,
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 0,
        },
      },
      expectedTotal: 650,
      label: "google",
    },
    {
      model: createProviderModel("@ai-sdk/amazon-bedrock", "claude-2", {
        input: 3,
        output: 6,
        cacheRead: 1,
        cacheWrite: 1,
      }),
      usage: {
        inputTokens: Number.NaN,
        outputTokens: Number.NaN,
        reasoningTokens: Number.NaN,
        totalTokens: Number.NaN,
      },
      metadata: {},
      expectedTotal: Number.NaN,
      label: "invalid numbers",
    },
  ] as const

  it.each([...usageCases])("usage output for $label", ({ model, usage, metadata, expectedTotal }) => {
    const result = Session.getUsage({
      model: model as never,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
      },
      metadata: metadata as never,
    })

    if (Number.isNaN(expectedTotal)) {
      expect(result.tokens.input).toBe(0)
      expect(result.tokens.output).toBe(0)
      expect(result.tokens.reasoning).toBe(0)
      expect(result.tokens.total).toBe(0)
      expect(result.cost).toBe(0)
      return
    }

    expect(result.tokens.total).toBe(expectedTotal)
    expect(result.tokens.input).toBeGreaterThanOrEqual(0)
    expect(result.cost).toBeGreaterThanOrEqual(0)
  })

  it("benchmarks usage computations", () => {
    const iterations = 5_000
    const start = performance.now()
    const payload = [
      createProviderModel("@ai-sdk/openai", "gpt-4", { input: 4, output: 8 }),
      createProviderModel("@ai-sdk/anthropic", "claude", { input: 8, output: 10 }),
      createProviderModel("@ai-sdk/google-vertex/anthropic", "vertex", { input: 7, output: 9 }),
    ]
    let sum = 0
    for (let i = 0; i < iterations; i += 1) {
      const model = payload[i % payload.length]
      const usage = {
        inputTokens: 10 + (i % 9),
        outputTokens: 2 + (i % 3),
        reasoningTokens: 1,
        totalTokens: 20 + (i % 10),
      }
      const result = Session.getUsage({
        model: model as never,
        usage,
      })
      sum += result.tokens.total ?? 0
    }
    const elapsed = performance.now() - start
    recordBenchmark({
      suite: "session",
      module: "index",
      scenario: "getUsage loop",
      iterations,
      value: elapsed,
      unit: "ms",
      metadata: {
        sum,
        modelCount: payload.length,
      },
    })
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })

  it("validates default title regex", () => {
    const now = new Date().toISOString()
    const valid = [`New session - ${now}`, `Child session - ${now}`]
    const invalid = ["new session", "Child session - 2024-01-01", "Session - no timestamp", ""]
    for (const title of valid) {
      expect(Session.isDefaultTitle(title)).toBe(true)
    }
    for (const title of invalid) {
      expect(Session.isDefaultTitle(title)).toBe(false)
    }
  })

  it("benchmarks default title regex checks", () => {
    const iterations = 20_000
    const now = new Date().toISOString()
    let hits = 0
    const start = performance.now()
    for (let i = 0; i < iterations; i += 1) {
      const title = i % 2 === 0 ? `New session - ${now}` : `other-${i}`
      if (Session.isDefaultTitle(title)) hits += 1
    }
    const elapsed = performance.now() - start
    recordBenchmark({
      suite: "session",
      module: "index",
      scenario: "isDefaultTitle loop",
      iterations,
      value: elapsed,
      unit: "ms",
      metadata: {
        hits,
      },
    })
    expect(hits).toBeGreaterThan(0)
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })
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

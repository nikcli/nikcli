import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Context, Effect, Fiber, Layer, Tracer } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { sanitizeSpanAttributes } from "@/observability/span-schema"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-httpapi-bridge-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG"])

const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
const { Instance } = await import("@/project/instance")
const { InstanceBootstrap } = await import("@/project/bootstrap")
const { PermissionNext } = await import("@/permission/next")
const { Question } = await import("@/question")
const { HttpApiBridge } = await import("@/server/httpapi/bridge")
const { Server } = await import("@/server/server")

const projectDirs: string[] = []

async function makeProjectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-httpapi-bridge-project-"))
  const resolved = await fs.realpath(dir)
  projectDirs.push(resolved)
  return resolved
}

function request(pathname: string, directory: string, init?: RequestInit) {
  const url = new URL(pathname, "http://nikcli.local")
  url.searchParams.set("directory", directory)
  return Server.fetch(new Request(url, init))
}

async function waitForList<T>(pathname: string, directory: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await request(pathname, directory)
    expect(response.status).toBe(200)
    const pending = (await response.json()) as T[]
    if (pending.length > 0) return pending
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return [] as T[]
}

describe("HttpApi bridge", () => {
  it("supports TuiHttpApi paths when experimental HttpApi is enabled", () => {
    expect(HttpApiBridge.supports("/tui/append-prompt", "POST")).toBe(true)
    expect(HttpApiBridge.supports("/tui/control/next", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/tui/select-session", "POST")).toBe(true)
    expect(HttpApiBridge.supports("/session/ses_1/v2/entries", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/session/ses_1/v2/state", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/session/ses_1/v2/events", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/session/ses_1/message", "POST")).toBe(true)
    expect(HttpApiBridge.supports("/session/ses_1/prompt_async", "POST")).toBe(true)
    expect(HttpApiBridge.supports("/loop", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/loop/templates", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/loop/loop_1/abort", "POST")).toBe(true)
    expect(HttpApiBridge.supports("/mobile/loops", "GET")).toBe(true)
    expect(HttpApiBridge.supports("/mobile/loops/loop_1", "DELETE")).toBe(true)
    expect(HttpApiBridge.supports("/mobile/loops/loop_1", "GET")).toBe(true)
  })

  it("serves implemented question and permission routes via Server.fetch", async () => {
    const directory = await makeProjectDir()

    const questionFiber = await Instance.provide({
      directory,
      init: InstanceBootstrap,
      fn: async () =>
        runPromiseWithLayer(
          Question.defaultLayer,
          withCurrentInstance(
            Effect.gen(function* () {
              const question = yield* Question.Service
              return yield* Effect.forkDetach(
                question.ask({
                  sessionID: "session-httpapi-bridge-question",
                  questions: [
                    {
                      header: "Confirm",
                      question: "Continue?",
                      options: [{ label: "Yes", description: "Continue" }],
                    },
                  ],
                }),
              )
            }),
          ),
        ),
    })

    const permissionFiber = await Instance.provide({
      directory,
      init: InstanceBootstrap,
      fn: async () =>
        runPromiseWithLayer(
          PermissionNext.defaultLayer,
          withCurrentInstance(
            Effect.gen(function* () {
              const permission = yield* PermissionNext.Service
              return yield* Effect.forkDetach(
                permission.ask({
                  permission: "edit",
                  patterns: ["src/index.ts"],
                  sessionID: "session-httpapi-bridge-permission",
                  metadata: { tool: "edit" },
                  always: ["src/index.ts"],
                  ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
                }),
              )
            }),
          ),
        ),
    })

    const questions = await waitForList<{ id: string }>("/question", directory)
    expect(questions).toHaveLength(1)

    const permissions = await waitForList<{ id: string }>("/permission", directory)
    expect(permissions).toHaveLength(1)

    const questionReply = await request(`/question/${questions[0].id}/reply`, directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [["Yes"]] }),
    })
    expect(questionReply.status).toBe(200)

    const permissionReply = await request(`/permission/${permissions[0].id}/reply`, directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: "once" }),
    })
    expect(permissionReply.status).toBe(200)

    const answers = await runPromiseWithLayer(Question.defaultLayer, Fiber.join(questionFiber))
    expect(answers).toEqual([["Yes"]])
    await runPromiseWithLayer(PermissionNext.defaultLayer, Fiber.join(permissionFiber))
  })

  it("serves the prompt routes without Hono", async () => {
    const directory = await makeProjectDir()

    // invalid payload mirrors the historical 400 contract
    const invalid = await request("/session/ses_bridge_prompt/message", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: "not-an-array" }),
    })
    expect(invalid.status).toBe(400)
    const failure = (await invalid.json()) as {
      success: boolean
      error: unknown
    }
    expect(failure.success).toBe(false)
    expect(failure.error).toBeDefined()

    // Admission now runs before the 204. A missing session must surface as 404
    // (previously the handler returned 204 immediately and never hit sessionGet).
    const missing = await request("/session/ses_bridge_prompt_missing/prompt_async", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "hi" }],
        noReply: true,
      }),
    })
    expect(missing.status).toBe(404)
    const missingBody = (await missing.json()) as { name?: string }
    expect(missingBody.name).toBeTruthy()
  })

  it("serves GET /loop via HttpApi when experimental flag is on", async () => {
    const directory = await makeProjectDir()
    const response = await request("/loop", directory)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      loops: unknown[]
      runtimes: unknown[]
    }
    expect(Array.isArray(body.loops)).toBe(true)
    expect(Array.isArray(body.runtimes)).toBe(true)
  })

  it("serves the /event SSE stream without Hono", async () => {
    const directory = await makeProjectDir()
    const response = await request("/event", directory)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const reader = response.body!.getReader()
    const { value } = await reader.read()
    const first = new TextDecoder().decode(value)
    expect(first).toContain("server.connected")
    await reader.cancel()
  })
})

describe("HttpApi bridge server span", () => {
  // Effect's `HttpEffect` wraps every request in `HttpMiddleware.tracer`, and
  // that span records every header. With a real tracer installed, these two
  // headers survived the sanitizer: an IP and a URL carrying a session id.
  const headers = {
    "x-forwarded-for": "203.0.113.7",
    referer: "http://localhost:4096/session/ses_bridge_span?directory=/Users/someone/project",
  }

  // `override` is merged after the bridge layer, so a service it provides wins.
  async function spansFor(override: Layer.Layer<never> = Layer.empty) {
    const spans: Tracer.NativeSpan[] = []
    const ended: Promise<void>[] = []
    const capturing = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        // The built-in span sets its attributes in a task scheduled after the
        // response is sent, then ends; reading before `end` sees none of them.
        const end = span.end.bind(span)
        ended.push(
          new Promise((resolve) => {
            span.end = (endTime, exit) => {
              end(endTime, exit)
              resolve()
            }
          }),
        )
        spans.push(span)
        return span
      },
    })
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(HttpApiBridge.layer, override, Layer.succeed(Tracer.Tracer)(capturing)),
      { disableLogger: true },
    )
    try {
      // Unmatched on purpose: the built-in span wraps the router, so a 404
      // reaches it too, and the case needs no instance to be bound — the same
      // empty context `handleGlobal` serves instance-less routes with.
      const response = await handler(
        new Request("http://nikcli.local/__no_such_route__", { headers }),
        Context.empty() as Context.Context<any>,
      )
      await response.body?.cancel()
      await Promise.all(ended)
    } finally {
      await dispose()
    }
    return spans
  }

  it("does not open Effect's built-in server span on the bridge runtime", async () => {
    const spans = await spansFor()
    expect(spans.map((span) => span.name).filter((name) => name.startsWith("http.server"))).toEqual([])
  })

  it("control: the built-in span, when allowed to run, carries the headers the spec forbids", async () => {
    // Without this, the case above would pass just as well if the tracer
    // override never reached the request fiber.
    const spans = await spansFor(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => false))
    const server = spans.find((span) => span.name === "http.server GET")
    expect(server).toBeDefined()
    expect(server!.attributes.get("http.request.header.x-forwarded-for")).toBe("203.0.113.7")
    const kept = sanitizeSpanAttributes(server!.attributes.entries()).attributes ?? {}
    expect(Object.keys(kept).filter((key) => /forwarded|referer|url\.|client\.address/.test(key))).toEqual([])
    expect(JSON.stringify(kept)).not.toContain("203.0.113.7")
    expect(JSON.stringify(kept)).not.toContain("ses_bridge_span")
  })
})

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(projectDirs.map((dir) => removeTestDir(dir)))
  await removeTestDir(testHome)
})

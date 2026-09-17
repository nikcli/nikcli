import { describe, expect, test } from "bun:test"
import type { AgentStatus } from "../session-new/availability"
import { createWorkbench } from "../surface/state"
import { createAdeVoiceHost } from "./host"
import type { TurnRequest, TurnResult } from "../bots/turn"
import { limitNotice } from "../bots/terms"
import { createVoiceAgent, resolveVoiceAgentRunner, VOICE_AGENT_DISABLED_TOOLS, VOICE_AGENT_INSTRUCTIONS, VOICE_AGENT_TIMEOUT_MS } from "./agent"

const status = (id: string, availability: AgentStatus["availability"]): AgentStatus =>
  ({ agent: { id, label: id, command: id }, availability }) as AgentStatus

describe("voice/agent", () => {
  test("auto takes the first installed CLI, in subscription order", () => {
    expect(resolveVoiceAgentRunner("auto", [status("claude-code", "assente"), status("codex", "presente")])).toEqual({
      runner: "codex",
    })
    expect(resolveVoiceAgentRunner("auto", undefined)).toEqual({ runner: "claude" })
    expect(resolveVoiceAgentRunner("codex", [status("codex", "assente")])).toEqual({ runner: "codex" })
    const none = resolveVoiceAgentRunner("auto", ["claude-code", "codex", "nikcli"].map((id) => status(id, "assente")))
    expect("problem" in none && none.problem).toContain("Claude Code")
    // nikcli cannot be held to read-only for one turn: never picked, and refused when named.
    expect(resolveVoiceAgentRunner("auto", [status("claude-code", "assente"), status("codex", "assente"), status("nikcli", "presente")])).toHaveProperty("problem")
    expect(resolveVoiceAgentRunner("nikcli", undefined)).toHaveProperty("problem")
  })

  test("a voice turn is read-only: no edits, no writes, no shell but ade-msg", async () => {
    const runner = fakeRunner([{}])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => "C:/p" })
    await agent.ask({ text: "x", engine: "claude" })
    expect(runner.requests[0].disabledTools).toEqual(["edit", "write", "bash"])
    expect(runner.requests[0].disabledTools).toBe(VOICE_AGENT_DISABLED_TOOLS)
  })

  test("a voice turn gets 150 s: past the 110 s of a blocking ade-msg ask, well short of five minutes", async () => {
    const runner = fakeRunner([{}])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => "C:/p" })
    await agent.ask({ text: "x", engine: "claude" })
    expect(runner.requests[0].timeoutMs).toBe(VOICE_AGENT_TIMEOUT_MS)
    expect(VOICE_AGENT_TIMEOUT_MS).toBe(150_000)
  })

  test("a stopped turn that ends after the newer one does not take its conversation", async () => {
    const pending: ((result: Partial<TurnResult>) => void)[] = []
    const requests: TurnRequest[] = []
    const runTurn = (request: TurnRequest) => {
      requests.push(request)
      return {
        result: new Promise<TurnResult>((resolve) =>
          pending.push((next) => resolve({ status: "done", text: "", tokens: 0, costUsd: 0, talk: {} as never, ...next } as TurnResult)),
        ),
        stop: () => {},
      }
    }
    const agent = createVoiceAgent({ runTurn, statuses: () => undefined, cwd: () => "C:/p" })

    const first = agent.ask({ text: "uno", engine: "claude" })
    const second = agent.ask({ text: "due", engine: "claude" })
    pending[1]!({ text: "nuova", sessionId: "new" })
    await second
    pending[0]!({ status: "stopped", sessionId: "old" })
    await first

    void agent.ask({ text: "tre", engine: "claude" })
    expect(requests[2]!.sessionId).toBe("new")
  })

  function fakeRunner(results: Partial<TurnResult>[]) {
    const requests: TurnRequest[] = []
    let stops = 0
    const runTurn = (request: TurnRequest) => {
      requests.push(request)
      const next = results.shift() ?? {}
      return {
        result: Promise.resolve({ status: "done", text: "", tokens: 0, costUsd: 0, talk: {} as never, ...next } as TurnResult),
        stop: () => stops++,
      }
    }
    return { runTurn, requests, stops: () => stops }
  }

  test("the fast setting asks Claude Code for Sonnet 5 with little effort, and cli leaves the CLI alone", async () => {
    const runner = fakeRunner([{ text: "a" }, { text: "b" }, { text: "c" }])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => "C:/p" })
    await agent.ask({ text: "ciao", engine: "claude", speed: "fast" })
    await agent.ask({ text: "ciao", engine: "codex", speed: "fast" })
    await agent.ask({ text: "ciao", engine: "claude", speed: "cli" })
    expect(runner.requests[0]).toMatchObject({ model: "claude-sonnet-5", effort: "low" })
    expect(runner.requests[1]!.model).toBeUndefined()
    expect(runner.requests[1]!.effort).toBe("low")
    expect(runner.requests[2]!.model).toBeUndefined()
    expect(runner.requests[2]!.effort).toBeUndefined()
  })

  test("the answer is passed on as it is written, only when it grows", async () => {
    const requests: TurnRequest[] = []
    const talk = (streaming: string) => ({ messages: [], status: "running", tokens: 0, costUsd: 0, streaming }) as never
    const runTurn = (request: TurnRequest) => {
      requests.push(request)
      request.onUpdate?.(talk("Ci sono"))
      request.onUpdate?.(talk("Ci sono"))
      request.onUpdate?.(talk("Ci sono due sessioni."))
      return {
        result: Promise.resolve({ status: "done", text: "Ci sono due sessioni.", tokens: 0, costUsd: 0, talk: {} as never } as TurnResult),
        stop: () => {},
      }
    }
    const agent = createVoiceAgent({ runTurn, statuses: () => undefined, cwd: () => "C:/p" })
    const heard: string[] = []
    await agent.ask({ text: "quante sessioni?", engine: "claude", onText: (soFar) => heard.push(soFar) })
    expect(requests[0]!.partial).toBe(true)
    expect(heard).toEqual(["Ci sono", "Ci sono due sessioni."])
    // Claude Code is always asked for pieces: a warm process is started before anyone listens.
    await agent.ask({ text: "quante sessioni?", engine: "codex" })
    expect(requests[1]!.partial).toBe(false)
  })

  test("a turn carries the instructions, the project and an ade-msg identity, and continues the conversation", async () => {
    const runner = fakeRunner([
      { text: "Ci sono due sessioni.", sessionId: "s1" },
      { text: "La seconda lavora sui test." },
    ])
    let cwd = "C:/p"
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => cwd })

    expect(await agent.ask({ text: "quante sessioni ci sono?", engine: "claude" })).toEqual({
      ok: true,
      text: "Ci sono due sessioni.",
      ran: true,
    })
    await agent.ask({ text: "e la seconda?", engine: "claude" })

    expect(runner.requests[0]).toMatchObject({ runner: "claude", cwd: "C:/p", mailbox: { id: "voce" }, lean: true })
    expect(runner.requests[0].instructions).toBe(VOICE_AGENT_INSTRUCTIONS)
    expect(runner.requests[0].sessionId).toBeUndefined()
    expect(runner.requests[1].sessionId).toBe("s1")

    // Another project, or another engine, starts over.
    cwd = "C:/other"
    await agent.ask({ text: "e ora?", engine: "claude" })
    expect(runner.requests[2].sessionId).toBeUndefined()
  })

  test("failures come back as sentences, and an abort stops the turn", async () => {
    const runner = fakeRunner([{ status: "error", problem: "claude non si avvia: ENOENT" }, { status: "stopped" }])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => undefined })

    expect(await agent.ask({ text: "x", engine: "claude" })).toEqual({ ok: false, text: "claude non si avvia: ENOENT", ran: true })
    // No runner at all: nothing ran, so the planner may still take the sentence.
    expect(await agent.ask({ text: "x", engine: "nikcli" })).toMatchObject({ ok: false, ran: false })

    const abort = new AbortController()
    const pending = agent.ask({ text: "y", engine: "claude", signal: abort.signal })
    abort.abort()
    expect((await pending).ok).toBe(false)
    expect(runner.stops()).toBe(1)
  })

  test("a turn ended by the plan's limit is said as the bots say it, and never asked again", async () => {
    const runner = fakeRunner([{ status: "error", problem: limitNotice("Claude Code") }])
    const agent = createVoiceAgent({ runTurn: runner.runTurn, statuses: () => undefined, cwd: () => "C:/p" })

    const answer = await agent.ask({ text: "quante sessioni ci sono?", engine: "claude" })
    // `ran`: a turn did start, so the planner does not take the sentence over either.
    expect(answer).toEqual({ ok: false, text: limitNotice("Claude Code"), ran: true })
    expect(answer.text).toContain("ADE non riprova")
    // Neither the same CLI again nor another engine: one sentence, one turn.
    expect(runner.requests).toHaveLength(1)
  })

  test("the voice host's sentences run through the bots' runTurn, where the plan's cap is held", async () => {
    // S13: the cap on parallel turns is taken inside runTurn (bots/terms.ts
    // acquireTurn), shared by bots and the voice agent. Without the desktop
    // host runTurn stops at its own first check, and that answer can only
    // come from runTurn: so a sentence reaching it proves the path.
    const voice = createAdeVoiceHost({
      wb: () => createWorkbench(),
      setWb: () => {},
      project: () => undefined,
      runCommand: async () => {},
      isRunning: () => false,
      getRunningSession: () => undefined,
      openFile: async () => {},
      appendLine: () => {},
      permissions: () => ({}),
      answerPermission: () => {},
    })
    expect(await voice.askAgent!({ text: "quante sessioni ci sono?", engine: "claude" })).toEqual({
      ok: false,
      text: "Nessun host: un turno si esegue solo nell'app desktop.",
      ran: true,
    })
  })
})

describe("who answers", () => {
  test("nik, on first-name terms, saying first what takes time", () => {
    expect(VOICE_AGENT_INSTRUCTIONS).toContain("Sei nik")
    expect(VOICE_AGENT_INSTRUCTIONS).toContain("dai del tu")
    expect(VOICE_AGENT_INSTRUCTIONS).toContain("prima una frase brevissima")
  })
})

describe("the warm process", () => {
  test("Claude turns go to it, with no session id; Codex turns do not; forgetting and releasing reach it", async () => {
    const cold: TurnRequest[] = []
    const warmRuns: TurnRequest[] = []
    const prepared: TurnRequest[] = []
    let forgotten = 0
    let closed = 0
    const done = (text: string) => ({
      result: Promise.resolve({ status: "done", text, sessionId: "s1", tokens: 0, costUsd: 0, talk: {} as never } as TurnResult),
      stop: () => {},
    })
    const agent = createVoiceAgent({
      runTurn: (request) => (cold.push(request), done("freddo")),
      warm: {
        prepare: (request) => void prepared.push(request),
        run: (request) => (warmRuns.push(request), done("caldo")),
        forget: () => void forgotten++,
        close: () => void closed++,
      },
      statuses: () => undefined,
      cwd: () => "C:/p",
    })
    agent.prepare({ engine: "auto", speed: "fast" })
    agent.prepare({ engine: "codex", speed: "fast" })
    expect(prepared).toHaveLength(1)
    expect(prepared[0]).toMatchObject({ runner: "claude", cwd: "C:/p", model: "claude-sonnet-5", partial: true })

    expect((await agent.ask({ text: "uno", engine: "claude", speed: "fast" })).text).toBe("caldo")
    expect((await agent.ask({ text: "due", engine: "claude", speed: "fast" })).text).toBe("caldo")
    expect(warmRuns.map((r) => r.sessionId)).toEqual([undefined, undefined])
    expect((await agent.ask({ text: "tre", engine: "codex" })).text).toBe("freddo")
    expect(cold).toHaveLength(1)
    agent.forget()
    expect(forgotten).toBe(1)
    agent.release()
    expect(closed).toBe(1)
  })

  test("a complete message is passed on with its end marked, so its last sentence is read at once", async () => {
    const heard: string[] = []
    const agent = createVoiceAgent({
      runTurn: (request) => {
        request.onUpdate?.({ messages: [{ role: "user", text: "q", at: 0 }], status: "running", tokens: 0, costUsd: 0, streaming: "Fa" } as never)
        request.onUpdate?.({ messages: [{ role: "user", text: "q", at: 0 }, { role: "bot", text: "Fa 4", at: 0 }], status: "running", tokens: 0, costUsd: 0 } as never)
        return { result: Promise.resolve({ status: "done", text: "Fa 4", tokens: 0, costUsd: 0, talk: {} as never } as TurnResult), stop: () => {} }
      },
      statuses: () => undefined,
      cwd: () => "C:/p",
    })
    await agent.ask({ text: "q", engine: "claude", onText: (t) => heard.push(t) })
    expect(heard).toEqual(["Fa", "Fa 4\n\n"])
  })
})

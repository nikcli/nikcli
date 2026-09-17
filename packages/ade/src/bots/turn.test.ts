import { afterEach, describe, expect, test } from "bun:test"
import { MAX_PARALLEL_TURNS, turnsRunning } from "./terms"
import { runTurn, timeoutProblem, TURN_EXIT_GRACE_MS, TURN_TIMEOUT_MS, type Turn, type TurnDeps } from "./turn"

/*
 * A turn against a fake machine: `spawn` records what it was asked and hands
 * back a session whose exit the test controls. Until `exit` is called the CLI
 * is "running", which is what a hung turn looks like from here.
 */
function machine() {
  const kills: { tree?: boolean }[] = []
  const exits: ((code: number | null) => void)[] = []
  const lines: ((line: string) => void)[] = []
  const host = {
    spawn: async (options: { onExit: (code: number | null) => void; onLine: (line: string) => void }) => {
      exits.push(options.onExit)
      lines.push(options.onLine)
      return {
        // A killed session unlistens and never reports its exit, as `host/shell.ts` does.
        kill: (options?: { tree?: boolean }) => void kills.push(options ?? {}),
        write: () => {},
        resize: () => {},
      }
    },
  }
  const deps: TurnDeps = { host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>> }
  return {
    deps,
    kills,
    exit: (code: number | null, at = exits.length - 1) => exits[at]?.(code),
    say: (line: string, at = lines.length - 1) => lines[at]?.(line),
  }
}

const open: Turn[] = []
afterEach(async () => {
  for (const turn of open.splice(0)) {
    turn.stop()
    await turn.result
  }
})
const start = (m: ReturnType<typeof machine>, timeoutMs?: number) => {
  const turn = runTurn({ runner: "claude", message: "ciao", ...(timeoutMs ? { timeoutMs } : {}) }, m.deps)
  open.push(turn)
  return turn
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("runTurn", () => {
  test("a turn that runs past its time is stopped with its children and says so", async () => {
    const m = machine()
    const result = await start(m, 30).result
    expect(result.status).toBe("error")
    expect(result.problem).toBe(timeoutProblem("Claude Code", 30))
    expect(m.kills).toEqual([{ tree: true }])
    expect(turnsRunning("claude")).toBe(0)
  })

  test("the limit is five minutes unless the request says otherwise, and is said plainly", () => {
    expect(TURN_TIMEOUT_MS).toBe(300_000)
    expect(TURN_EXIT_GRACE_MS).toBe(10_000)
    expect(timeoutProblem("Codex", TURN_TIMEOUT_MS)).toBe("Codex non ha finito il turno in 5 minuti: l'ho fermato.")
    expect(timeoutProblem("Codex", 60_000)).toBe("Codex non ha finito il turno in 1 minuto: l'ho fermato.")
    expect(timeoutProblem("Codex", 90_000)).toBe("Codex non ha finito il turno in 90 secondi: l'ho fermato.")
  })

  test("stop ends the wait even though a killed session reports no exit", async () => {
    const m = machine()
    const turn = start(m)
    await tick()
    turn.stop()
    const result = await turn.result
    expect(result.status).toBe("stopped")
    expect(m.kills).toEqual([{ tree: true }])
    expect(turnsRunning("claude")).toBe(0)
  })

  test("the turn is over at Claude Code's result, without waiting for the process to exit", async () => {
    const m = machine()
    const turn = start(m)
    await tick()
    m.say(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Tre sessioni aperte." }] } }))
    m.say(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Tre sessioni aperte." }))
    const result = await turn.result
    expect(result.status).toBe("done")
    expect(result.text).toBe("Tre sessioni aperte.")
    expect(m.kills).toEqual([])
    expect(turnsRunning("claude")).toBe(0)
    // The exit arriving afterwards changes nothing.
    m.exit(0)
  })

  test("a CLI that does not exit after its result is killed with its children", async () => {
    const m = machine()
    const turn = runTurn({ runner: "claude", message: "ciao", exitGraceMs: 30 }, m.deps)
    await tick()
    m.say(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Fatto." }))
    expect((await turn.result).status).toBe("done")
    expect(m.kills).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(m.kills).toEqual([{ tree: true }])
  })

  test("a CLI that exits within the grace after its result is left alone", async () => {
    const m = machine()
    const turn = runTurn({ runner: "claude", message: "ciao", exitGraceMs: 30 }, m.deps)
    await tick()
    m.say(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Fatto." }))
    await turn.result
    m.exit(0)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(m.kills).toEqual([])
  })

  test("a turn that exits on its own is done and kills nothing", async () => {
    const m = machine()
    const turn = start(m)
    await tick()
    m.exit(0)
    expect((await turn.result).status).toBe("done")
    expect(m.kills).toEqual([])
  })

  test("the plan's parallel-turn cap holds for turns, and a finished one frees its slot", async () => {
    const m = machine()
    const running = Array.from({ length: MAX_PARALLEL_TURNS }, () => start(m))
    await tick()
    expect(turnsRunning("claude")).toBe(MAX_PARALLEL_TURNS)

    const refused = await start(m).result
    expect(refused.status).toBe("error")
    expect(refused.problem).toBeTruthy()

    running[0]!.stop()
    await running[0]!.result
    const next = start(m)
    await tick()
    expect(turnsRunning("claude")).toBe(MAX_PARALLEL_TURNS)
    m.exit(0)
    expect((await next.result).status).toBe("done")
  })
})

/*
 * From ade/voice-0.6.0 (3e04e88dd), the same fix found in the voice trial:
 * spoken questions cut short by newer ones used to leak a slot each.
 */
describe("bots/turn, stopped by newer questions", () => {
  test("four stopped turns in a row each end and give their slot back", async () => {
    const m = machine()
    for (let i = 0; i < 4; i++) {
      const turn = runTurn({ runner: "claude", message: `domanda ${i}` }, m.deps)
      await tick()
      turn.stop()
      expect((await turn.result).status).toBe("stopped")
    }
    expect(m.kills).toHaveLength(4)
    expect(turnsRunning("claude")).toBe(0)
  })

  test("a turn stopped before its process started is killed as soon as it starts, and ends", async () => {
    const m = machine()
    const turn = runTurn({ runner: "claude", message: "subito fermata" }, m.deps)
    turn.stop()
    expect((await turn.result).status).toBe("stopped")
    expect(m.kills).toEqual([{ tree: true }])
    expect(turnsRunning("claude")).toBe(0)
  })
})

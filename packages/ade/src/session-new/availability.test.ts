import { describe, expect, test } from "bun:test"
import { AGENTS } from "./agents"
import { defaultAgentId, detectAgents, isProbeable, startable } from "./availability"

const answeringFor = (installed: string[]) => async (command: string) =>
  installed.includes(command) ? `C:\\bin\\${command}.exe\n` : null

describe("detectAgents", () => {
  test("an agent the lookup finds is present, and carries where it was found", async () => {
    const statuses = await detectAgents(answeringFor(["claude", "agy"]))
    const claude = statuses.find((s) => s.agent.command === "claude")
    expect(claude?.availability).toBe("presente")
    expect(claude?.path).toBe("C:\\bin\\claude.exe")
  })

  test("an agent whose probe does not answer is absent, not merely unlisted", async () => {
    const statuses = await detectAgents(answeringFor(["claude"]))
    const kimi = statuses.find((s) => s.agent.command === "kimi")
    expect(kimi?.availability).toBe("assente")
    expect(statuses.length).toBe(AGENTS.length)
  })

  test("a probe that throws counts as absent rather than crashing detection", async () => {
    const statuses = await detectAgents(async () => {
      throw new Error("PATH esploso")
    })
    expect(statuses.every((s) => !isProbeable(s.agent) || s.availability === "assente")).toBe(true)
  })

  test("with no probe nothing is claimed absent", async () => {
    const statuses = await detectAgents(undefined)
    expect(statuses.some((s) => s.availability === "assente")).toBe(false)
    expect(statuses.filter((s) => isProbeable(s.agent)).every((s) => s.availability === "sconosciuto")).toBe(true)
  })

  /*
   * The terminal is probed like everything else now, because it finally names
   * a real program. It used to carry an empty command and be reported present
   * on that basis — and `startProcess` refuses an empty command, so choosing
   * Terminal produced a pane stuck at "Inizializzazione" with no error.
   */
  test("the terminal names a shell, and is probed for it", async () => {
    const probed: string[] = []
    const statuses = await detectAgents(async (command) => {
      probed.push(command)
      return "ok"
    })

    const terminal = statuses.find((s) => s.agent.id === "terminal")
    expect(terminal?.agent.command.length).toBeGreaterThan(0)
    expect(probed).toContain(terminal?.agent.command ?? "")
    expect(terminal?.availability).toBe("presente")
  })

  test("a shell PATH cannot find is reported absent, not silently broken", async () => {
    const statuses = await detectAgents(answeringFor(["claude"]))
    expect(statuses.find((s) => s.agent.id === "terminal")?.availability).toBe("assente")
  })
})

describe("startable", () => {
  test("drops only the agents known to be absent", async () => {
    const shell = AGENTS.find((a) => a.id === "terminal")?.command ?? ""
    const statuses = await detectAgents(answeringFor(["claude", shell]))
    const ids = startable(statuses).map((s) => s.agent.id)
    expect(ids).toContain("claude-code")
    expect(ids).toContain("terminal")
    expect(ids).not.toContain("kimi")
  })
})

describe("defaultAgentId", () => {
  test("prefers an installed agent over the catalogue order", async () => {
    const statuses = await detectAgents(answeringFor(["kimi"]))
    expect(defaultAgentId(statuses)).toBe("kimi")
  })

  test("never preselects an agent known to be absent", async () => {
    const statuses = await detectAgents(answeringFor([]))
    expect(defaultAgentId(statuses)).toBeUndefined()
  })

  test("falls back to an unknown agent when nothing can be probed", async () => {
    const statuses = await detectAgents(undefined)
    expect(defaultAgentId(statuses)).toBe(AGENTS.find(isProbeable)?.id)
  })
})

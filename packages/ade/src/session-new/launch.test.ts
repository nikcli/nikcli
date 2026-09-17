import { describe, expect, test } from "bun:test"
import { AGENTS } from "./agents"
import { willLaunch } from "./launch"

describe("willLaunch", () => {
  /*
   * These assertions only mean something now.
   *
   * `willLaunch` drew the "Partirà" preview while the launch itself ran
   * `for (i < count) addAgent(input, i)`, ignoring roles and slots entirely —
   * so "Banco di lavoro" promised an agent and a shell and started two copies
   * of the same agent. The preview and the launch now read the same list, and
   * the case below is the one where they used to disagree.
   */
  test("every id a preset invents is an agent the catalogue can actually start", () => {
    const invented = willLaunch({ preset: "workbench", agentId: "agy", count: 2 })
      .map((entry) => entry.agentId)
      .filter((id) => id !== "agy")

    expect(invented.length).toBeGreaterThan(0)
    for (const id of invented) {
      const agent = AGENTS.find((a) => a.id === id)
      expect(agent).toBeDefined()
      // An empty command is what `startProcess` refuses in silence, leaving
      // the pane on "Inizializzazione" for the rest of the session.
      expect(agent?.command.length).toBeGreaterThan(0)
    }
  })

  describe("without preset", () => {
    test("assigns agent role and agentId to all entries", () => {
      const entries = willLaunch({ agentId: "claude-3-5-sonnet", count: 3 })
      expect(entries).toEqual([
        { index: 1, agentId: "claude-3-5-sonnet", role: "agent" },
        { index: 2, agentId: "claude-3-5-sonnet", role: "agent" },
        { index: 3, agentId: "claude-3-5-sonnet", role: "agent" },
      ])
    })

    test("returns single agent for count 1", () => {
      const entries = willLaunch({ agentId: "gpt-4o", count: 1 })
      expect(entries).toEqual([{ index: 1, agentId: "gpt-4o", role: "agent" }])
    })

    test("returns empty array for count 0", () => {
      const entries = willLaunch({ agentId: "gpt-4o", count: 0 })
      expect(entries).toEqual([])
    })
  })

  describe("solo preset", () => {
    test("produces single agent entry at default count 1", () => {
      const entries = willLaunch({ preset: "solo", agentId: "agent-1", count: 1 })
      expect(entries).toEqual([{ index: 1, agentId: "agent-1", role: "agent" }])
    })

    test("keeps extra slots as plain agents when count is raised above 1", () => {
      const entries = willLaunch({ preset: "solo", agentId: "agent-1", count: 3 })
      expect(entries).toEqual([
        { index: 1, agentId: "agent-1", role: "agent" },
        { index: 2, agentId: "agent-1", role: "agent" },
        { index: 3, agentId: "agent-1", role: "agent" },
      ])
    })
  })

  describe("pair preset", () => {
    test("configures slot 1 as agent and slot 2 as reviewer", () => {
      const entries = willLaunch({ preset: "pair", agentId: "agent-pair", count: 2 })
      expect(entries).toEqual([
        { index: 1, agentId: "agent-pair", role: "agent" },
        { index: 2, agentId: "agent-pair", role: "reviewer" },
      ])
    })

    test("applies reviewer only to slot 2 and plain agents to higher slots when count is raised", () => {
      const entries = willLaunch({ preset: "pair", agentId: "agent-pair", count: 4 })
      expect(entries).toEqual([
        { index: 1, agentId: "agent-pair", role: "agent" },
        { index: 2, agentId: "agent-pair", role: "reviewer" },
        { index: 3, agentId: "agent-pair", role: "agent" },
        { index: 4, agentId: "agent-pair", role: "agent" },
      ])
    })

    test("configures single agent when count is lowered below preset definition to 1", () => {
      const entries = willLaunch({ preset: "pair", agentId: "agent-pair", count: 1 })
      expect(entries).toEqual([{ index: 1, agentId: "agent-pair", role: "agent" }])
    })
  })

  describe("workbench preset", () => {
    test("configures slot 1 as agent and slot 2 as shell with terminal agentId", () => {
      const entries = willLaunch({ preset: "workbench", agentId: "agent-wb", count: 2 })
      expect(entries).toEqual([
        { index: 1, agentId: "agent-wb", role: "agent" },
        { index: 2, agentId: "terminal", role: "shell" },
      ])
    })

    test("keeps terminal shell at slot 2 and plain agents for slots 3+ when count is raised", () => {
      const entries = willLaunch({ preset: "workbench", agentId: "agent-wb", count: 4 })
      expect(entries).toEqual([
        { index: 1, agentId: "agent-wb", role: "agent" },
        { index: 2, agentId: "terminal", role: "shell" },
        { index: 3, agentId: "agent-wb", role: "agent" },
        { index: 4, agentId: "agent-wb", role: "agent" },
      ])
    })

    test("configures single agent when count is lowered below preset definition to 1", () => {
      const entries = willLaunch({ preset: "workbench", agentId: "agent-wb", count: 1 })
      expect(entries).toEqual([{ index: 1, agentId: "agent-wb", role: "agent" }])
    })
  })

  describe("swarm preset", () => {
    test("configures 4 agent entries at default count 4", () => {
      const entries = willLaunch({ preset: "swarm", agentId: "agent-swarm", count: 4 })
      expect(entries).toEqual([
        { index: 1, agentId: "agent-swarm", role: "agent" },
        { index: 2, agentId: "agent-swarm", role: "agent" },
        { index: 3, agentId: "agent-swarm", role: "agent" },
        { index: 4, agentId: "agent-swarm", role: "agent" },
      ])
    })

    test("configures all entries as agents when count is raised to 6", () => {
      const entries = willLaunch({ preset: "swarm", agentId: "agent-swarm", count: 6 })
      expect(entries).toHaveLength(6)
      for (const [idx, entry] of entries.entries()) {
        expect(entry).toEqual({
          index: idx + 1,
          agentId: "agent-swarm",
          role: "agent",
        })
      }
    })

    test("configures all entries as agents when count is lowered to 2", () => {
      const entries = willLaunch({ preset: "swarm", agentId: "agent-swarm", count: 2 })
      expect(entries).toEqual([
        { index: 1, agentId: "agent-swarm", role: "agent" },
        { index: 2, agentId: "agent-swarm", role: "agent" },
      ])
    })
  })
})

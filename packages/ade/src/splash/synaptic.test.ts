import { describe, expect, test } from "bun:test"
import {
  AXIS,
  CENTER_Y,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  SWARM_NODES,
  SYNAPSE_EDGES,
  SYNAPTIC_ORIGIN,
  TONE,
  synapticShade,
} from "./synaptic"

describe("Synaptic Agent Swarm NiK", () => {
  test("nodes stand inside the scene bounds with margin", () => {
    for (const node of SWARM_NODES) {
      expect(node.x).toBeGreaterThan(16)
      expect(node.x).toBeLessThan(SCENE_WIDTH - 16)
      expect(node.y).toBeGreaterThan(16)
      expect(node.y).toBeLessThan(SCENE_HEIGHT - 16)
    }
  })

  test("contains nodes for N, i, K and orbiting agents", () => {
    const letters = new Set(SWARM_NODES.map((n) => n.letter))
    expect(letters.has("N")).toBe(true)
    expect(letters.has("i")).toBe(true)
    expect(letters.has("K")).toBe(true)
    expect(letters.has("orbit")).toBe(true)
  })

  test("letter N is on the left, i in the center, K on the right", () => {
    const nNodes = SWARM_NODES.filter((n) => n.letter === "N")
    const iNodes = SWARM_NODES.filter((n) => n.letter === "i")
    const kNodes = SWARM_NODES.filter((n) => n.letter === "K")

    const avgX = (nodes: typeof SWARM_NODES) =>
      nodes.reduce((acc, n) => acc + n.x, 0) / nodes.length

    expect(avgX(nNodes)).toBeLessThan(avgX(iNodes))
    expect(avgX(iNodes)).toBeLessThan(avgX(kNodes))
    expect(Math.abs(avgX(iNodes) - AXIS)).toBeLessThanOrEqual(4)
  })

  test("synapse edges connect valid nodes with nonzero distance", () => {
    expect(SYNAPSE_EDGES.length).toBeGreaterThan(20)
    for (const edge of SYNAPSE_EDGES) {
      expect(edge.p1).toBeDefined()
      expect(edge.p2).toBeDefined()
      const d = Math.hypot(edge.p2.x - edge.p1.x, edge.p2.y - edge.p1.y)
      expect(d).toBeGreaterThan(0)
      expect(d).toBeLessThan(60) // no runaway filaments
    }
  })

  test("tones are strictly ordered from field to node", () => {
    expect(TONE.field).toBeLessThan(TONE.synapse)
    expect(TONE.synapse).toBeLessThan(TONE.impulse)
    expect(TONE.impulse).toBeLessThan(TONE.node)
  })

  test("synapticShade returns valid tones within the constellation", () => {
    // Center node i_dot at (96, 44)
    const dotShade = synapticShade(96, 44, 0)
    expect(dotShade).toBeDefined()
    expect(dotShade).toBe(TONE.node)

    // Empty corner
    expect(synapticShade(2, 2, 0)).toBeUndefined()
    expect(synapticShade(SCENE_WIDTH - 2, SCENE_HEIGHT - 2, 0)).toBeUndefined()
  })

  test("origin point is centered", () => {
    expect(SYNAPTIC_ORIGIN.x).toBe(AXIS)
    expect(SYNAPTIC_ORIGIN.y).toBeLessThan(CENTER_Y)
  })
})

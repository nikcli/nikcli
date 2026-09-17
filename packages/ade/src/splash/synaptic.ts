/**
 * Concept 04: Synaptic Agent Swarm (NiK) in 3D ASCII.
 *
 * Represents ADE (Agent Development Environment) as a living, rotating 3D neural
 * constellation of collaborating agents. Nodes form the typography "NiK" in 3D
 * space, connected by synaptic filaments that carry electrical message impulses.
 *
 * Features real-time 3D perspective projection, orbital agent particle swarm,
 * and pure high-resolution ASCII glyph rasterization.
 */

export const SCENE_WIDTH = 192
export const SCENE_HEIGHT = 144

/** The swarm is centered in the scene. */
export const AXIS = 96
export const CENTER_Y = 70

/** Synaptic origin where telemetry and new agent events spawn. */
export const SYNAPTIC_ORIGIN = { x: AXIS, y: 52 } as const
/** Backward compatibility alias for scene.ts tests. */
export const BONG_MOUTH = SYNAPTIC_ORIGIN

/**
 * Tones for brightness sampling, dark to light.
 */
export const TONE = {
  field: 0.12,
  synapse: 0.42,
  impulse: 0.78,
  node: 0.98,
  glass: 0.12,
  water: 0.42,
  highlight: 0.78,
  edge: 0.98,
} as const

export interface Point3D {
  x: number
  y: number
  z: number
}

export interface Swarm3DNode extends Point3D {
  id: string
  char: string
  letter: "N" | "i" | "K" | "orbit"
  pulseSpeed: number
  pulsePhase: number
}

export interface Synapse3DEdge {
  fromIndex: number
  toIndex: number
}

// ── 3D Nodes Definition for Typography "NiK" ──────────────────────────────
export const SWARM_3D_NODES: Swarm3DNode[] = [
  // ── Letter N ────────────────────────────────────────────────────────────
  // Left vertical column
  { id: "n_l1", x: -6.5, y: -5.0, z: -0.4, char: "N", letter: "N", pulseSpeed: 2.0, pulsePhase: 0.0 },
  { id: "n_l2", x: -6.5, y: -3.0, z: -0.2, char: "#", letter: "N", pulseSpeed: 2.1, pulsePhase: 0.3 },
  { id: "n_l3", x: -6.5, y: -1.0, z: 0.0,  char: "+", letter: "N", pulseSpeed: 2.3, pulsePhase: 0.6 },
  { id: "n_l4", x: -6.5, y: 1.0,  z: 0.2,  char: "+", letter: "N", pulseSpeed: 2.4, pulsePhase: 0.9 },
  { id: "n_l5", x: -6.5, y: 3.0,  z: 0.4,  char: "#", letter: "N", pulseSpeed: 2.2, pulsePhase: 1.2 },
  { id: "n_l6", x: -6.5, y: 5.0,  z: 0.6,  char: "N", letter: "N", pulseSpeed: 1.9, pulsePhase: 1.5 },

  // Diagonal
  { id: "n_d1", x: -5.7, y: 3.0,  z: 0.4,  char: "\\", letter: "N", pulseSpeed: 2.5, pulsePhase: 0.5 },
  { id: "n_d2", x: -4.9, y: 1.0,  z: 0.2,  char: "*", letter: "N", pulseSpeed: 2.6, pulsePhase: 0.8 },
  { id: "n_d3", x: -4.1, y: -1.0, z: 0.0,  char: "x", letter: "N", pulseSpeed: 2.7, pulsePhase: 1.1 },
  { id: "n_d4", x: -3.3, y: -3.0, z: -0.2, char: "\\", letter: "N", pulseSpeed: 2.4, pulsePhase: 1.4 },

  // Right vertical column
  { id: "n_r1", x: -2.5, y: -5.0, z: -0.4, char: "N", letter: "N", pulseSpeed: 1.9, pulsePhase: 0.2 },
  { id: "n_r2", x: -2.5, y: -3.0, z: -0.2, char: "#", letter: "N", pulseSpeed: 2.2, pulsePhase: 0.5 },
  { id: "n_r3", x: -2.5, y: -1.0, z: 0.0,  char: "+", letter: "N", pulseSpeed: 2.4, pulsePhase: 0.8 },
  { id: "n_r4", x: -2.5, y: 1.0,  z: 0.2,  char: "+", letter: "N", pulseSpeed: 2.3, pulsePhase: 1.1 },
  { id: "n_r5", x: -2.5, y: 3.0,  z: 0.4,  char: "#", letter: "N", pulseSpeed: 2.1, pulsePhase: 1.4 },
  { id: "n_r6", x: -2.5, y: 5.0,  z: 0.6,  char: "N", letter: "N", pulseSpeed: 1.8, pulsePhase: 1.7 },

  // ── Letter i ────────────────────────────────────────────────────────────
  // Dot of the i (central glowing coordinator)
  { id: "i_dot", x: 0.0, y: 4.8, z: 0.8, char: "@", letter: "i", pulseSpeed: 3.2, pulsePhase: 0.0 },
  // Stem
  { id: "i_s1", x: 0.0, y: 2.2, z: 0.4, char: "i", letter: "i", pulseSpeed: 2.5, pulsePhase: 0.4 },
  { id: "i_s2", x: 0.0, y: 0.4, z: 0.2, char: "|", letter: "i", pulseSpeed: 2.6, pulsePhase: 0.8 },
  { id: "i_s3", x: 0.0, y: -1.4, z: 0.0, char: "+", letter: "i", pulseSpeed: 2.3, pulsePhase: 1.2 },
  { id: "i_s4", x: 0.0, y: -3.2, z: -0.2, char: "#", letter: "i", pulseSpeed: 2.1, pulsePhase: 1.5 },
  { id: "i_s5", x: 0.0, y: -5.0, z: -0.4, char: "*", letter: "i", pulseSpeed: 1.9, pulsePhase: 1.8 },

  // ── Letter K ────────────────────────────────────────────────────────────
  // Vertical stem
  { id: "k_s1", x: 2.8, y: -5.0, z: -0.4, char: "K", letter: "K", pulseSpeed: 2.0, pulsePhase: 0.1 },
  { id: "k_s2", x: 2.8, y: -3.0, z: -0.2, char: "#", letter: "K", pulseSpeed: 2.2, pulsePhase: 0.4 },
  { id: "k_s3", x: 2.8, y: -1.0, z: 0.0,  char: "+", letter: "K", pulseSpeed: 2.5, pulsePhase: 0.7 },
  { id: "k_s4", x: 2.8, y: 1.0,  z: 0.2,  char: "+", letter: "K", pulseSpeed: 2.6, pulsePhase: 1.0 },
  { id: "k_s5", x: 2.8, y: 3.0,  z: 0.4,  char: "#", letter: "K", pulseSpeed: 2.2, pulsePhase: 1.3 },
  { id: "k_s6", x: 2.8, y: 5.0,  z: 0.6,  char: "K", letter: "K", pulseSpeed: 1.8, pulsePhase: 1.6 },

  // Upper branch
  { id: "k_u1", x: 4.2, y: 1.2,  z: 0.3, char: "/", letter: "K", pulseSpeed: 2.4, pulsePhase: 0.6 },
  { id: "k_u2", x: 5.7, y: 3.1,  z: 0.5, char: "*", letter: "K", pulseSpeed: 2.5, pulsePhase: 0.9 },
  { id: "k_u3", x: 7.2, y: 5.0,  z: 0.7, char: "K", letter: "K", pulseSpeed: 2.1, pulsePhase: 1.2 },

  // Lower branch
  { id: "k_d1", x: 4.2, y: -1.2, z: -0.1, char: "\\", letter: "K", pulseSpeed: 2.4, pulsePhase: 0.8 },
  { id: "k_d2", x: 5.7, y: -3.1, z: -0.3, char: "*", letter: "K", pulseSpeed: 2.5, pulsePhase: 1.1 },
  { id: "k_d3", x: 7.2, y: -5.0, z: -0.5, char: "k", letter: "K", pulseSpeed: 2.0, pulsePhase: 1.4 },

  // Orbiting agent sentinels
  { id: "orb_1", x: -8.5, y: 3.5, z: 1.8, char: "o", letter: "orbit", pulseSpeed: 1.5, pulsePhase: 0.7 },
  { id: "orb_2", x: -8.5, y: -3.5, z: -1.8, char: "•", letter: "orbit", pulseSpeed: 1.4, pulsePhase: 1.9 },
  { id: "orb_3", x: 8.5, y: 3.5, z: 1.8, char: "o", letter: "orbit", pulseSpeed: 1.6, pulsePhase: 0.9 },
  { id: "orb_4", x: 8.5, y: -3.5, z: -1.8, char: "•", letter: "orbit", pulseSpeed: 1.5, pulsePhase: 1.7 },
]

// ── 3D Synaptic Edges ─────────────────────────────────────────────────────
export const SWARM_3D_EDGES: Synapse3DEdge[] = [
  // N left stem
  { fromIndex: 0, toIndex: 1 },
  { fromIndex: 1, toIndex: 2 },
  { fromIndex: 2, toIndex: 3 },
  { fromIndex: 3, toIndex: 4 },
  { fromIndex: 4, toIndex: 5 },
  // N diagonal
  { fromIndex: 5, toIndex: 6 },
  { fromIndex: 6, toIndex: 7 },
  { fromIndex: 7, toIndex: 8 },
  { fromIndex: 8, toIndex: 9 },
  { fromIndex: 9, toIndex: 10 },
  // N right stem
  { fromIndex: 10, toIndex: 11 },
  { fromIndex: 11, toIndex: 12 },
  { fromIndex: 12, toIndex: 13 },
  { fromIndex: 13, toIndex: 14 },
  { fromIndex: 14, toIndex: 15 },
  // Bridge N -> i
  { fromIndex: 14, toIndex: 16 },
  { fromIndex: 13, toIndex: 17 },
  // i stem
  { fromIndex: 16, toIndex: 17 },
  { fromIndex: 17, toIndex: 18 },
  { fromIndex: 18, toIndex: 19 },
  { fromIndex: 19, toIndex: 20 },
  { fromIndex: 20, toIndex: 21 },
  // Bridge i -> K
  { fromIndex: 16, toIndex: 26 },
  { fromIndex: 18, toIndex: 24 },
  // K vertical stem
  { fromIndex: 22, toIndex: 23 },
  { fromIndex: 23, toIndex: 24 },
  { fromIndex: 24, toIndex: 25 },
  { fromIndex: 25, toIndex: 26 },
  { fromIndex: 26, toIndex: 27 },
  // K upper arm
  { fromIndex: 24, toIndex: 28 },
  { fromIndex: 28, toIndex: 29 },
  { fromIndex: 29, toIndex: 30 },
  // K lower arm
  { fromIndex: 24, toIndex: 31 },
  { fromIndex: 31, toIndex: 32 },
  { fromIndex: 32, toIndex: 33 },
]

// ── Ambient 3D Agent Particle Halo ────────────────────────────────────────
export const AMBIENT_PARTICLES: Point3D[] = Array.from({ length: 90 }, (_, i) => {
  const theta = (i / 90) * Math.PI * 2
  const phi = ((i % 15) / 15 - 0.5) * Math.PI
  const radius = 10.0 + ((i * 7) % 6) * 0.9
  return {
    x: Math.cos(theta) * Math.cos(phi) * radius,
    y: Math.sin(phi) * radius * 0.75,
    z: Math.sin(theta) * Math.cos(phi) * radius * 0.85,
  }
})

export const AMBIENT_CHARS = ["·", "°", "*", "+", "o", "•", "."]

/**
 * Real-time 3D perspective projection onto 2D screen viewport.
 */
export function project3D(
  p: Point3D,
  rotY: number,
  rotX: number,
  width: number,
  height: number,
  fov = 24
): { sx: number; sy: number; scale: number; depth: number } {
  const cosY = Math.cos(rotY)
  const sinY = Math.sin(rotY)
  const x1 = p.x * cosY - p.z * sinY
  const z1 = p.x * sinY + p.z * cosY

  const cosX = Math.cos(rotX)
  const sinX = Math.sin(rotX)
  const y1 = p.y * cosX - z1 * sinX
  const z2 = p.y * sinX + z1 * cosX

  const cameraDistance = 22
  const depth = z2 + cameraDistance
  const scale = depth > 0.5 ? fov / depth : 1.0

  const unit = Math.min(width, height) / 18
  const sx = width / 2 + x1 * scale * unit
  const sy = height / 2 - y1 * scale * unit

  return { sx, sy, scale, depth: z2 }
}

// ── Legacy 2D Compatibility Exports for Tests ─────────────────────────────
export interface SwarmNode {
  id: string
  x: number
  y: number
  char: string
  letter: "N" | "i" | "K" | "orbit"
  radius: number
  pulseSpeed: number
  pulsePhase: number
}

export interface SynapseEdge {
  from: string
  to: string
  p1: { x: number; y: number }
  p2: { x: number; y: number }
}

export const SWARM_NODES: SwarmNode[] = SWARM_3D_NODES.map((n) => ({
  id: n.id,
  x: Math.round(AXIS + n.x * 6.5),
  y: Math.round(CENTER_Y - n.y * 5.5),
  char: n.char,
  letter: n.letter,
  radius: 2.5,
  pulseSpeed: n.pulseSpeed,
  pulsePhase: n.pulsePhase,
}))

export const SYNAPSE_EDGES: SynapseEdge[] = SWARM_3D_EDGES.map((e) => ({
  from: SWARM_NODES[e.fromIndex]!.id,
  to: SWARM_NODES[e.toIndex]!.id,
  p1: { x: SWARM_NODES[e.fromIndex]!.x, y: SWARM_NODES[e.fromIndex]!.y },
  p2: { x: SWARM_NODES[e.toIndex]!.x, y: SWARM_NODES[e.toIndex]!.y },
}))

export function synapticShade(x: number, y: number, _time = 0): number | undefined {
  if (x < 12 || x >= SCENE_WIDTH - 12 || y < 14 || y >= SCENE_HEIGHT - 14) {
    return undefined
  }
  for (const node of SWARM_NODES) {
    if (Math.hypot(x - node.x, y - node.y) <= node.radius) return TONE.node
  }
  return undefined
}

export function insideStem(x: number, y: number): boolean {
  return synapticShade(x, y, 0) !== undefined
}

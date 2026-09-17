import { describe, expect, test } from "bun:test"
import { MAX_SESSIONS, MIN_SESSIONS, PRESETS, clampSessions, configurationLabel, presetForCount } from "./preset"

describe("PRESETS", () => {
  test("defines all four presets in the required order", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["solo", "pair", "workbench", "swarm"])
  })

  test("defines correct Italian labels and session counts", () => {
    expect(PRESETS).toEqual([
      {
        id: "solo",
        label: "Solo",
        sessions: 1,
        description: "Un agente in un terminale.",
      },
      {
        id: "pair",
        label: "Coppia",
        sessions: 2,
        description: "Uno sviluppa, uno revisiona lo stesso albero.",
      },
      {
        id: "workbench",
        label: "Banco di lavoro",
        sessions: 2,
        description: "Un agente più una shell per git e test.",
      },
      {
        id: "swarm",
        label: "Sciame",
        sessions: 4,
        description: "Quattro agenti si distribuiscono su task paralleli.",
      },
    ])
  })

  test("defines session bounds", () => {
    expect(MIN_SESSIONS).toBe(1)
    expect(MAX_SESSIONS).toBe(6)
  })
})

describe("clampSessions", () => {
  test("clamps values below MIN_SESSIONS to 1", () => {
    expect(clampSessions(0)).toBe(1)
    expect(clampSessions(-1)).toBe(1)
    expect(clampSessions(-999)).toBe(1)
    expect(clampSessions(Number.NaN)).toBe(1)
  })

  test("clamps values above MAX_SESSIONS to 6", () => {
    expect(clampSessions(7)).toBe(6)
    expect(clampSessions(10)).toBe(6)
    expect(clampSessions(100)).toBe(6)
  })

  test("preserves valid session counts in range [1, 6]", () => {
    for (let count = 1; count <= 6; count++) {
      expect(clampSessions(count)).toBe(count)
    }
  })
})

describe("presetForCount and ambiguity rule", () => {
  test("returns unique matching preset when session count is unambiguous", () => {
    expect(presetForCount(1)?.id).toBe("solo")
    expect(presetForCount(4)?.id).toBe("swarm")
  })

  test("returns undefined for count 2 because pair and workbench are ambiguous", () => {
    // Both 'pair' and 'workbench' have 2 sessions with distinct role behaviors.
    // Count alone cannot disambiguate user intent without an explicit preset choice.
    expect(presetForCount(2)).toBeUndefined()
  })

  test("returns undefined for counts that match no preset", () => {
    expect(presetForCount(3)).toBeUndefined()
    expect(presetForCount(5)).toBeUndefined()
    expect(presetForCount(6)).toBeUndefined()
    expect(presetForCount(0)).toBeUndefined()
    expect(presetForCount(7)).toBeUndefined()
  })
})

describe("configurationLabel", () => {
  test("returns preset label when count matches the preset", () => {
    expect(configurationLabel({ preset: "solo", count: 1 })).toBe("Solo")
    expect(configurationLabel({ preset: "pair", count: 2 })).toBe("Coppia")
    expect(configurationLabel({ preset: "workbench", count: 2 })).toBe("Banco di lavoro")
    expect(configurationLabel({ preset: "swarm", count: 4 })).toBe("Sciame")
  })

  test("returns 'Personalizzata' when count is raised above preset definition", () => {
    expect(configurationLabel({ preset: "solo", count: 2 })).toBe("Personalizzata")
    expect(configurationLabel({ preset: "pair", count: 3 })).toBe("Personalizzata")
    expect(configurationLabel({ preset: "workbench", count: 3 })).toBe("Personalizzata")
    expect(configurationLabel({ preset: "swarm", count: 5 })).toBe("Personalizzata")
  })

  test("returns 'Personalizzata' when count is lowered below preset definition", () => {
    expect(configurationLabel({ preset: "pair", count: 1 })).toBe("Personalizzata")
    expect(configurationLabel({ preset: "workbench", count: 1 })).toBe("Personalizzata")
    expect(configurationLabel({ preset: "swarm", count: 3 })).toBe("Personalizzata")
  })

  test("returns 'Personalizzata' when no preset is selected", () => {
    expect(configurationLabel({ count: 1 })).toBe("Personalizzata")
    expect(configurationLabel({ count: 2 })).toBe("Personalizzata")
    expect(configurationLabel({ count: 4 })).toBe("Personalizzata")
    expect(configurationLabel({ count: 6 })).toBe("Personalizzata")
  })
})

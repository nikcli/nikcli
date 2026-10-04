import { describe, expect, test } from "bun:test"
import { GadgetError, LIMITS, parseHello, slugify, treeProblem, type Hello } from "../src/protocol.ts"

const base: Hello = {
  protocol: 1,
  name: "pi office",
  version: "1.0.0",
  platform: { os: "linux", arch: "arm64" },
  commands: [{ name: "system.run", description: "run", args: { type: "object" } }],
}

describe("parseHello", () => {
  test("accepts a valid declaration and trims the name", () => {
    const hello = parseHello({ ...base, name: "  pi office " })
    expect(hello.name).toBe("pi office")
    expect(hello.commands[0]?.name).toBe("system.run")
  })

  test("refuses a bad command name without loading the valid subset", () => {
    expect(() =>
      parseHello({
        ...base,
        commands: [...base.commands, { name: "Bad", description: "x", args: { type: "object" } }],
      }),
    ).toThrow(/commands\[1\]\.name/)
  })

  test("refuses a duplicate command, a bad protocol, a bad button key", () => {
    expect(() => parseHello({ ...base, commands: [...base.commands, ...base.commands] })).toThrow(/declared twice/)
    expect(() => parseHello({ ...base, protocol: 2 })).toThrow(/protocol must be 1/)
    expect(() => parseHello({ ...base, buttons: ["OK"] })).toThrow(/not a lowercase key/)
  })

  test("caps timeout and output limits", () => {
    expect(() =>
      parseHello({ ...base, commands: [{ ...base.commands[0]!, timeoutMs: LIMITS.MAX_TIMEOUT_MS + 1 }] }),
    ).toThrow(/timeoutMs/)
    expect(() =>
      parseHello({ ...base, commands: [{ ...base.commands[0]!, maxOutputBytes: LIMITS.MAX_OUTPUT_BYTES + 1 }] }),
    ).toThrow(/maxOutputBytes/)
  })

  test("the failure is a GadgetError.HelloInvalid with a status", () => {
    try {
      parseHello({})
      throw new Error("did not throw")
    } catch (error) {
      expect(error).toBeInstanceOf(GadgetError)
      expect((error as GadgetError).tag).toBe("HelloInvalid")
      expect((error as GadgetError).status).toBe(400)
    }
  })
})

describe("treeProblem", () => {
  test("accepts a bounded tree", () => {
    expect(
      treeProblem({
        type: "Box",
        props: {},
        children: [
          { type: "Text", props: {}, children: ["hi"] },
          { type: "Button", key: "ok", props: { label: "OK" } },
        ],
      }),
    ).toBeUndefined()
  })

  test("names depth, node count, text and shape problems", () => {
    let deep: unknown = { type: "Text", props: {}, children: ["x"] }
    for (let i = 0; i < LIMITS.TREE_MAX_DEPTH + 1; i++) deep = { type: "Box", props: {}, children: [deep] }
    expect(treeProblem(deep)).toMatch(/deeper/)
    const wide = {
      type: "Box",
      props: {},
      children: Array.from({ length: LIMITS.TREE_MAX_NODES + 1 }, () => ({ type: "Text", props: {}, children: [] })),
    }
    expect(treeProblem(wide)).toMatch(/nodes/)
    expect(treeProblem({ type: "Markdown", props: { text: "x".repeat(LIMITS.TREE_MAX_TEXT + 1) } })).toMatch(
      /characters/,
    )
    expect(treeProblem({ type: "Button", props: { label: "x" } })).toMatch(/key/)
    expect(treeProblem({ type: "Image", props: {} })).toMatch(/unknown node type/)
    for (const bad of [
      { padding: 300_000 },
      { gap: 3e6 },
      { gap: 1e10 },
      { padding: -1 },
      { gap: 1.5 },
      { padding: Infinity },
      { gap: NaN },
      { padding: "3" },
    ]) {
      expect(treeProblem({ type: "Box", props: bad, children: ["a"] })).toMatch(/must be a whole number from 0 to 16/)
    }
    expect(treeProblem({ type: "Box", props: { gap: 16, padding: 16 }, children: ["a"] })).toBeUndefined()
  })
})

describe("GadgetError", () => {
  test("round-trips through JSON", () => {
    const error = new GadgetError("Busy", "one at a time", { retryAfterMs: 500 })
    const back = GadgetError.fromBody(JSON.parse(JSON.stringify(error)))
    expect(back?.tag).toBe("Busy")
    expect(back?.status).toBe(429)
    expect(back?.retryAfterMs).toBe(500)
    expect(GadgetError.fromBody({ error: { tag: "Nope" } })).toBeUndefined()
  })
})

describe("slugify and trimming on hostile input", () => {
  test("a run of dashes or spaces is linear, not quadratic", () => {
    const started = Date.now()
    expect(slugify("-".repeat(200_000) + "x" + "-".repeat(200_000))).toBe("x")
    expect(slugify(" ".repeat(200_000))).toBe("gadget")
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("slugify", () => {
  test("lowercases, dashes, falls back", () => {
    expect(slugify("Pi Office #2")).toBe("pi-office-2")
    expect(slugify("---")).toBe("gadget")
  })
})

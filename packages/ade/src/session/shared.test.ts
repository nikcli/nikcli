import { describe, expect, test } from "bun:test"
import { parseMessage } from "./mailbox"
import {
  KV_MAX_VALUE,
  MEMORY_HEADER,
  MEMORY_SOFT_LIMIT,
  applyKv,
  cacheHitPercent,
  emptySpace,
  memoryAddReply,
  memoryEntry,
  parseKvStore,
  statsTable,
  withMemoryEntry,
  type KvRequest,
} from "./shared"
import { planFork } from "../session-new/resume"

const alice = { id: "p1", title: "alice" }
const bob = { id: "p2", title: "bob" }
const req = (op: KvRequest["op"], key: string, value = "", extra: Partial<KvRequest> = {}): KvRequest => ({
  op,
  key,
  value,
  ttl: 0,
  force: false,
  ...extra,
})
const everyoneAlive = () => true

describe("kv store", () => {
  test("set, get, list, del", () => {
    let space = emptySpace()
    space = applyKv(space, req("set", "build/status", "verde"), alice, 1000, everyoneAlive).space
    expect(applyKv(space, req("get", "build/status"), bob, 2000, everyoneAlive).reply).toBe("ok\nverde")
    expect(applyKv(space, req("list", "build/"), bob, 2000, everyoneAlive).reply).toContain("build/status = verde  (alice")
    const deleted = applyKv(space, req("del", "build/status"), bob, 3000, everyoneAlive)
    expect(deleted.reply).toBe("ok: build/status cancellata")
    expect(applyKv(deleted.space, req("get", "build/status"), bob, 3000, everyoneAlive).reply).toStartWith("errore")
  })

  test("reads are free, writes need a proven session", () => {
    const space = applyKv(emptySpace(), req("set", "k", "v"), alice, 0, everyoneAlive).space
    expect(applyKv(space, req("get", "k"), undefined, 0, everyoneAlive).reply).toBe("ok\nv")
    for (const op of ["set", "del", "lock", "unlock"] as const) {
      expect(applyKv(space, req(op, "k", "x"), undefined, 0, everyoneAlive).reply).toStartWith("errore")
    }
  })

  test("a lock keeps others out until it is released, expires, or its owner is gone", () => {
    let space = applyKv(emptySpace(), req("lock", "src/auth", "refactor", { ttl: 60 }), alice, 0, everyoneAlive).space
    expect(applyKv(space, req("lock", "src/auth"), bob, 1000, everyoneAlive).reply).toContain('bloccata da "alice"')
    expect(applyKv(space, req("set", "src/auth", "x"), bob, 1000, everyoneAlive).reply).toStartWith("errore")
    expect(applyKv(space, req("unlock", "src/auth"), bob, 1000, everyoneAlive).reply).toStartWith("errore")
    expect(applyKv(space, req("unlock", "src/auth", "", { force: true }), bob, 1000, everyoneAlive).reply).toBe("ok: src/auth rilasciata")
    // Expired.
    expect(applyKv(space, req("lock", "src/auth"), bob, 61_000, everyoneAlive).reply).toStartWith("ok")
    // Owner gone.
    expect(applyKv(space, req("lock", "src/auth"), bob, 1000, (id) => id !== "p1").reply).toStartWith("ok")
    space = applyKv(space, req("unlock", "src/auth"), alice, 2000, everyoneAlive).space
    expect(space.locks["src/auth"]).toBeUndefined()
  })

  test("limits and keys", () => {
    expect(applyKv(emptySpace(), req("set", "bad key", "v"), alice, 0, everyoneAlive).reply).toStartWith("errore")
    expect(applyKv(emptySpace(), req("set", "k", "x".repeat(KV_MAX_VALUE + 1)), alice, 0, everyoneAlive).reply).toStartWith("errore")
    expect(applyKv(emptySpace(), req("list", ""), alice, 0, everyoneAlive).reply).toBe("ok\n(vuoto)")
  })

  test("a saved store survives a round trip and drops what is malformed", () => {
    const space = applyKv(emptySpace(), req("set", "k", "v"), alice, 5, everyoneAlive).space
    const raw = JSON.stringify({ proj: space, junk: 3, other: { entries: { "bad key": { value: "v", by: "x", at: 1 } } } })
    const parsed = parseKvStore(raw)
    expect(parsed.proj).toEqual(space)
    expect(parsed.other).toEqual(emptySpace())
    expect(parseKvStore("nope")).toEqual({})
  })
})

describe("memory", () => {
  const at = new Date(2026, 8, 15, 9, 5)

  test("one line per entry, typed and signed", () => {
    expect(memoryEntry("Trappola", "bun test\nsu .tsx non\tcarica", "mario", at)).toEqual({
      line: "- [trappola] bun test su .tsx non carica — mario, 2026-09-15 09:05\n",
    })
    expect("error" in memoryEntry("idea", "x", "mario", at)).toBe(true)
    expect("error" in memoryEntry("fatto", "   ", "mario", at)).toBe(true)
    expect("error" in memoryEntry("fatto", "x".repeat(501), "mario", at)).toBe(true)
  })

  test("the header is written once", () => {
    const first = withMemoryEntry("", "- a\n")
    expect(first).toBe(`${MEMORY_HEADER}- a\n`)
    expect(withMemoryEntry(first, "- b\n")).toBe(`${MEMORY_HEADER}- a\n- b\n`)
  })

  test("a long memory is flagged", () => {
    expect(memoryAddReply("m.md", 10)).not.toContain("attenzione")
    expect(memoryAddReply("m.md", MEMORY_SOFT_LIMIT + 1)).toContain("attenzione")
  })
})

describe("cache stats", () => {
  test("hit rate over the whole prompt", () => {
    expect(cacheHitPercent({ input: 10, cacheRead: 900, cacheWrite: 90, output: 5, requests: 3 })).toBe(90)
    expect(cacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 })).toBeUndefined()
  })

  test("the table has a row per session and a total", () => {
    const table = statsTable([
      { title: "orchestra", agent: "claude-code", project: "nikcli", usage: { input: 100, cacheRead: 9900, cacheWrite: 0, output: 50, requests: 4 } },
      { title: "worker", agent: "codex", usage: { input: 1000, cacheRead: 1000, cacheWrite: 0, output: 10, requests: 1 } },
    ])
    expect(table).toContain("99%")
    expect(table).toContain("nikcli/orchestra (claude-code)")
    expect(table).toContain("totale")
    expect(statsTable([])).toContain("nessun dato")
  })
})

describe("messages and forks", () => {
  test("kv and memory messages parse", () => {
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "set", key: "k", text: "v" }))).toMatchObject({
      kind: "kv",
      op: "set",
      key: "k",
      text: "v",
      ttl: 0,
    })
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "list", key: "" }))).toMatchObject({ kind: "kv", op: "list" })
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "set", key: "k", text: " " }))).toBeUndefined()
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "drop", key: "k" }))).toBeUndefined()
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "lock", key: "k", ttl: 30.7 }))).toMatchObject({ ttl: 30 })
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "memory", op: "show" }))).toMatchObject({ kind: "memory", op: "show" })
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "memory", op: "add", type: "fatto", text: "x" }))).toMatchObject({ type: "fatto" })
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "spawn", agent: "claude", fork: true, text: "t" }))).toMatchObject({ fork: true })
  })

  test("a fork plan for the CLIs that can fork", () => {
    expect(planFork("claude-code", "parent", "child")).toEqual({
      args: ["--resume", "parent", "--fork-session", "--session-id", "child"],
      resumeId: "child",
    })
    expect(planFork("codex", "parent", "child")).toEqual({ args: ["fork", "parent"] })
    expect("error" in planFork("agy", "parent")).toBe(true)
    expect("error" in planFork("claude-code", undefined)).toBe(true)
  })
})

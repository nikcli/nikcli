import { describe, expect, it } from "bun:test"
import { SRC, stripComments } from "../tui/tui-source"

/**
 * The gate for `specs/storage/retire-database-wrapper.md`.
 *
 * That document plans the removal of the synchronous `Database` surface and
 * sequences it by group. A plan with a number in it and no check is a number
 * that drifts, so this asserts the direction of travel: the count may fall, and
 * may not rise.
 *
 * When a group lands, lower the baseline in the same change. When a new call
 * site is genuinely required, raise it deliberately and say why — do not widen
 * the tolerance.
 */

/**
 * Recorded 2026-09-11 after group 1 landed; `references` raised 2026-09-15.
 *
 * Counted over code only — `stripComments` first — because the comments in
 * `database.ts` name the APIs they are explaining, and a doc comment is not a
 * call site. Before stripping, the removal of `effect` and `use` read as no
 * change at all.
 *
 * The total was raised from 85 to 245 deliberately. Groups 3 and 4 replace a
 * synchronous call with an Effect-returning one, so a converted repository
 * trades a `syncDb` reference for a `query` reference and often gains a
 * `TxOrDb` parameter as well — the count goes up while the thing being
 * retired goes down. `syncDb` is what actually has to fall, and it has its own
 * gate below; the total stays only as a ceiling against unrelated growth.
 */
const BASELINE = {
  references: 245,
  files: 38,
  /** Group 1 removed both: the post-commit queue is handed to the transaction body. */
  effect: 0,
  use: 0,
  /** Group 2: production raw SQL goes through the narrowed `rawSql`, not the whole handle. */
  syncNative: 0,
  rawSql: 2,
  /**
   * Groups 3-4 are done: no production module reaches for the synchronous
   * singleton. It was 32 call sites across 28 modules. The export itself is
   * gone as of 2026-09-29 — tests take the shared client through
   * `test/helpers/sqlite.ts`'s `testDb`, which asks `Database.query` for its
   * executor — so this count can only ever be zero, and the namespace check
   * below is what now guards the retirement.
   */
  syncDb: 0,
} as const

const API = /Database\.[A-Za-z]+/g

async function scan() {
  const counts = new Map<string, number>()
  let references = 0
  const files = new Set<string>()

  for await (const relative of new Bun.Glob("**/*.ts").scan({ cwd: SRC })) {
    const text = stripComments(await Bun.file(SRC + relative).text())
    const matches = text.match(API)
    if (!matches) continue
    files.add(relative)
    references += matches.length
    for (const match of matches) {
      const name = match.slice("Database.".length)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }

  return { references, files, counts }
}

describe("Database wrapper inventory", () => {
  it("scanned a plausible source tree", async () => {
    // A glob over a cwd that no longer exists yields nothing, which would make
    // every assertion below pass vacuously. Same trap tui-source.ts documents.
    const { files } = await scan()
    expect(files.size).toBeGreaterThan(10)
  })

  it("does not grow past the recorded baseline", async () => {
    const { references, files } = await scan()

    expect(references).toBeLessThanOrEqual(BASELINE.references)
    expect(files.size).toBeLessThanOrEqual(BASELINE.files)
  })

  it("has no ambient transaction context left", async () => {
    const { counts } = await scan()

    // Group 1 landed. `Database.effect` and `Database.use` are gone: a
    // post-commit effect is queued through the `ctx` the transaction body
    // receives, and reads go through `syncDb()` directly. Reintroducing either
    // brings the module-level queue back with it.
    expect(counts.get("effect") ?? 0).toBe(BASELINE.effect)
    expect(counts.get("use") ?? 0).toBe(BASELINE.use)
  })

  it("keeps retiring the synchronous singleton", async () => {
    const { counts } = await scan()

    // Groups 3-4. Every repository converted to `Database.query` drops one
    // `syncDb()` call. Lower this in the same change that removes them; a rise
    // means a new module reached for the process-global handle instead.
    expect(counts.get("syncDb") ?? 0).toBeLessThanOrEqual(BASELINE.syncDb)
  })

  it("no longer offers the synchronous singleton at all", async () => {
    // The last step of the retirement: `syncDb` is not a member of the
    // namespace, so a new module cannot reach for it. Its callers went through
    // `query` (production) or `testDb` (tests), and `query` keeps the shared
    // connection as a private accessor.
    const { Database } = await import("@/database/database")
    expect("syncDb" in Database).toBe(false)
    expect(typeof Database.query).toBe("function")
  })

  it("keeps the native handle out of production code", async () => {
    const { counts } = await scan()

    // Group 2. `syncNative` hands over the whole SQLite handle — `exec`,
    // `close`, `transaction` — and is for tests, migrations, and admin tooling.
    // Production SQL the builder cannot express uses `rawSql`, which is
    // narrowed to `query` and names its caller.
    expect(counts.get("syncNative") ?? 0).toBe(BASELINE.syncNative)
    expect(counts.get("rawSql") ?? 0).toBeLessThanOrEqual(BASELINE.rawSql)
  })
})

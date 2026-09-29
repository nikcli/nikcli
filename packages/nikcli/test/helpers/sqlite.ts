/**
 * Per-test SQLite isolation helpers.
 *
 * Worktree and workspace tests run against the sync engine's SQLite
 * database. Without isolation, tests that share a database handle can
 * race on the same rows and produce flakes under Bun 1.3.x. The
 * primitive here gives each test a unique `NIKCLI_TEST_HOME` so the
 * database file is created in a private temp directory.
 *
 * Usage:
 *
 *   import { describe, expect, it } from "bun:test"
 *   import { testDb, withIsolatedDatabase } from "../helpers/sqlite"
 *
 *   describe("workspace/config", () => {
 *     it("parses config", async () => {
 *       await withIsolatedDatabase(async (home) => {
 *         // NIKCLI_TEST_HOME is set to `home` for the duration of this fn.
 *         // The sync database is created at `${home}/data/nikcli.db`.
 *         const { Config } = await import("@/workspace/config")
 *         // ...
 *       })
 *     })
 *   })
 *
 * The escape hatch `skip` lets legacy tests bypass the helper when they
 * genuinely need the global database (rare; e.g. migration tests).
 */
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import type { Database } from "@/database/database"

export type IsolatedDatabaseOptions = {
  /**
   * Skip isolation and use the existing environment. Useful for
   * migration tests that need the shared database. The `home` argument
   * is then `process.env.NIKCLI_TEST_HOME` (or undefined).
   */
  skip?: boolean
}

export type IsolatedDatabaseContext = {
  /** The temp directory used as NIKCLI_TEST_HOME. */
  readonly home: string
  /** The path to the per-test SQLite database file. */
  readonly databasePath: string
}

export async function withIsolatedDatabase<T>(
  fn: (ctx: IsolatedDatabaseContext) => Promise<T>,
  options: IsolatedDatabaseOptions = {},
): Promise<T> {
  if (options.skip) {
    return fn({
      home: process.env.NIKCLI_TEST_HOME ?? "",
      databasePath: path.join(process.env.NIKCLI_TEST_HOME ?? "", "data", "nikcli.db"),
    })
  }

  // Capture the previous env at call time so nested calls compose
  // correctly (each call sees its own surrounding env, not the loader
  // value at module-load time).
  const previousHome = process.env.NIKCLI_TEST_HOME
  const previousProjectConfig = process.env.NIKCLI_DISABLE_PROJECT_CONFIG
  const previousDatabase = process.env.NIKCLI_DB

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-iso-"))
  process.env.NIKCLI_TEST_HOME = home
  // Disable project-level config so the test home is the only source
  // of config — keeps tests isolated from the host's nikcli.json.
  process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
  const databasePath = path.join(home, "data", "nikcli.db")
  process.env.NIKCLI_DB = databasePath

  try {
    return await fn({ home, databasePath })
  } finally {
    const { Database } = await import("@/database/database")
    Database.close(databasePath)
    // Restore the previous environment so other tests in the same
    // process are unaffected.
    if (previousHome === undefined) delete process.env.NIKCLI_TEST_HOME
    else process.env.NIKCLI_TEST_HOME = previousHome
    if (previousProjectConfig === undefined) delete process.env.NIKCLI_DISABLE_PROJECT_CONFIG
    else process.env.NIKCLI_DISABLE_PROJECT_CONFIG = previousProjectConfig
    if (previousDatabase === undefined) delete process.env.NIKCLI_DB
    else process.env.NIKCLI_DB = previousDatabase
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The shared Drizzle client, for fixtures and assertions.
 *
 * `Database.syncDb()` is gone (`specs/storage/retire-database-wrapper.md`);
 * `Database.query` is the one access shape, and it hands `run` an executor.
 * A test that seeds a row or reads one back wants that handle rather than an
 * Effect per statement, so this asks `query` for its executor: the same shared
 * connection the code under test uses, which `Database.close` in
 * `withIsolatedDatabase` closes with everything else.
 *
 * The namespace is a parameter rather than an import. The tests that use this
 * load the database module inside `withIsolatedDatabase`, after
 * `NIKCLI_TEST_HOME` and `NIKCLI_DB` are set, and the first open runs the
 * migrations and the JSON backfill against the home those name. A static
 * import here would move that load before either is set, and a `require` at
 * call time was tried and produced a second module instance with its own
 * connection, so the first open happened on a handle the code under test never
 * read. Passing the caller's own namespace keeps one instance.
 *
 * Calling it also opens the database, which is how a few tests run the
 * migrations before reading through a repository.
 */
export function testDb(database: typeof Database): Database.Client {
  return Effect.runSync(database.query("test fixture", (executor) => executor as Database.Client))
}

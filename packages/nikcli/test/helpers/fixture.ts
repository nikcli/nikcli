/**
 * Shared test fixture loader for nikcli unit/integration tests.
 *
 * `specs/effect-tui/20-testing-architecture-harnesses.md` says the per-feature
 * harnesses in `test/{plugin,cli,mobile}/` reinvent fixture loaders. This
 * module is the canonical one: it composes the existing helpers (sqlite,
 * env, barrier) so a feature test can call `withFixture(...)` and get an
 * isolated database, a managed env, and a barrier-driven async coordination
 * primitive in one shot.
 *
 * Layering:
 *  - `withFixture(fn)` runs `fn` inside an isolated home directory (sqlite)
 *    with the test env baseline restored between cases (env).
 *  - `withFixture({ barrier: 2 }, fn)` sizes the case's barrier and holds the
 *    case to it: arrivals left pending when the body returns fail the test.
 *  - `withFixture({ seeds: { sessionID: "..." } }, fn)` runs seed callbacks
 *    before the case body; see `seeds` below.
 *
 * Use this for new feature tests. Existing tests are not required to migrate,
 * but new tests in `test/{plugin,cli,mobile}/` should default to this helper
 * per B40.
 */
import { preserveTestEnv } from "./env"
import { barrier, deferred, withTimeout } from "./barrier"

export type FixtureOptions = {
  /**
   * How many arrivals the case's barrier waits for. Omit it and the barrier
   * is still there at `count = 1`, but the drain check below is skipped —
   * only a case that declared a count is held to it.
   */
  readonly barrier?: number | boolean
  /** Run before the body. Keys are arbitrary; values are seed callbacks. */
  readonly seeds?: Record<string, (ctx: FixtureContext) => Promise<void> | void>
}

export type FixtureContext = {
  readonly home: string
  readonly barrier: ReturnType<typeof barrier>
  readonly await: <T>(promise: Promise<T>, label: string) => Promise<T>
}

export async function withFixture<T>(
  options: FixtureOptions | ((ctx: FixtureContext) => Promise<T> | T),
  fn?: (ctx: FixtureContext) => Promise<T> | T,
): Promise<T> {
  const opts: FixtureOptions = typeof options === "function" ? {} : options
  const body = typeof options === "function" ? options : fn!

  // `withFixture` is called from inside a case body, so everything it does
  // has to happen inline. Registering `beforeEach`/`afterEach` from here
  // would attach hooks to the *next* cases in the file, one more per call,
  // and this case would run without any of them.
  const declaredArrivals = opts.barrier === true ? 1 : typeof opts.barrier === "number" ? opts.barrier : undefined

  const { withIsolatedDatabase } = await import("./sqlite")
  return withIsolatedDatabase(async (iso) => {
    const ctx: FixtureContext = {
      home: iso.home,
      barrier: barrier(declaredArrivals ?? 1),
      await: <T>(promise: Promise<T>, label: string) => withTimeout(promise, 5_000, label),
    }

    if (opts.seeds) {
      for (const [, seed] of Object.entries(opts.seeds)) {
        await seed(ctx)
      }
    }

    const result = await body(ctx)

    // Checked only on the success path, and only for a case that asked for a
    // barrier: throwing here when the body already threw would replace the
    // real failure with a complaint about the bookkeeping. Arrivals left
    // pending mean the case waited on fewer things than it declared — the
    // barrier passed for a reason the test did not intend.
    if (declaredArrivals !== undefined && ctx.barrier.pending > 0) {
      throw new Error(
        `fixture barrier left ${ctx.barrier.pending} of ${declaredArrivals} arrivals pending; reduce the count or signal them`,
      )
    }

    return result
  })
}

export { barrier, deferred, withTimeout, preserveTestEnv }

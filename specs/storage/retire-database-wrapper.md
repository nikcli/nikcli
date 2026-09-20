# Retire the synchronous `Database` wrapper

| Field   | Value                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Status  | **Groups 1-4 complete** — 2026-09-15: `Database.syncDb()` has no callers left in `src`                                        |
| Scope   | `packages/nikcli/src/database/database.ts` and its 38 consumers                                                               |
| Buys    | One database access shape, so a repository's failure mode is visible in its type                                              |
| Depends | Nothing. The adapter dependency is void — see below.                                                                          |
| Tests   | `test/database/transaction-semantics.test.ts` (the two semantics), `test/database/wrapper-inventory.test.ts` (the count gate) |

## The Adapter Was Never Needed — 2026-09-15

This spec was written as a consumer of `specs/storage/effect-sqlite-package.md` — the Effect Drizzle
adapter proposal, retired 2026-09-21 — on the
assumption that yieldable queries require Drizzle's Effect driver. Measured, they do not: taking
Effect at the repository boundary costs 0.5µs a query, where swapping the driver costs 9µs, and both
deliver the same thing — a failure in the signature, an executor passed in, a body that composes in
`Effect.gen`. Groups 3 and 4 therefore proceed on the synchronous driver, and the 28 migrations are
untouched.

`Database.query(operation, run, executor?)` is the access shape: `run` is handed an executor and
stays synchronous, and the failure surfaces as `Database.QueryError` naming the call site.

### Landed

- **`Database.transaction` is an Effect.** Its body is an Effect evaluated to completion before the
  driver commits; a failure rolls back and surfaces as the body's own error, and an asynchronous body
  fails instead of committing at its first suspension. All seven behaviours in
  `transaction-semantics.test.ts` hold unchanged: nesting joins the outer transaction, `afterCommit`
  drains after the commit and never on rollback, a nested queue drains with the outermost commit, and
  a throwing post-commit effect does not stop the rest.
- **Nine repositories converted**: `GoalRepo`, `PermissionRepo`, `MonitorRepo`, `TodoRepo`,
  `SessionDiffRepo`, `ArtifactRepo`, `BackgroundRunRepo`, `ShareRepo`, and the `SessionGoal` service
  that sat on top of one of them — whose layer lost its `Effect.sync` wrappers rather than gaining
  any.
- `syncDb` references: **32 → 23**. `wrapper-inventory.test.ts` now ratchets `syncDb` specifically;
  the total is only a ceiling, because a converted repository trades a `syncDb` reference for a
  `query` reference and often an executor parameter too.

### Complete — 2026-09-15

`Database.syncDb()` has **no callers in `src`**. It was 32, across 28 modules. The function stays on
the namespace for tests and tooling; `wrapper-inventory.test.ts` now gates `src` at zero, so a new
module reaching for the process-global handle fails the suite.

Every repository returns an Effect whose failure is `Database.QueryError`, and takes its executor as
an optional parameter so it can join a transaction it was handed.

Three shapes came out of it, and the distinction matters when reading the code:

- **Repositories** are Effects end to end.
- **Modules whose public surface is async** (`MobileAuth`, `Outbox`, `SyncStorage`, `UserDB`'s
  `create`/`updateUser`) keep returning Promises and put the Effect boundary at the _statement_: a
  small local `query` helper runs one synchronous query. `Outbox.drain` awaits a network push
  between statements, so each of its five statements is its own query.
- **Pure helpers stayed pure.** `SessionPending.canonical`, `UserDB.toPublic`, `isAdminEmail` and
  `getAdminEmails` never touch the database; the mechanical pass wrapped some of them and that was
  reverted. A pure function that grows a database executor is a regression.

What did _not_ change: `bun:sqlite` is still the driver, the 28 migrations are untouched, and the
transaction semantics in `transaction-semantics.test.ts` all still hold.

### Measured

The Effect boundary costs what the spec predicted: an identical call is `11.82µs` bare and
`13.08µs` through `Database.query` + `runSync`, and `SessionRepo.get` lands at `13.75µs` against
`13.64µs` for the drizzle call it wraps.

The driver-level suite, best-of-three interleaved on the same machine, against the `0.41.0`
baseline this work started from — this is the drizzle 1.0 bump, not the repository conversion, but
it is the number that describes where the database layer now sits:

|                       | before (0.41) |          now |          |
| --------------------- | ------------: | -----------: | -------: |
| get by pk             |       27.38µs |       7.66µs |     −72% |
| list 20 ordered       |       55.63µs |      28.38µs |     −49% |
| count(\*)             |        5.71µs |       2.44µs |     −57% |
| inArray(10)           |       51.38µs |      24.90µs |     −52% |
| two-column where      |       33.08µs |      16.52µs |     −50% |
| messages of session   |       33.77µs |      17.64µs |     −48% |
| insert one            |       25.64µs |      12.30µs |     −52% |
| update by pk          |       10.89µs |       4.31µs |     −60% |
| upsert (onConflict)   |       17.45µs |       6.85µs |     −61% |
| transaction: 3 writes |       54.65µs |      23.53µs |     −57% |
| **sum**               |  **315.58µs** | **144.53µs** | **−54%** |

### The failure mode to know about

An Effect that is built and never run is a silent no-op — no error, no write, and a test that only
asserts a read will pass. This happened eight times during the conversion, twice in production code
that the tests did not cover. A grep for repository calls that are neither `yield*`-ed nor passed to
`runSync`/`runPromise` found all of them; keep it in reach when converting anything else.

## Goal

Remove production usages of the synchronous surface of `src/database/database.ts`:

- `Database.syncDb()`
- `Database.syncNative()`
- ~~`Database.use(...)`~~ — removed, group 1
- `Database.transaction(...)`
- ~~`Database.effect(...)`~~ — removed, group 1
- `Database.TxOrDb` / `Database.Tx` / `Database.Client` as parameter types

This is **not** a request to remove SQLite, Drizzle, or the `Database` module. The pragma set, the
path rule, the migration journal, the singleton lifecycle, and `Database.Service` stay. The target is
the callback-and-singleton **access shape** that sits in front of them.

It is also not one change. The end state is that a repository takes its executor as a parameter or
yields it from Effect context, and nothing reaches for a process-global handle mid-function.

## Why

Three properties follow from `syncDb()` being reachable from anywhere:

1. **Failure is invisible in the signature.** A repository function that calls `Database.syncDb()`
   has the same type as one that does not. Whether it touches the database is not part of its
   contract, so a caller cannot tell what it needs to provide or what it can fail on.
2. **Test isolation depends on a convention.** `bun test` swaps `NIKCLI_TEST_HOME` per file. The
   singleton re-resolves its path on access, which is what makes that work — but nothing enforces
   it. A future singleton that captures the path at module load reintroduces the stale-path class of
   failure silently.
3. ~~**The transaction context is ambient.**~~ Fixed in group 1. `transaction` now hands the body a
   `TransactionContext` whose `afterCommit` queues onto the enclosing transaction's own queue, so a
   function that defers work says so in its signature and cannot queue against a transaction it is
   not in.

None of these are live bugs. They are the reason the count below should shrink rather than grow.

## Current Inventory

Measured 2026-09-11 against `packages/nikcli/src`, **code only** — comments are stripped first,
because `database.ts` names the APIs it explains and a doc comment is not a call site.

Before group 1: 92 references / 39 files. After: **90 references across 39 files.**

`test/database/wrapper-inventory.test.ts` holds those numbers as a ceiling. The count may fall and
may not rise. When a group lands, lower the baseline in the same change; when a new call site is
genuinely required, raise it deliberately and say why rather than widening the tolerance.

| API                         | References | Notes                                                            |
| --------------------------- | ---------- | ---------------------------------------------------------------- |
| `Database.syncDb()`         | 31         | 27 files. The bulk of the work.                                  |
| `Database.transaction(...)` | 22         | 9 files.                                                         |
| `Database.TxOrDb`           | 15         | 13 files. Type-only; moves with whatever replaces the executor.  |
| `Database.Service`          | 12         | 7 files. **Already the target shape** — not part of the removal. |
| `Database.defaultLayer`     | 6          | `analytics/rollup.ts` (5), `analytics/data.ts` (1).              |
| `Database.syncNative()`     | 2          | `analytics/analytics.ts`, `analytics/share.ts`.                  |
| `Database.effect(...)`      | 2          | One real call site plus its doc comment.                         |
| `Database.use(...)`         | 1          | One call site.                                                   |
| `Database.Client`           | 1          | One structural type alias.                                       |

The long tail is the encouraging part: `effect`, `use`, `Client`, and `syncNative` have **six call
sites between them**, and two of those four APIs have exactly one.

## Group 1: The Ambient Transaction Context

**Status: landed 2026-09-11.**

`Database.effect(fn)` had one production call site — `src/sync/sync-event.ts`, deferring event
publication until after the enclosing transaction commits — and `Database.use(...)` had one, in the
same file. That was the whole justification for the module-level `pending` queue, so the ambient
context could be replaced without touching any other domain.

What changed:

```ts
// before
Database.transaction((tx) => {
  Database.effect(() => publish(event)) // queues against whatever is open
})

// after
Database.transaction((tx, ctx) => {
  ctx.afterCommit(() => publish(event)) // queues against *this* transaction
})
```

- `Database.transaction` passes a `TransactionContext` as the body's second argument. A nested call
  receives a context over the **outer** queue, so nesting semantics are unchanged.
- `SyncEvent.process` takes the context as a required parameter rather than reaching for it, which
  is what makes "this only works inside a transaction" a type error instead of a convention.
- `Database.use` is gone; its one caller reads `Database.syncDb()` directly.
- The module-level queue still exists but is now private to `transaction` and unreachable from
  outside it.

What did not change: nested joins, drain-after-outermost-commit, no-drain-on-rollback, a throwing
effect logged rather than propagated, and `behavior: "immediate"`. The fence tests assert all five
and were written before the refactor.

`SyncEvent.run` depends on transaction composability and on
`behavior: "immediate"` for sequencing correctness — see "The Two Semantics The Wrapper Must
Preserve" above — so whatever replaces `pending` must keep
post-commit effects draining after the **outermost** commit, never on rollback, and never while the
write lock is held.

`test/database/transaction-semantics.test.ts` pins all of that, including the case that makes the
queue worth having: an effect queued inside a nested block does not fire when the inner block
returns, because firing there would publish before the outer write committed. It also pins that a
throwing effect is logged and does not undo the commit, and that `behavior: "immediate"` really does
take the write lock up front — asserted against a second connection with `busy_timeout = 0`, opened
from inside the transaction so there is no timing race.

## Group 2: Analytics

**Status: landed 2026-09-15**, by the second of the two options below: `syncNative` is gone and raw
SQL goes through `Database.rawSql(<named site>)`, two code call sites. The six `defaultLayer`
references were never part of the removal — see "What Stays".

`analytics/rollup.ts` and `analytics/data.ts` already provide `Database.defaultLayer` explicitly (6
references), which is the target pattern. `analytics/analytics.ts` and `analytics/share.ts` reach
past Drizzle to `Database.syncNative()` for raw SQL.

`syncNative` is documented as admin/debug only. Either those two queries move onto Drizzle, or the
raw-SQL need is acknowledged and given a named accessor that says so in its type. Do not leave a
general-purpose escape hatch open for two callers.

## Group 3: Domain Repositories

**Status: landed 2026-09-15.** Largest group. Nine repositories converted; the executor is a
parameter without a global default, so nothing here can reach the process-global handle.

The `*repo.ts` / `*.sql.ts` pairs: `session/{repo,message-repo,todo-repo,diff-repo,goal-repo,
instruction-repo,pending}.ts`, `session/v2/*`, `loop/repo.ts`, `mission/repo.ts`, `monitor/repo.ts`,
`artifact/repo.ts`, `background/repo.ts`, `project/repo.ts`, `share/repo.ts`,
`permission/permission-repo.ts`, `mobile/repo.ts`.

Most already accept `tx: Database.TxOrDb = Database.syncDb()` — an executor parameter with a global
default. The parameter is the right shape; the default is what keeps the global reachable.

The move is mechanical and should be done one domain at a time: make the executor required, and let
the caller supply it. A domain is done when its repository module has zero `Database.` references
other than the executor type.

## Group 4: Sync And Workspace

**Status: landed 2026-09-15.** The modules here whose public surface is async — `MobileAuth`,
`Outbox`, `SyncStorage`, `UserDB`'s `create`/`updateUser` — keep returning Promises and put the
Effect boundary at the statement rather than at the function. That is the shape, not an unfinished
conversion.

`sync/{index,outbox,remote-sync,snapshot,migrate-from-workspace}.ts`, `workspace/db.ts`,
`server/httpapi/sync.ts`, `share/{repo,share-next}.ts`, `user/users.ts`, `account/db.ts`,
`mobile/auth.ts`.

`sync/index.ts:105` defines `type Executor = Pick<Database.Client, "select" | "insert" | "delete">`,
which is the narrowest executor type in the codebase and a good model for the others: a repository
that only reads should not be handed something that can write.

Several files in this group already take `Database.Service` from Effect context. They are done; they
appear here only because they still import the namespace.

## What Stays

- `Database.Service`, `Database.layerFromPath`, `Database.defaultLayer` — the Effect surface is the
  destination, not the thing being removed.
- `Database.path()`, `Database.close()`, `Database.closeAll()`, `Database.isOpen()` — lifecycle, used
  by tests and shutdown. Zero production references today.
- `DatabaseMigration.apply` and the journal.
- The pragma set and the WAL checkpoint loop.

## Sequencing

1. ~~Group 1 (two call sites, one file) — removes the ambient transaction context.~~ **Done.**
2. ~~Group 2 (analytics) — decides the raw-SQL question while it is still two callers.~~ **Done**, via
   the named accessor.
3. ~~Group 3, one domain per change, each with its existing repository tests green.~~ **Done.**
4. ~~Group 4.~~ **Done.**
5. Add the gate, then delete the synchronous exports. **This is what is left.** `syncDb` is already
   gated at zero for `src` by `wrapper-inventory.test.ts`; deleting the export itself needs the test
   and tooling callers moved first, which is why it did not land with group 4.

An earlier revision of this list had a step between groups 2 and 3: land the Effect Drizzle adapter,
so groups 3 and 4 had an Effect-native executor to move onto. That step is gone, and its absence is
the finding — the groups landed on the synchronous driver, which is what "The Adapter Was Never
Needed" above measures.

## Risks

- **`bun test` isolation.** Every change in groups 3 and 4 touches a module that tests instantiate
  per file with a different `NIKCLI_TEST_HOME`. Run the domain's suite, not just typecheck.
- **Groups 3 and 4 are wide.** 27 files reach for `syncDb()`. The inventory gate stops the count
  growing; it does not stop a change from being large. One domain per change.
- **The baseline is a number in a test.** It only means something if it is lowered when a group
  lands. A group that lands without lowering it has left the gate measuring the wrong thing.

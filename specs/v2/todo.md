# V2 Open Work

| Field  | Value                                                                           |
| ------ | ------------------------------------------------------------------------------- |
| Status | **Working list** — the v2 port's remaining decisions, reviewed 2026-09-11       |
| Scope  | What is left of the opencode v2 port, and which of it nikcli has already passed |

This is the nikcli counterpart to opencode's `specs/v2/todo.md`: the coordination list for getting
out of the rebuild phase.

**It is not the backlog.** Dated, sequenced, measured work belongs in [../ROADMAP.md](../ROADMAP.md),
which tracks the twenty-spec Effect/TUI program. This file holds the v2-port items that are still
_decisions_ — where the shape is unsettled, or where nikcli deliberately diverged and the divergence
needs to stay visible.

## Already Closed

These are open upstream and finished here. They are listed so nobody reopens them by porting an
upstream document verbatim.

| Upstream item              | nikcli status                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Post-Hono cleanup          | **Done.** Hono and `NIKCLI_EXPERIMENTAL_HTTPAPI` are gone from `src`. Routes are `server/httpapi/*.ts` plus the `bridge.ts` route table.                                                                |
| New data mode / session v2 | **Done and ahead.** Flat entries, event-sourced write path, persisted entry projection — see [session-v2-write-path.md](./session-v2-write-path.md). `MessageV2` stays authoritative for the LLM layer. |
| Event system               | **Done.** One encoded feed with a per-connection lag budget — see [event-stream-architecture.md](./event-stream-architecture.md).                                                                       |
| Durable pending input      | **Done.** Pending row plus promotion transaction, steer vs queue, compaction barrier — see [durable-pending-input.md](./durable-pending-input.md).                                                      |
| Restart continuation       | **Done.** See [session-restart-continuation.md](./session-restart-continuation.md).                                                                                                                     |
| Provider policy            | **Done.** Ordered `provider.use` statements, last match wins — see [provider-policy.md](./provider-policy.md).                                                                                          |
| JSON storage retirement    | **Done.** See [../storage/remove-json-storage.md](../storage/remove-json-storage.md).                                                                                                                   |

## Config Rework

The review is written: [config.md](./config.md). The **migration mechanism** was recorded here as an
open choice between two conflicting precedents. Counted against the source on 2026-09-21, they are
not in conflict — loader mapping is used six times and always for a rename _within_ one document,
the file rewrite once and only to move fields into a _different_ document. Every rename the ledger
proposes stays inside `nikcli.json`, so only the first applies. See "The Two Precedents Do Not
Disagree" in [config.md](./config.md). What remains is ratifying that, which belongs to whoever owns
the published schema; the paragraphs below are kept because they state the cost of each option.

Every plural rename in that document (`plugin` → `plugins`, `agent` → `agents`, `permission` →
`permissions`, `provider` → `providers`, `snapshot` → `snapshots`, `attachment` → `attachments`) is a
breaking change to a JSON Schema published at `https://nikcli-ai.dev/config.json`. There are two
precedents in the codebase and they disagree:

- **Accept both, migrate in the loader.** What `autoshare` → `share`, `mode` → `agent`, and `tools` →
  `permission` already do. Cheap, invisible, and permanent — the deprecated keys never leave.
- **Rewrite the file.** What `migrateTuiConfig` does for `theme` / `keybinds` / `tui`, moving them
  into a sibling `tui.json`. Users end up on the new shape, but the rewrite has to be idempotent and
  safe against concurrent edits.

Pick one before the first rename lands, not after the third.

Also unresolved: whether `nikcli.jsonc` is supported. Upstream v2 accepts it; nikcli's `findUp`
looks for `nikcli.json` only.

## Provider And Model

The catalog is documented in [provider-model.md](./provider-model.md). Three gaps versus upstream,
each an independent decision:

- **No plugin hook surface.** Upstream registers providers and models through ordered plugins with
  `provider.update` / `model.update` hooks over Immer drafts. nikcli builds the catalog in one
  function with six literal steps. The function is readable and testable; the cost is that a plugin
  cannot add a model without an auth loader. Decide whether that is a real constraint before
  building a hook system for it.
- **No account abstraction.** Credentials are `Auth.Info` records keyed by provider id. Upstream has
  `AccountV2` with activation and a service id. nikcli's unified-auth work (OAuth on
  `auth.nikcli-ai.dev` with a shared JWKS verifier, pinned by `test/server/unified-auth.test.ts`) is
  the natural place for this, not the provider catalog.
- **`Model.family` is carried but unused.** Either selection starts using it or it comes out.

## Native LLM Routing

`experimental.nativeLlm` gates native `@nikcli-ai/llm` route streaming and is **off by default**
(`packages/util/src/features.ts` — every flag there defaults off and is compared with `=== true`).

The gate is binary and global today. Two things have to be true before it flips on:

1. `mapToModelRef` covers the routes that matter. It returns `undefined` for anything it cannot map,
   which is a safe fallback but also means coverage is invisible — nothing reports "this model
   silently took the AI SDK path".
2. A soak that survives the failure mode the 2026-07-09 rollback found: with the flags on, the TUI
   stopped rendering streamed assistant parts. The lesson recorded in `features.ts` is **one flag at
   a time, verified end-to-end on the session stream**, not a flip-all.

Per-route or per-provider granularity would make partial rollout possible. That is a schema change
to the flag, so decide it before the soak, not during.

## Event Envelope And Store Partitioning

[api.md](./api.md) records two divergences from upstream's proposed API shape. Both are open.

- **Two event envelopes, not one.** `/event` sends `{ type, properties }`; `/global/event` sends
  `{ payload: { directory, payload } }`. Upstream proposes one envelope carrying
  `context: { directory, workspaceID? }` plus `id` and `time`. One shape would let a single
  connection multiplex directories; it breaks every client that reads `data.type`.
- **The TUI store is single-context.** Upstream partitions runtime data by
  `${workspaceID ?? "local"}:${directory}`. nikcli keeps one flat store per process. The partition is
  a prerequisite for showing two worktrees in one window and is needed for nothing else today.

Neither should be done for symmetry with upstream. Both need a named consumer first.

## Storage

**Closed.** `specs/storage/effect-sqlite-package.md` proposed vendoring the Drizzle Effect SQLite
adapter, and was **retired 2026-09-21** without a line of it being written. Three things closed it
independently: upstream published `drizzle-orm/effect-sqlite-bun`; the measurement it was waiting for
came back the other way (Effect at the repository boundary, 0.5µs a query, against 9µs to swap the
driver); and its consumer finished without it.

That consumer, [../storage/retire-database-wrapper.md](../storage/retire-database-wrapper.md), has
**landed groups 1-4** on the synchronous driver: `Database.syncDb()` has no callers in `src`, down
from 32 across 28 modules. What is left there is deleting the export, once the test and tooling
callers move.

Both fences hold: `test/database/transaction-semantics.test.ts` pins the nested-join and
post-commit-drain semantics, and `test/database/wrapper-inventory.test.ts` gates `syncDb` at zero for
`src` and holds the rest as a ceiling. Lower the baseline in the same change that lands a group.

Two hardening items are independent of that work and should not block it:

- **Migration claiming is in-process only.** `DatabaseMigration.apply` is guarded by an in-process
  mechanism, so two processes starting against one `nikcli.db` can still race. This is latent today
  because the common case is one server per data directory.
- **Post-commit effects are fire-and-forget.** `Database.effect` logs and swallows a failing
  post-commit callback. That is correct for the transaction — and now pinned as such — but it means a
  dropped event publish is invisible to the caller. Decide whether any of them need to be retried.

## Project And Worktree Routing

[../project.md](../project.md) records the divergence: nikcli binds requests to a **directory**
(`?directory=` or `x-nikcli-directory`), upstream nests them under `/project/:projectID`.

The open question is not which is better — it is whether cross-worktree aggregation needs a route.
Listing every session for a project that spans three worktrees is three calls today. The data
supports the nested form already (`session_info` carries both `project_id` and `directory`), so this
is a routing decision, not a migration.

## Hot Reload

Upstream's goal: every service emits granular events so dependents reconfigure themselves instead of
being torn down, and the frontend receives them too (`model.added` and friends).

nikcli has the invalidation half — `InstanceReload.watch()` debounces config-surface changes and
invalidates reloadable per-instance caches, publishing `instance.reload.started` and
`instance.reloaded`. What it does not have is **granularity**: a single changed model invalidates the
whole provider state for that directory.

The next slice, if it is worth doing, is a per-domain event that dependents can subscribe to. The
prerequisite is knowing which dependents actually want it — a TUI that re-reads the model list on
`instance.reloaded` is already correct, just wasteful.

## Plugin API

`@nikcli-ai/plugin` is the public type and autoload is fail-closed
([tool-plugin-autoload-security.md](./tool-plugin-autoload-security.md)). What does not exist is
upstream's server-plugin hook design — Immer drafts so bad mutations can be discarded, a global
instance handle (`nikcli.session.prompt()`, `nikcli.tool.register({…})`), and a hook spec with
`cancel` semantics.

Do not build a fraction of it for a single service. If it lands it should land as one document with a
named first consumer.

## Deferred Hardening

Visible, but not blocking. Do not spend a slice on these unless a concrete failure appears.

- Page large durable aggregate replays instead of loading every row after a stale cursor into one
  array.
- Decide whether connected event tails need a polling fallback for cross-process SQLite writers;
  advisory wakes are intentionally process-local.
- Stream-cap websearch body collection before parsing.
- Bound ripgrep execution time and line framing.
- Materialize or consistently reject unresolved URL and file attachment sources.
- Batch streamed deltas and add covering context indexes.

## How To Use This File

An item leaves this list in one of two ways: it becomes a document in this directory with a status
and a test that pins it, or it becomes a dated entry in [../ROADMAP.md](../ROADMAP.md). It does not
leave by being done quietly.

# EOT-16: Workspace Isolation and Multi-Workspace Architecture

Status: proposed. Tier: 1. Phase: P2. Dependencies: EOT-02, EOT-03, EOT-09.
Owner: workspace, project, worktree, instance maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B03, B31 in the [register](../README.md): an `InstanceRef`/`WorkspaceRef` exists, `InstanceScope.with` enforces
ambient isolation, and `InstanceState` keeps per-instance state. Workspaces are first-class in the contract
(`src/server/httpapi/workspace.ts`), and the TUI exposes workspace selection, create, and switch flows. The remaining
gap is a unified spec covering **workspace as a typed Effect scope**: per-workspace resources, concurrent isolation, hot
switch, durable boundaries, and the coordination between workspace, session, project, and worktree.

The architectural opportunity is to make workspace a true isolation primitive in the Effect runtime, not just a label
on a request. Two workspaces with the same project must not share caches, sessions, or in-flight resources; switching
workspaces must be a deterministic, cancellable operation; durable workspace state must outlive process restarts without
leaking ambient state.

## Scope and Non-Goals

Define workspace as a typed Effect scope with explicit resource ownership, concurrent isolation, hot switch semantics,
and durable state. Preserve the existing `Workspace`, `Project`, `Worktree`, and `Instance` modules and their schemas.
Do not introduce a second workspace concept, change the on-disk layout, or relax concurrency safety.

## Design and Requirements

1. A workspace is a typed identifier `Workspace.WorkspaceID` plus its runtime scope. The scope is `Effect Scope.Scope`
   plus a `WorkspaceRef` carrying `(directory, projectID, configRevision, generation)`. The runtime rejects cross-workspace
   reads of mutable state; pure functions may still accept data, but a `WorkspaceRef` is required for any I/O.
2. Resources tied to a workspace — config, sessions, in-flight requests, file watchers, LSP/MCP clients, monitors,
   background jobs, plugin generations — are owned by the workspace's `Scope`. Disposing the workspace disposes the
   resources in deterministic order; concurrent workspaces share the process runtime, not the resource scopes.
3. Per-workspace caches (config, command palette, recent files, prompt history, frecency) are namespaced by
   `WorkspaceRef`. Cross-workspace leakage is a typed failure, not a silent merge. The cache TTL is per-workspace; a
   hot switch retains the previous workspace's cache until the workspace is explicitly disposed or evicted.
4. Hot switch is a typed operation `Workspace.switch(from, to)` that:
   - increments the active workspace's generation token,
   - cancels all in-flight requests whose `workspaceRef !== to`,
   - disposes resource-owning UI surfaces (previews, dialogs, browser surfaces) but **not** durable background jobs,
   - loads the new workspace's config and snapshots in priority order,
   - commits the new active workspace only after the new essential data is ready.
     Failures leave the previous workspace active and surface a typed failure.
5. Concurrent workspaces in the same TUI/process are supported: a single active workspace drives the focused surface,
   but other workspaces keep their caches and durable jobs alive in the background. The TUI surfaces a banner when a
   background workspace is still doing work that the active one might affect.
6. Each workspace owns its own database connection (via the existing `withIsolatedDatabase` pattern) and its own
   migration state. The shared process database holds only global config and shared keys. The schema-level isolation
   makes accidental cross-workspace writes impossible.
7. Worktrees are sub-scopes of a workspace. A `Worktree(worktreeID)` is `Effect Scope.Scope` plus a
   `WorktreeRef(directory, branch, baseCommit, generation)`. Switching worktrees inside a workspace is a smaller,
   faster scope operation; switching workspaces is the larger one. The runtime keeps both scopes, so a workspace switch
   can keep worktree scopes alive across the transition.
8. Project is a higher-level concept that owns one or more workspaces. A project switch is a workspace switch; the
   project identity is metadata on the active workspace, not a parallel runtime context.
9. Duplicate workspace detection: opening a workspace whose `(directory, projectID, configRevision)` matches an existing
   workspace's identity reuses the existing scope instead of creating a parallel one. Identity mismatch (different
   revision) creates a parallel scope and surfaces a typed notice.
10. Workspace durability: a workspace's durable state (sessions, goals, instructions, todos, monitor records) survives
    process restarts via the existing SQL repositories. The runtime reads back the durable state on workspace activation
    before loading optional caches. The act of switching workspaces does not persist a "current" pointer without a
    commit; switching is local until the user closes the TUI or until the active workspace is set programmatically.
11. Permission and policy coupling: a workspace inherits the project's permission ruleset. The permission evaluation
    uses `WorkspaceRef` as a key; the existing `PermissionRuleset.TOOL_PERMISSION` map covers cross-workspace tool
    effects. A deny on a tool in the parent project denies it in every workspace.
12. Plugin and configuration reloads are scoped to the workspace. A workspace that does not supply a plugin capability
    (e.g. standalone TUI) reports the capability as absent for that workspace only; other workspaces keep theirs.

## Workspace Topology

```text
Process runtime (Effect)
  -> Workspace scope (one per active workspace)
       -> Worktree sub-scopes (one per active worktree)
            -> Session sub-scopes (one per active session)
                 -> Owned resources: LSP, MCP, file watchers, monitors, requests
  -> Cross-workspace durable state: global config, shared keys
  -> Per-workspace durable state: sessions, goals, instructions, todos, monitor records
```

## Failure and Cancellation

Use `Schema.TaggedError`: `WorkspaceError.ScopeLeak`, `WorkspaceError.IdentityMismatch`, `WorkspaceError.SwitchInProgress`,
`WorkspaceError.SwitchFailed`, `WorkspaceError.CacheLeaked`, `WorkspaceError.ResourceBusy`, `WorkspaceError.NotFound`.
Workspace disposal is idempotent; a second disposal is a no-op. A switch that races with another switch resolves through
a generation token; the loser cancels. Cancellation of a switch restores the previous workspace; cancellation of a
request is bounded to its workspace scope. Cross-workspace reads of mutable state fail with `WorkspaceError.ScopeLeak`,
not a partial result.

## Acceptance and Verification

- Two concurrent workspaces with the same project do not exchange mutable state; LSP/MCP clients, file watchers, and
  in-flight requests are isolated. Switching between them is a typed operation that does not leak resources.
- Hot switch while a 10,000-turn streaming session is active in workspace A and workspace B is idle: workspace A's
  in-flight requests are cancelled; B is loaded; A's cache and durable jobs survive; switching back resumes from the
  durable state.
- A duplicate workspace open (same identity) reuses the existing scope; identity mismatch creates a parallel scope and
  reports the notice.
- Worktree switch inside a workspace is measurably faster than workspace switch (single resource class to dispose); a
  workspace switch disposes the full set.
- Workspace disposal releases all owned resources; no residual listeners, timers, fibers, or file handles after the
  deterministic teardown completes.
- Extend `packages/nikcli/test/workspace/`, `packages/nikcli/test/worktree/`, `packages/nikcli/test/effect/instance-scope.test.ts`,
  `packages/nikcli/test/effect/instance-ambient.test.ts`, and the existing TUI workspace tests.
- From `packages/nikcli`: `bun test test/workspace/ test/worktree/ test/effect/instance-scope.test.ts test/effect/instance-ambient.test.ts`.
  Use `withIsolatedDatabase` for any DB-touching test. One final root `bun run typecheck` after the slice.
- Meet EOT-01 budgets; workspace switch p95 below 250 ms on the warm fixture (excluding network); concurrent workspace
  count never exceeds the documented cap; resource plateau after a deterministic teardown cycle.

## Migration and Rollback

Start with one existing operation (e.g. workspace switch in the TUI) and tighten its scope semantics. Verify the typed
errors with concurrent test cases. Then add hot-switch cancellation coverage and the duplicate-detection identity
check. Roll back by relaxing the scope check, not by deleting the typed errors or the per-workspace caches. Per-workspace
cache eviction is additive; never delete shared keys as part of the scope tightening.

## Discipline Addendum — 2026-09-20

`script/check-workspace-isolation.ts` is in CI (commit `644a8f28`), with `test/workspace/isolation.test.ts` beside it. The gate pins four invariants by reading source:

1. Workspace ids carry the `wrk_` prefix — the discriminator `projection.ts` dispatches on and the `WorktreeAdaptor` relies on.
2. `WorkspaceRef` and `locallyWorkspace` stay exported from `effect/instance-ref.ts`, and `effect/instance-scope.ts` still pins a workspace through `locallyWorkspace` when `input.workspaceID` is present.
3. The bridge comment still cites the open B31 gap. This one is unusual and deliberate: the comment records that two workspaces on one directory currently _share_ the instance scope's resources. A refactor that promotes the workspace to its own owning `Scope` changes what disposal releases, and the gate forces that refactor to update the note rather than leave a stale explanation next to changed behaviour.
4. `workspace/index.ts` registers no SIGINT/SIGTERM handlers of its own — connection lifecycle owns them, and a second handler is how a shutdown ends up racing itself.

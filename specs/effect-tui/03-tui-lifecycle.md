# EOT-03: TUI Asynchronous Lifecycle

Status: proposed. Tier: 1. Phase: P1. Dependencies: EOT-02.
Owner: TUI context/dialog maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B04, B05, B07, B12: `useAbortOnCleanup` already encodes cancellation plus post-await checks. SDK subscriptions,
bootstrap requests, dialog resources, and plugin disposal use several lifetime patterns. The remaining work is to make
the complete asynchronous chain safe, not to add a different disposed flag to each component.

## Scope and Non-Goals

Cover dialogs, resource-owning previews, provider/bootstrap requests, subscriptions, polling, and restart/exit. Preserve
Solid as the UI lifetime owner. No new global task manager, per-component Effect runtime, or generic hook framework.
Do not change auth requirements, automatically submit login forms, or treat closing a dialog as cancelling a durable job.

## Design and Requirements

1. Extend the existing `packages/tui/src/util/lifecycle.ts` only where shared behavior is demonstrated. Each async owner
   gets an AbortSignal and disposed check synchronously under the Solid owner. Register `onCleanup` before starting work,
   not inside a continuation that has lost the owner.
2. Distinguish lifetime cancellation from supersession. A still-mounted owner may launch newer searches, workspace
   bootstraps, or preview sessions; use a monotonic generation token plus cancellation of obsolete requests. Every state,
   navigation, toast, and dialog-stack mutation must verify both ownership and generation after every await.
3. Forward cancellation through generated SDK calls, fetch, worker requests, server handler scope, and the domain adapter
   where supported. Verify the server stops work, not just that the client drops its response. EOT-02 owns backend fibers.
4. Treat late resource acquisition specially: if create-browser/session/subscription resolves after disposal, invoke its
   disposer immediately and exactly once. Merely returning before `setState` leaks the resource.
5. Teardown ordering: mark owner inactive, stop new scheduling, abort in-flight operations, unsubscribe/clear timers,
   dispose acquired resources, and settle observable completion. Cleanup must be idempotent across Escape, replacement,
   errors, restart, and app exit. Solid cleanup itself is synchronous; async finalizers are observed by the existing host
   shutdown path, not awaited implicitly by Solid.
6. Poll only while the owner is active and the operation requires it. Enforce one outstanding poll per resource; schedule
   the next after completion. Server-owned Effect polling uses scoped schedules, bounded attempts/deadlines, and typed
   retry policy. UI adapters retain ordinary abortable control flow unless moving it into a service demonstrably helps.
7. Settle startup/subscription waiters on failure or disposal as well as success. An upgrade waiter must not stay pending
   forever after a failed subscription. Cancellation is distinct from a user-visible transport failure.
8. Preserve focus restoration through the dialog provider. A late result cannot replace the newer dialog or dispose the
   SDK connection used by the live application.

## State Transitions

| State/event                          | Allowed effect                                              |
| ------------------------------------ | ----------------------------------------------------------- |
| Active generation starts request     | Set loading; acquire using its signal                       |
| Active matching generation succeeds  | Commit once; transfer resource to owner                     |
| Superseded request succeeds          | Do not commit; dispose result if resource-bearing           |
| Disposed owner receives result/error | Do not navigate/toast/update; observe and release resources |
| Active request fails                 | Show typed failure with retry only when safe                |
| Cleanup called twice                 | No duplicate unsubscribe, close, or terminal callback       |

## Failure and Cancellation

Abort is not a connectivity error and should not generate a failure toast during normal dismissal. However, a real active
request failure must not disappear into `.catch(() => {})`. Report cleanup failures through the redacted log and a bounded
shutdown result. A Promise timeout is a deadline report, not evidence that the resource has stopped; distinguish a stuck
third-party disposer and revoke its ability to mutate the host as specified in EOT-08.

## Acceptance and Verification

- Close a dialog before, during, and immediately after each await; assert no late UI mutation and actual request abort.
- Resolve a resource factory after close; assert exactly one close/unsubscribe. Resolve an older request after a newer
  request succeeds; assert the newer state remains unchanged and the stale resource is released.
- Reject a request after disposal; assert no unhandled rejection. Reject it while active; assert an actionable failure.
- Switch workspaces repeatedly during bootstrap, then unmount; assert zero stale store writes and zero remaining owned
  requests/timers/listeners. Use controlled barriers, not timing-dependent sleep guesses.
- Exercise real `DialogAccountLogin`, onboarding, browser-control, and web-preview ownership paths. Preserve user changes
  already present in `packages/tui/src/component/dialog-web-preview.tsx` and its lifecycle tests when implementing.
- Extend `packages/nikcli/test/tui/dialog-lifecycle.test.ts`, `packages/nikcli/test/tui/onboarding-auth.test.ts`,
  `packages/nikcli/test/tui/plugin-dispose.test.ts`, and SDK subscription tests in the existing TUI suites.
- From `packages/nikcli`: `bun test test/tui/dialog-lifecycle.test.ts test/tui/onboarding-auth.test.ts test/tui/plugin-dispose.test.ts`.
  Add real-renderer/PTY coverage where a source-structure assertion cannot prove component behavior.
- EOT-01's 100-cycle resource gate passes; cancellation-to-owned-request-stop target is at most 100 ms on the local harness,
  excluding explicitly non-cancellable third-party code, which must instead demonstrate host capability revocation.

## Migration and Rollback

Inventory owners and classify each resource as owner-scoped or durable. Migrate one complete dialog chain first, then
bootstrap/SDK and remaining dialogs. Keep helper interfaces small and preserve existing callers. Roll back a migrated
adapter if necessary, but retain the new race regression tests and abort/generation safety requirements; never disable
cleanup assertions to ship. Existing dirty worktree edits are not part of this documentation change.

## Discipline Addendum — 2026-09-20

The inventory this spec asks for was started, and the first thing it produced was a
correction to what the inventory is _for_.

### The failure is an external effect, not a stale write

In Solid, writing a signal after the owner is disposed is harmless — nothing reads it.
So "every `createResource` / `onMount` that does not cancel" is not the defect list; it
is 30 files of mostly nothing. The defect is **acting on the outside world after an
await the user has walked away from**, and the reason that lands is one line in
`ui/dialog.tsx`: `replace()` sets `store.stack` unconditionally. There is no
empty-stack guard. A `replace` arriving after the user pressed `esc` **reopens the
dialog they just left**.

That is not hypothetical. `component/dialog-auth-manage.tsx` had three of them, and the
shape is worth recognising:

```
onSelect: async () => {
  await updateDisplayName(dialog, sdk, …)   // resolves with a cancel signal
  dialog.replace(() => <DialogAuthManage />) // …which the caller discards
}
```

`DialogPrompt.show` returns `null` on cancel, `updateDisplayName` returned on it,
`updatePassword` returns `false` for every cancel (it retries bad input itself), and
`DialogLogin.run` resolves `null`. **The cancellation was already being reported at
every one of them.** The callers threw it away, so pressing `esc` at the prompt reopened
the menu you were escaping from. Fixed by honouring the signal; `updateDisplayName` also
had to grow a discriminated result, because it answered cancel with `undefined` and a
failed update with `null` — two falsy values a caller cannot tell apart, which is
presumably why neither caller tried.

`logout` in the same list is the counter-example and is deliberately left alone: it has
no cancel path, so reopening is how the signed-out state gets shown. A rule applied
uniformly here would have been wrong four times out of five.

### The candidate set, and why it is not a gate

`packages/tui/script/audit-late-side-effects.ts` reproduces the scan: 88 candidate sites,
sorted so files with no cancellation helper come first. It is triage, not CI. The
detector is indentation-based and cannot distinguish a call from a call _site_ —
`onSelect: () => dialog.replace(…)` built after an await is safe, because the handler
only runs while the component is alive, and it is indistinguishable from the bug at this
level. Roughly one in five hits is real. A blocking gate would mean accepting that ratio
or maintaining an allowlist longer than the findings, so it always exits 0 and prints a
list for a human.

### What is not verified

`packages/tui` has **no test directory**. The package carrying every one of these sites
has no unit-test surface at all, so the `dialog-auth-manage` fix is verified by reading
the four cancel contracts and by `tsc`, and not by running it. Giving this package a test
harness is EOT-20 work and is the precondition for auditing the other 87 sites with any
confidence.

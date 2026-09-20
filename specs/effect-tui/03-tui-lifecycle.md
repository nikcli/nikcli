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

Two rounds of this audit produced wrong fixes before producing a usable rule. Both
failures are recorded, because each one is a conclusion the source supports right up
until you run it.

### The failure is an external effect, not a stale write

In Solid, writing a signal after the owner is disposed is harmless — nothing reads it. So
"every `createResource` / `onMount` that does not cancel" is not the defect list; it is 30
files of mostly nothing. The defect is acting on the outside world after an await the user
has walked away from.

### Round one: reopening after an await is the idiom, not the bug

`ui/dialog.tsx`'s `replace()` sets `store.stack` unconditionally and escape runs
`closeTop()`, which on a one-deep stack empties it. Read that far and every
`await …; dialog.replace(…)` looks like it reopens a dialog the user escaped.

It does not, because **a nested flow replaces its parent rather than stacking on it**.
`DialogPrompt.show` and `DialogConfirm.show` both call `dialog.replace`, so the parent is
already gone before the user answers; the caller restoring it afterwards is how they get
back — on cancel exactly as on success. Three call sites were changed to skip the reopen
on cancel, which dropped the user out of a flow every neighbour returns them to. Reverted.

### Round two: `useAbortOnCleanup` cannot be used by a dialog that opens dialogs

The rule that replaced it — guard the _long-async_ awaits (network, spawn, OAuth) and
leave the _modal_ ones alone — is right about which awaits matter and wrong about the
mechanism, and the same sentence contains the proof. **Modal means the sub-dialog replaced
this component**, so by the time the long-async call after it returns, this component's
owner was disposed long ago. Not because the user left: as part of the flow working.

That shipped, and the symptom was immediate in a running TUI. Picking a provider opened
"Select auth method"; selecting an entry there did nothing at all, because
`createDialogProviderOptions` checked `alive.disposed()` after `provider.oauth.authorize`
and it was always true. Every guard in the batch had the same shape and all of them are
reverted.

**`useAbortOnCleanup` is for a leaf dialog** — one that awaits without opening anything,
like `dialog-provider`'s `AutoMethod` and `CodeMethod`, which have used it correctly all
along. A component that chains dialogs has no owner left to ask.

### What the right primitive looks like, and what blocks it

The question a chaining caller needs answered is not "is my owner alive" but **"is the
stack as I left it"**. That is observable: every mutation in `ui/dialog.tsx` — `replace`,
`clear`, `closeTop`, the non-interactive escape path — could bump a counter the caller
captures before an await and compares after. Unchanged means nobody moved; changed means
the user escaped or opened something else, and the effect should be dropped. It is also
the only signal available to the nine plugin entry points and four ctx-bag helpers that
have no Solid owner at all, and `api.ui.dialog` exposes nothing of the kind (`depth`
cannot serve: a replace leaves the depth identical).

It was written and then dropped rather than committed. `init()` in `ui/dialog.tsx` is not
exported and calls `useRenderer()`, so the dialog host cannot be constructed in a test —
the primitive would have landed with no consumer and no way to fail. **Making the dialog
host reachable from `packages/tui/test/` is the precondition**, and it is the next thing
worth doing here, ahead of any further site-by-site work.

### A third correction: the harness was never missing

Round two was partly justified by "`packages/tui` has no test directory", which is true
and misleading. The TUI's tests live in **`packages/nikcli/test/tui/`** — 55 files, which
this roadmap's own evidence table names as the required location for TUI work — and two
of them, `lifecycle-attempts.test.ts` and `dialog-lifecycle.test.ts`, already cover
`useAbortOnCleanup` and `useAttempts` with the same `createRoot` owner pattern that was
written again from scratch a package over. The second test directory has been removed and
the one thing it held that was genuinely new, `adopt` coverage, folded into the existing
file.

`test/tui/tui-source.ts` is the part worth knowing about: seven tests there assert against
the TUI _source text_ precisely because mounting a dialog drags in the whole app. That is
the tool for pinning a dialog contract without a terminal, and it was available the whole
time.

### What is kept from all of this

`script/audit-late-side-effects.ts`, which reproduces the candidate scan; and one fix that
never involved an owner — `component/prompt/index.tsx` spawned the microphone after
`detectVoiceRecorder` resolved with no way to notice the hold-to-talk key had been
released, so `stopVoiceRecording` found nothing to stop and the spawn happened anyway. A
plain flag, because that is a press that ended, not a component that unmounted.

### The candidate set, and why it is not a gate

`packages/tui/script/audit-late-side-effects.ts` reports 88 candidate sites, sorted so
files with no cancellation helper come first. It is triage. The detector is
indentation-based and cannot distinguish a call from a call _site_ —
`onSelect: () => dialog.replace(…)` built after an await is safe and looks identical — and
it misses a real site behind one level of indirection, as it did for `clearProfile`
followed by a local `reopen()`. `app.tsx` is the clearest illustration: all eight of its
hits are handler definitions or an `onCleanup` body, and its one genuinely async site
already guards itself with `dialog.stack.length === 0`, an idiom the detector does not
recognise and the correct one for "open fresh only if nothing else is up".

A blocking gate would mean accepting that ratio or maintaining an allowlist longer than
the findings, so it always exits 0 and prints a list for a human.

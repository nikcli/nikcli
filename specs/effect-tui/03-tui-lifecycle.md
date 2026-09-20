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
await the user has walked away from**.

### But "reopening after an await" is the idiom here, not the bug

This was got wrong first, so it is written down. `ui/dialog.tsx`'s `replace()` sets
`store.stack` unconditionally and escape runs `closeTop()`, which on a one-deep stack
empties it. Reading only that far suggests every `await …; dialog.replace(…)` reopens a
dialog the user escaped.

It does not, because **a nested flow replaces its parent rather than stacking on it**.
`DialogPrompt.show` and `DialogConfirm.show` both call `dialog.replace`, so the parent is
already gone before the user answers; the caller restoring it afterwards is how they get
back. That is the app-wide idiom, on cancel exactly as on success —
`dialog-auth-manage.tsx`'s `restoreProfile` is called unconditionally, and
`dialog-skills.tsx`'s `install()` restores the results list explicitly on `!confirmed`.
Three call sites were "fixed" to skip the reopen on cancel, which made them drop the user
out of a flow that every neighbour returns them to. Reverted.

The distinction the audit actually needs:

- **A modal await** — `DialogPrompt.show`, `DialogConfirm.show`. The user is sitting in
  the dialog and can open nothing else, so their answer _is_ the continuation.
  Restoring the parent is correct and cancelling is not special.
- **A long async await** — a network call, `Bun.spawn`, an OAuth callback, a device-code
  poll. The user can leave and open something else while it runs, and a `replace` landing
  afterwards is what `util/lifecycle.ts` describes: a dialog shoved over whatever they
  opened next. `dialog-skills.tsx:130` awaits `sdk.client.app.skill.create` and then
  replaces, with no guard — that shape is the real target, and the helper for it already
  exists.

Which kind an await is cannot be seen from the `replace` that follows it, which is the
whole reason this is a per-site reading exercise rather than a codemod.

### First file audited under that rule

`component/dialog-skills.tsx` had 13 flagged sites. Five were long-async and are now
guarded with `useAbortOnCleanup`: the `skill.create` round trip, the `bun x skills add`
spawn, the `skill.delete` round trip, and the `bun x skills` search — each checked
**after** the await, because aborting is not synchronous with the continuation and a
request that had already come back still resumes there. The install is deliberately left
to finish rather than killed: a half-written skill install is worse than a completed one,
and what must not happen is the dialog landing back over whatever the user opened.

The remaining three are modal restores after a `DialogConfirm.show` and are correctly
unguarded — plus one false positive, the `Bun.spawn` line itself, which is the intended
consequence of confirming rather than a late effect.

### Second file, and both of the detector's blind spots

`component/dialog-profile.tsx` had 11 flagged sites and is now clear. Five were real —
`patchProfile` in `apply` and in the verbosity picker, `clearProfile` in the reset,
`write` in the list editor, and the caller-supplied `onDone` in `TogglePicker` — each a
round trip with a `replace` behind it.

The other six were `onSelect: () => dialog.replace(…)` **handler definitions** built after
an await. They are safe, and they also stopped being reported the moment a guard landed
upstream of them in the same function, which is worth saying plainly: the count going down
is not proof that eleven defects were fixed.

The file also showed the opposite failure. `clearProfile` is followed by `reopen()` — a
local name that happens to call `dialog.replace` — so the detector never flagged it. It
**under**-reports through one level of indirection just as readily as it over-reports on
handler definitions, which is the second reason it is triage rather than a gate.

### The inventory, completed

88 → 46. Every remaining site is accounted for, and none of them is an unfixed defect.

**Guarded (21 sites, across 14 files).** Each a round trip or a spawn with an effect
behind it: the config category writes, `routine.create`, the session-warp move, the
workspace list probe and remove, the onboarding voice persist, both session forks,
`logout` in auth-manage, `provider.oauth.authorize`, the session sync and the background
abort in the session route, plus the five in `dialog-skills` and the five in
`dialog-profile` recorded above.

**Modal restores, correctly unguarded.** `DialogConfirm.show` in skills, the nested prompt
flows in auth-manage, the auth-method picker in provider. The user is in the dialog and
their answer is the continuation.

**Handler definitions the detector cannot tell from calls (the largest group).**
`app.tsx` is the clearest case: all eight of its hits are a JSX `onBeforeExit`, a keymap
`run()`, an `onCleanup` body, and effects whose paired await lives in another function
entirely. Its one genuinely async site already guards itself with
`dialog.stack.length === 0` — a correct idiom the detector does not recognise, and the
right one for "open fresh only if nothing else is up". Same story for `dialog-support`'s
Ctrl+O, `dialog-settings/brain`'s `openModelPicker`, `dialog-routine`'s model row,
`workspace-create`'s `onSelect`, and four of the six remaining in the session route.

**Already guarded by their own mechanism.** `browser-surface` carries a `disposed` flag it
checks itself; `plugin/runtime.ts` is not a component and its `dispose()` calls _are_ the
intended action.

**One real fix outside the dialog pattern.** `component/prompt/index.tsx` spawned the
microphone after `detectVoiceRecorder` resolved, with no way to notice the hold-to-talk
key had been released in between: `stopVoiceRecording` found no recorder yet and returned,
and the spawn happened anyway — a recording process nobody started and nobody would stop.
Now the stop marks the start as cancelled.

### The one class left open, and why it is not a guard

Nine sites are plugin entry points — `openManager(api)` in chatbot, connectors, computer,
discord, island, brain. They are not Solid components: there is no owner, so `onCleanup`
would never fire, and `api.ui.dialog` exposes only `replace`, `clear`, `setSize` and
`size`. A plugin cannot ask whether anything of its own is still open.

Four more are standalone helpers that take a context bag rather than living in a component
(`workspace-create`'s session opener, `workspace-list`'s, `repo-actions-menu`,
`util/editor`). Same shape, same reason.

Closing these needs a cancellation token threaded through the plugin command invocation,
or `stack` exposed on the plugin dialog facade — an API decision, not a guard insertion,
and one that should be made deliberately rather than guessed at mid-audit.

### The candidate set, and why it is not a gate

`packages/tui/script/audit-late-side-effects.ts` reproduces the scan: 88 candidate sites,
sorted so files with no cancellation helper come first. It is triage, not CI. The
detector is indentation-based and cannot distinguish a call from a call _site_ —
`onSelect: () => dialog.replace(…)` built after an await is safe, because the handler
only runs while the component is alive, and it is indistinguishable from the bug at this
level. Roughly one in five hits is real. A blocking gate would mean accepting that ratio
or maintaining an allowlist longer than the findings, so it always exits 0 and prints a
list for a human.

### The harness that was missing

`packages/tui` had **no test directory at all**, which is why an audit of 88 sites could
not be carried out with confidence: there was nowhere to put the evidence. `test/` now
exists, `bun test` is wired into `script/ci-validate.ts`, and the first file covers
`util/lifecycle.ts` — the primitive the rest of the audit builds on.

No renderer is involved, and that is what makes it cheap: `createRoot` supplies a real
Solid owner and a `dispose` that runs `onCleanup`, which is precisely the lifecycle these
helpers hook. A dialog being dismissed is this, with a renderer attached. Ten tests, under
100ms, so adding it to the validation run does not re-create the full-suite problem
ROADMAP's non-negotiables warn about.

They were checked against the bugs their docblocks describe, not just run: making `adopt`
return early instead of releasing fails the two resource cases, and collapsing the
generation counter to a boolean fails three more. A lifecycle test that cannot fail is the
same nothing as a counter with no emitter.

### What is still not verified

The `dialog-auth-manage` fix itself is verified by reading the four cancel contracts and
by `tsc`, **not by running the TUI**. The remaining 87 candidate sites each need the same
per-site reading — what the awaited call returns on cancel, and whether the effect after it
is a call or a call site. The harness is the precondition for that work, not a substitute
for it.

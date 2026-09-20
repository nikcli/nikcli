# EOT-09: Jobs, Persistence, and Resource Budgets

Status: proposed. Tier: 1. Phase: P2. Dependencies: EOT-02, EOT-04, EOT-10.
Owner: nikcli execution/domain repository maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B03, B14, B18, B19: durable background records, ownership leases, monitor output limits, throttled persistence,
and sync journals already exist. The next step is predictable admission, durable terminal-state publication, and bounded
repository work. A new generic scheduler or SQL migration is not justified by the existence of Effect APIs.

## Scope and Non-Goals

Strengthen existing session/tool/delegation/monitor ownership and repository seams, starting with one job type. Preserve
`Database.syncDb()` repositories, schemas, logs, job IDs, and status wire compatibility. No live database operations,
dependency installation, distributed workflow platform, global worker-pool replacement, or default concurrency change
without characterization and review.

## Design and Requirements

1. Describe each execution path's admission class and owner: foreground session, local child process, background agent,
   provider request, and read-only index/cache task. Set per-instance and process-wide caps from EOT-01 measurements.
   Provide cancellation while queued, observable queue position/pressure, and fair scheduling so one session cannot starve
   another. Queued is not running; add wire state only through EOT-10 if the current contract cannot represent it.
2. Acquire capacity and resources in scoped Effect operations at the existing service boundary. Release permits on every
   Exit, including cancellation before launch. Do not hold database transactions or shared locks while waiting on network,
   child process exit, or user permission.
3. Preserve durable-job ownership beyond the submitting request's lifetime. Cancel explicitly by job identity; propagate
   cancellation to owned children/provider requests while preserving the durable record. Process restart recovery checks
   leases and ownership before adopting or orphaning work; do not infer liveness from PID existence alone.
4. Use a terminal-state transition guard in the repository transaction: a running job may settle complete/error/timeout/
   cancelled/orphaned according to its domain, but a late result cannot overwrite an already committed terminal state.
   Use actual process exit and persisted outcome, not upload accepted, stream EOF, or UI closure, as completion evidence.
5. Persist the terminal record and any required result/log reference before publishing completion. If notification fails,
   authoritative reads/recovery can discover the result. If the durable write fails, report a persistence failure; never
   publish a successful terminal event for a state that was not committed. Exactly-once external effects are not promised.
6. Preserve monitor's existing 32 KiB event and 64 KiB tail bounds and 1-second persistence coalescing unless evidence
   supports a change. Drain stdout/stderr without unbounded memory, retain the existing full log behavior, and flush final
   output before terminal publication. Separate log write failure from child execution success.
7. Profile repository queries and synchronous transaction duration before changing storage technology. Add stable-cursor
   pagination, projections, or indexes only for demonstrated hot paths; derive cache keys from instance/config revision.
   Keep transactions short and perform heavy transforms outside them. Schema/index migrations need explicit approval,
   additive rollout, and existing isolated-database tests; no destructive data cleanup in an optimization PR.
8. Reuse existing sync journal and snapshot machinery for recoverable state where appropriate; EOT-15 owns the
   snapshot/watermark contract and EOT-16 owns the workspace scope that bounds a job's resources. Event coalescing may reduce
   intermediate progress persistence but must never omit a terminal transition or required user decision. A process crash
   between commit and notification must still recover the final record without rerunning its external side effects.

## State and Race Policy

| Race                                     | Required resolution                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Cancel while waiting for capacity        | Remove queued work; no child starts; permit accounting unchanged                    |
| Cancel versus successful exit            | Repository transition wins once; late callback cannot rewrite terminal state        |
| Timeout versus output flush              | Final status records timeout; flush bounded final output or record its failure      |
| Restart versus stale worker heartbeat    | Validate owner/lease generation before accepting updates                            |
| Commit succeeds, event publication fails | Durable outcome remains queryable; recovery informs UI                              |
| Write fails after child succeeds         | Execution outcome and persistence failure are distinguished; no false success event |

## Failure and Cancellation

Use domain `Schema.TaggedError` for admission, process launch, persistence, and timeout failures where introduced; preserve
full Cause internally. Tool permission denial must occur before launch/admission side effects that need permission;
EOT-17 owns that evaluation boundary and the coupling map it enforces. A
cancelled Promise is not evidence of a killed process: verify process-tree termination, pipe closure, and log finalization
using supported platform helpers. Do not alter permission coupling (`monitor` to `bash`) during refactoring.

## Acceptance and Verification

- Queue more jobs than capacity, cancel queued/running jobs, and assert concurrent work never exceeds limits and all permits
  return. Verify fairness and submitter-disconnect survival for durable jobs.
- Race complete/cancel/timeout/restart with controlled barriers; exactly one terminal record remains and UI state agrees
  after reconnect. Inject failure between commit and event publication without rerunning the external operation.
- Flood output and slow the log sink; assert memory bounds, full-log behavior, final tail, real exit code, and visible disk
  write failure. A successful spawn or accepted upload cannot satisfy completion assertions.
- Exercise isolated repository restart/readback and lease-expiry cases. No tests use the user's database or real provider
  credentials. DB operations require the user's approval before execution, even when local fixtures are intended.
- Extend existing `packages/nikcli/test/background/`, `packages/nikcli/test/delegation/`, `packages/nikcli/test/tool/`,
  `packages/nikcli/test/database/`, and `packages/nikcli/test/sync/` cases for each migrated path.
- From `packages/nikcli`, select the changed path's individual test files; for the whole suite use `bun run test:ci`, not a
  single unsharded `bun test`. Use one final root `bun run typecheck` after the complete slice.
- Meet EOT-01 resource and latency budgets. Candidate repository target: p95 synchronous transaction under 10 ms for the
  reference session workload; any longer query gets a measured mitigation plan before admission limits are increased.

## Migration and Rollback

Start with monitor or one background job family, characterize current limits and transitions, add guards/metrics, then
introduce bounded admission and measured query improvements. Do not combine this with a storage-engine replacement.
Rollback scheduler/adapter changes while preserving durable records, terminal-state guards, and logs. Additive schema
changes require a tested compatibility/downgrade plan; never roll back by deleting user data or replaying side effects.

## Durable Recovery — 2026-09-20

The release gate says _durable_ terminal states, and the word was doing work nothing
checked. `isTerminal` and `canTransition` are pure functions with their own unit tests, and
neither says anything about what is in the database after a crash.

The state a crash actually leaves is a row that says `running`, owned by a process that is
gone. Nothing times it out on its own; `reconcileInterrupted` is what turns it into a
settled outcome, and until it runs the TUI shows a task that will never finish.
`test/background/recovery.test.ts` drives that path against a real isolated database and
**re-reads every assertion from the repository** rather than trusting a return value,
because durability is the entire claim.

Seven cases, of which three are the ones worth naming:

- A live sibling's work is not stolen. One process sweeping another's heartbeating run
  would settle a task that is still going — worse than the stuck row the sweep exists to
  clear.
- `ignore` is honoured, which is how the sweeping process keeps its own in-flight rows:
  stale by wall clock, not abandoned.
- `finalize` on a settled row does not land. `canTransition` is enforced at the write path,
  and this is the half its unit test cannot reach — that the refusal reaches the database.

Two details came out of making it fail on purpose.

**The lease is guarded twice.** Deleting the `leaseExpired` check inside
`reconcileInterrupted` changes nothing, because `markOrphaned` checks it again before
settling. That is sound defence and it means the sweep's own check is not what the suite
discriminates; breaking `leaseExpired` itself is what fails the live-run case. Worth
knowing before someone deletes the "redundant" line and concludes the tests cover it.

**The repositories return `Effect`, not a promise.** A repo call that is merely `await`ed
resolves the Effect object itself, so every assertion reads `undefined` off it and every
test fails identically regardless of the behaviour. The first run of this file failed that
way in all five cases — an error that looks like a broken subject and is a broken harness.

Each project in the suite is a real git repository, because the project id is derived from
the root commit: two plain temp directories share the fallback id `global`, which would put
every case's rows in one table and let a leak read as a pass.

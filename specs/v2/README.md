# V2 Specifications

These documents explain V2 behavior that is difficult to recover from one source file. They are not API reference and not a backlog.

"V2" in nikcli names three separate, partially-landed things. Keep them apart when reading:

| Name           | What it is                                                                                                                            | Where                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `MessageV2`    | The message/part shape the LLM layer and every client already use. Authoritative.                                                     | `src/session/message-v2.ts` |
| `SessionV2`    | The flat entry model. Reads are native; writes persist entries first and derive v1 from them. HTTP create/prompt go through this API. | `src/session/v2/*`          |
| HttpApi ("v2") | The Effect `HttpApi` server surface that replaced Hono. Fully landed.                                                                 | `src/server/httpapi/*`      |

## Current Contracts

| Document                                            | Job                                                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Session](./session.md)                             | Explain admission, the step loop, retry, compaction, cancellation, and recovery boundaries.                                                              |
| [Session v2 write path](./session-v2-write-path.md) | Entries persist first; v1 is `toV1*` of those entries. HTTP create/prompt share `SessionV2`. `prompt_data` stays on `message_info`. Implemented.         |
| [Tools](./tools.md)                                 | Explain tool construction, registration, execution, truncation, and outcome laws.                                                                        |
| [Provider and model catalog](./provider-model.md)   | What a provider and a model are, the six ordered build sources, variants, and the route to `@nikcli-ai/llm`.                                             |
| [API map and context model](./api.md)               | Where runtime context comes from for any route: server-scoped, request, or session-pinned. The route inventory, the two event envelopes, the sync store. |

## Decisions And Proposals

| Document                                                                          | Status                   | Job                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Catalog/config/plugin lifecycle](./catalog-config-plugin-lifecycle.md)           | Accepted and implemented | Record why visible provider state is an invalidatable per-instance cache.                                                                           |
| [Event stream](./event-stream-architecture.md)                                    | Accepted and implemented | One encoded feed, one lag budget per connection.                                                                                                    |
| [Instruction sync](./instruction-sync-proposal.md)                                | Implemented              | Instruction state is a hash delta instead of a per-request rebuild.                                                                                 |
| [Durable pending input](./durable-pending-input.md)                               | Implemented              | Pending row + promotion transaction; steer vs queue; compaction barrier.                                                                            |
| [Restart continuation](./session-restart-continuation.md)                         | Accepted and implemented | Continue interrupted sessions after a graceful server restart.                                                                                      |
| [Provider policy](./provider-policy.md)                                           | Accepted and implemented | Define ordered `provider.use` decisions and legacy compatibility.                                                                                   |
| [Session v2 write path](./session-v2-write-path.md)                               | Implemented              | Persist entries first; derive v1 from them; HTTP uses `SessionV2`.                                                                                  |
| [Public event filter](./public-event-filter.md)                                   | Implemented              | Which bus events are internal, and why withheld means absent rather than typed.                                                                     |
| [CodeMode interpreter support](./codemode-interpreter-support.md)                 | Accepted and implemented | What the confined interpreter accepts, what it refuses, and why each refusal reads as it does.                                                      |
| [Permission ruleset & coupling](./permission-ruleset-and-coupling.md)             | Accepted and implemented | The tool→permission map, last-match-wins evaluation, and the one-way deny asymmetry.                                                                |
| [Loop engine contract](./loop-engine-contract.md)                                 | Accepted and implemented | Synchronous single-flight claim, capacity cap of 3, lease recovery to `orphaned`, sandbox per run.                                                  |
| [Tool / plugin autoload security](./tool-plugin-autoload-security.md)             | Accepted and implemented | Fail-closed autoload gate, allowlist matching, and pin resolution before import.                                                                    |
| [Logging redaction contract](./logging-redaction-contract.md)                     | Accepted and implemented | What `Log` masks on the way to the buffer, and the one escape hatch.                                                                                |
| [Provider message normalization](./provider-message-normalization.md)             | Accepted and implemented | The semantic contract `normalizeMessages` holds; P3 measured it and left it alone.                                                                  |
| [CI pipeline runtime budgets](./ci-pipeline-runtime-budgets.md)                   | Accepted and implemented | Why no workflow runs the suite, how `test:ci` shards it, and the guards around a `--detach` deploy.                                                 |
| [Mission orchestrator contract](./mission-orchestrator-contract.md)               | Accepted and implemented | Dependency-ordered features in one worktree, re-attached on resume; exec lease recovery.                                                            |
| [Mobile companion protocol](./mobile-companion-protocol.md)                       | Accepted and implemented | The wire contract, the permission reply union, and bearer authentication.                                                                           |
| [Observability / OTLP / live panel](./observability-otlp-and-in-process-panel.md) | Accepted and implemented | In-process capture by default, OTLP on an endpoint, and the empty layer when neither is on.                                                         |
| [Workspace request proxy](./workspace-trust-lattice.md)                           | Accepted and implemented | Which requests are forwarded to a remote workspace, and what the local path answers.                                                                |
| [Share v2 contract](./share-v2-contract.md)                                       | Accepted and implemented | The envelope list, `remote` vs `local`, local-only public reads, and delete-not-tombstone.                                                          |
| [CLI command surface](./cli-command-surface.md)                                   | Accepted and implemented | What `nikcli …` actually registers; the command table is gated by a test.                                                                           |
| [Brain consolidation pass](./brain-consolidation-pass.md)                         | Accepted and implemented | What the scheduled pass reads and writes, and when it counts as having run.                                                                         |
| [Config review](./config.md)                                                      | **Proposed**             | Per-field keep/remove/redesign ledger for `nikcli.json`. Its legacy-key tests landed; what keeps it proposed is that no field has been renamed yet. |

## Historical Context

| Document                                  | Job                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------- |
| [Schema changelog](./schema-changelog.md) | Preserve the durable-shape compatibility ledger, newest entry first. |

## Working Documents

These are not contracts. They carry no invariants and pin no tests; they exist so the v2 port's conventions and open decisions are written down somewhere other than a commit message.

| Document                                  | Job                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Service instructions](./instructions.md) | How to write and port a service here: shape, per-instance state, errors, schemas, verification. |
| [Open work](./todo.md)                    | What is left of the v2 port, what nikcli already passed, and what it deliberately diverged on.  |

## Status Rule

Every **contract** in this directory is `Accepted and implemented`: its invariants are named in its header table and pinned by the tests listed there. The status is not decoration — a contract earns it by having a test that fails when the behavior changes, and the last seven earned it on 2026-09-10 (ROADMAP **D2**).

A new document may enter as `Proposed`, and while it does it must carry a **Missing** row naming the one thing that would promote it. A `Proposed` status with no such row is incomplete, not pending. [config.md](./config.md) is the one document currently in that state.

That row usually names a test, and said so until 2026-09-21, when writing the test it named produced the case the rule did not cover. `config.md` is a **ledger of decisions**, not a description of behaviour: its legacy-key mappings are now covered in both directions, and it is still not a contract, because nothing it proposes has been done. So the **Missing** row names whatever is actually absent — a test where behaviour is untested, an execution where the behaviour does not exist yet. What it may never do is go empty while the status stays `Proposed`.

Put actionable, dated work in [../ROADMAP.md](../ROADMAP.md), not here.

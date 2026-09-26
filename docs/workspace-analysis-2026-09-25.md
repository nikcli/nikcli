# nikcli Workspace Analysis — 2026-09-25

Branch `live-main` @ `4d1240ca6d` (v1.396.0). Analysis is read-only; nothing was modified.
Every number below was measured, not estimated. Claims I could not verify are marked as such.

---

## 1. Summary

| Dimension                   | Measured                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| Workspace packages          | 41 (+3 under `packages/console/*`, +`github`) — **44 in turbo scope** |
| TypeScript/TSX under `src/` | **429,911 LOC** across 1,577 files                                    |
| Largest package             | `packages/nikcli` — 153,339 LOC / 711 files (36% of the monorepo)     |
| Rust (ade/src-tauri)        | 9,435 LOC                                                             |
| Test files                  | **819** total; 488 under `packages/nikcli/test`                       |
| HTTP endpoints              | **319** across 30 groups, in 44 contract files                        |
| SQL domain repos            | 18, over 33 migrations                                                |
| Commits (30d)               | 695 — roughly 4 releases/day                                          |
| Dependency graph            | `bun.lock` 8,477 lines, 8 patched deps                                |
| Typecheck (monorepo)        | **FAILS — OOM-killed, exit 137** after 7m34s                          |
| Typecheck (nikcli alone)    | passes — 148s, 981 MB peak RSS                                        |

**Headline.** The repo is fast-moving, well-instrumented, and honest about its own tradeoffs
(the comment in `script/test-ci.ts` explaining _why_ sharding exists is genuinely good
engineering). Its two structural liabilities are **import-cycle density** and a
**spec program that has not moved off "proposed" despite 695 commits in 30 days**.

---

## 2. Package inventory

Classification: **core** = the shipped product, **ui** = client surfaces, **satellite** = optional/deployed
services, **dormant** = present in the workspace with no current consumer signal.

| Package                                                                     |           LOC (src) |     Tests | Class     | Note                                                |
| --------------------------------------------------------------------------- | ------------------: | --------: | --------- | --------------------------------------------------- |
| `nikcli`                                                                    |             153,339 |       496 | core      | The product. 57 top-level src dirs.                 |
| `tui`                                                                       |              79,337 |         0 | ui        | 2nd largest, zero tests.                            |
| `app`                                                                       |              50,548 |        46 | ui        | SolidJS web GUI.                                    |
| `ade`                                                                       | 78,137 + 9,435 Rust |       157 | ui        | Tauri desktop; highest 30d churn (2,088 files).     |
| `voice`                                                                     |              28,861 |        37 | core      | In a package cycle — see F2.                        |
| `web`                                                                       |              17,559 |         3 | ui        | Own `check:*` gates, none wired into CI.            |
| `ui`                                                                        |              15,181 |         0 | ui        | Shared primitives.                                  |
| `sdk`                                                                       |              15,082 |         1 | core      | Generated client; `types.ts` fully typed.           |
| `util`                                                                      |              11,772 |         0 | core      | Shipped runtime dep, zero tests.                    |
| `llm`                                                                       |               9,070 |        23 | core      |                                                     |
| `bench-tui`                                                                 |               6,632 |         0 | dev-only  | Benchmark harness.                                  |
| `inference`                                                                 |               2,934 |         6 | satellite | **No `typecheck` script** — see F6.                 |
| `plugin` / `remote` / `companion`                                           |              ~6,500 | 0 / 0 / 0 | core      | All shipped runtime deps, all untested.             |
| 19 further packages                                                         |        < 3,500 each |     mixed | satellite | Includes `discord`, `slack`, `enterprise`, `cloud`. |
| `mobile`, `desktop`, `webrenderer`, `containers`, `extensions`, `ade`(rust) |                   — | 7/1/0/0/0 | ui        | Non-TS trees; excluded from LOC.                    |

`packages/nikcli/src` by size: `server/` 24.8k · `session/` 18.9k · `cli/` 15.5k ·
`tool/` 11.6k · `provider/` 10.7k · `codemode/` 6.5k · `plugin/` 6.0k · `acp/` 3.7k.

Largest hand-written files: `provider/provider.ts` (2,445) · `config/config.ts` (2,322) ·
`session/prompt.ts` (2,135) · `lsp/server.ts` (2,124). The two largest files in the tree
(`httpapi/client/generated/client.ts` 3,110 and `client/api/api.ts` 2,824) are generated.

---

## 3. Findings

Severity per your convention. **High** = correctness/security/blocks-work; **Medium** = structural debt
with a concrete cost; **Low** = hygiene.

### F1 — Monorepo `typecheck` is OOM-killed · **High**

```
$ bun run typecheck        → exit 137 (SIGKILL), 7m34s, 38/44 tasks done
$ cd packages/nikcli && bun run typecheck
                          → exit 0, 147.8s, 980,926,464 B peak RSS
```

The package is healthy. The failure is **parallel memory pressure**: this machine has 8 GB, and
`nikcli` alone needs ~0.98 GB. `package.json:13` already passes `--concurrency=1`, and turbo
2.9.18 accepts the flag — but the run still started 38 tasks in one 454s wall window, which is
arithmetically impossible under real serialization (the single longest task is 148s). So the flag
is not being honored in practice.

- **Fix or leave:** fix. Set `concurrency: 1` in `turbo.json` (authoritative, unlike the CLI flag)
  or export `TURBO_CONCURRENCY=1`, and add `--summarize` to keep the log readable. Cheap, and it
  makes `bun run typecheck` usable on any 8–16 GB laptop.
- **Caveat:** CI runners are larger, so this is likely a local-dev-only failure. It still blocks
  exactly the verification step AGENTS.md tells every agent to run.

### F2 — Circular runtime dependency `@nikcli-ai/voice` ↔ `@nikcli-ai/ade` · **High**

Turbo warns on every invocation:
`WARNING Circular package dependency detected: @nikcli-ai/voice, @nikcli-ai/ade`

Both edges are in `dependencies` (not `devDependencies`), so this is a real published-package
cycle: `packages/voice/package.json:24` → `@nikcli-ai/ade`, and `packages/ade/package.json:59` →
`@nikcli-ai/voice`. It defeats deterministic build order and is the kind of cycle that breaks
only in a clean CI cache.

- **Fix or leave:** fix. Almost certainly one side wants a `devDependency` or a type-only import.
  Cheap to resolve and removes a permanent warning from every turbo run.

### F3 — 402 import cycles spanning 283 of 711 files · **High (structural)**

Measured with DFS over the real import graph (strict resolution, `@/` alias and relative paths,
`import`/`export … from` and dynamic `import()`):

```
files: 711 | distinct cycles: 425 | files in >=1 cycle: 283
cycle length histogram: 2:27  3:41  4:10  5:21  6:30  7:30  8:24  9:34  10:29
                        11:40  12:33  13:24  14:14  15:10  16:29  17:4  18:2
```

Hub files (cycle participation):

| File                       | Cycles |
| -------------------------- | -----: |
| `src/server/server.ts`     |    318 |
| `src/bus/index.ts`         |    317 |
| `src/config/config.ts`     |    276 |
| `src/bus/bus-event.ts`     |    219 |
| `src/workspace/index.ts`   |    214 |
| `src/project/bootstrap.ts` |    206 |
| `src/project/project.ts`   |    186 |
| `src/project/instance.ts`  |    170 |

The longest cycle runs 18 files and passes straight through the middle of the domain:
`effect/index → project/instance → project/project → bus/bus-event → config/config → bus/index →
server/server → workspace/index → project/bootstrap → plugin/index → session/index →
permission/next → session/auto-mode → agent/agent → session/system → skill/index → skill/skill`.

This is the single largest structural liability in the repo. It contradicts the core/edge layering
the EOT specs describe, and it is a direct contributor to F1 — a strongly-connected module graph
is why `tsc` needs ~1 GB on 153k lines.

- **Fix or leave:** fix, but incrementally and never as a big bang. The high-leverage move is to
  break the `bus/index` + `bus/bus-event` pair (they appear in 317 and 219 cycles) by moving the
  event _type_ definitions into a leaf module both can import. That single extraction should
  collapse a large fraction of the graph. Gate any attempt on `bun run typecheck` staying green.

### F4 — Domain layer imports the CLI layer · **Medium**

Verified as real **value** imports, not `import type`:

- `src/session/stats.ts:7` → `import { bootstrap } from "@/cli/bootstrap"`
- `src/session/uninstall.ts:9` → `import { UI } from "@/cli/ui"`

Both invert the intended direction (domain → CLI). Low blast radius each, but they are the kind
of edge that justifies pulling `cli/` into anything the session layer touches.

- **Fix or leave:** fix. Both are one-line inversions — inject a callback / return data, let
  `cli/` own the presentation.

### F5 — The core suite does not run in CI; 19 packages have no tests · **Medium**

Confirmed, and the rationale in AGENTS.md is sound (the suite leaks ~80 MB per test file; all
~350 files in one process reached 14.5 GB and the runner was killed at file 175). The split is
already sharded via `script/test-ci.ts` (default 25 files/batch, `--parallel=1` per batch).

The residual risk is concentration: **496 of 819 test files live in one package**, and these
shipped runtime dependencies have **zero** tests — `util`, `tui`, `plugin`, `remote`, `companion`.
`util` in particular is imported by nearly everything.

- **Fix or leave:** should-fix, narrowly. Do **not** re-add the full suite to CI. Instead, unit-test
  the pure functions in `util` — high ratio, no DB, no nikcli instance, negligible CI cost.

### F6 — `packages/inference` is invisible to `turbo typecheck` · **Medium**

It has `build` and 6 tests but no `typecheck` script. Turbo reports **44 packages in scope but
only 38 typecheck tasks** — this is one of the missing six. It is also among the 19 packages with
no tests wired anywhere.

- **Fix or leave:** fix. One line: `"typecheck": "tsc --noEmit"`.

### F7 — Dead and misleading config · **Low**

- `turbo.json` declares `nikcli#test`, `@nikcli-ai/app#test`, `@nikcli-ai/simulation#test` with
  `dependsOn: ["^build"]` — nothing invokes them.
- `packages/web` has its own `check:*` gates; none are referenced from `script/ci-validate.ts`.
- `test-ci.ts:8,10` and `ci-validate.ts:153` both say the suite is "348" / "~350 files".
  **Actual: 488.** The _logic_ is fine (`test-ci.ts` globs the file list and computes batches
  dynamically, default 25), so this is comment drift only — but the 14.5 GB / 80 MB-per-file
  figures those comments justify were measured at 348 files, and the suite is now 40% larger.
  Worth re-measuring before trusting the current batch size.

### F8 — `AccountGroup` is listed in both the served and contract-only API sets · **Low**

Accurate (`public.ts:80` and `public.ts:415`), but it reads as a duplicate and invites a
"which one is real?" question during review.

---

## 4. Two things that are _better_ than they look

Worth stating, because the analysis would be misleading without them.

1. **`specs/perf-baseline.json` exists and is gated.** `script/check-perf-baseline.ts` is wired
   into `script/ci-validate.ts:109`. Its design note is the right call: wall-clock thresholds are
   not portable, so it enforces only machine-independent invariants (every route present, full
   sample count, `min ≤ median ≤ p95 ≤ max`, `scope.created == completed + interrupted + failed`,
   `finalizer-leak == 0`) and merely _reports_ timings. A gate that fires for the runner's reasons
   is a gate people learn to re-run.

   _But:_ it covers **3 of 319 endpoints** — `GET /global/event`, `GET /event`, `GET /session` —
   all trivial reads. EOT-00 is about startup latency on the session/message path, which this
   baseline does not touch. The gate is honest about its own limits; it is just narrow.

2. **The HTTP contract discipline is genuinely disciplined.** `grep -cE '^export type X = (any|Array<any>)$'`
   over the generated SDK types returns **0** — no `any` leaked into the client. The raw-route
   inventory in `httpapi/inventory.ts` keeps `check:routes` honest, and the `jsonSafe` /
   `Schema.optional` interaction is documented at the point it bit twice.

---

## 5. Recommendations, ranked

### Tier 1 — do now (small, mechanical, unblocks verification)

1. **F1** — pin `concurrency: 1` in `turbo.json`. Restores `bun run typecheck` on 8 GB machines.
2. **F2** — break the `voice` ↔ `ade` dependency cycle. Removes a permanent turbo warning.
3. **F6** — add `typecheck` to `packages/inference`. One line, closes a silent hole.

### Tier 2 — next (structural, bounded)

4. **F3** — extract the `bus` event-type leaf module. Highest leverage single change for cycle
   count; verify with `bun run typecheck` + a re-run of the cycle counter.
5. **F4** — invert the two `session/ → cli/` value imports.
6. **F5** — add `util` unit tests only. Cheap, high-ratio, no CI budget impact.
7. **Widen the perf baseline** to at least one session/message-path route so EOT-01 can actually
   gate EOT-00's subject.

### Tier 3 — scheduled

8. **F7** — delete the dead `turbo.json` test tasks, wire `packages/web`'s checks into
   `ci-validate.ts`, and correct the 348 → 488 figure in both comments.
9. **F8** — de-duplicate the `AccountGroup` entry with a one-line comment.
10. Add a **cycle-count budget** to `script/ci-validate.ts` so F3 cannot regress silently. The
    counter is ~25 lines and would have caught this drift.

### Tier 4 — decide deliberately, not by default

11. **The spec program.** 20 of 21 EOT specs are still `Status: proposed`, including **EOT-00,
    which gates every other promotion**, and EOT-01, the measurement baseline AGENTS.md tells
    agents to start from. Meanwhile 695 commits landed in 30 days. Either the program is genuinely
    un-started and should be re-scoped, or work is landing without the specs being updated — in
    which case the status fields are stale and, per the repo's own rule ("Specs stay proposed until
    their acceptance tests land"), they are the thing that is out of compliance. This is a
    bookkeeping-truth decision, not a code one, and it is yours to make.

---

## 6. Method and limits

- **Measured:** LOC, file counts, test counts, endpoint counts, repo/table inventory, import cycles,
  git history, release cadence, typecheck exit codes and peak RSS, the two `session/ → cli/` imports,
  the voice/ade cycle, spec status headers, `bunfig.toml` contents, ignore rules.
- **From delegated read-only agents** (architecture map, test/CI health): the 18-repo→table
  mapping, the served vs contract-only endpoint split, and the 22-check `ci-validate.ts` inventory.
  I independently re-verified the claims I intended to rank highly.
- **Corrected during analysis:** an agent reported `bunfig.toml [test] root` pointing at a
  nonexistent directory. It does not — it is the deliberate sentinel
  `./do-not-run-tests-from-root`, matching the root `test` script that exits 1. Not a finding.
  I also initially looked for `specs/perf-baseline.json` at the repo root and wrongly called it
  missing; the artifact is package-local at `packages/nikcli/specs/` and is present and gated.
- **Not verified:** per-package build success (I did not run builds), the 60-cycle figure an agent
  reported (my stricter measurement gives 402 cycles of length ≥2; the numbers are not comparable),
  and the 123-endpoint `mobile.ts` estimate, which is dispatcher-derived and approximate.
- **Not run:** the test suite, builds, or any benchmark. F1 is the only finding backed by an
  executed command, and it is the one with a measured exit code.

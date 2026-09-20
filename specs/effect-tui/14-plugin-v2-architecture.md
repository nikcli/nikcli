# EOT-14: Plugin v2 Contracts and Hot Reload

Status: proposed. Tier: 1. Phase: P2. Dependencies: EOT-02, EOT-03, EOT-08, EOT-10.
Owner: `@nikcli-ai/plugin` and TUI/nikcli plugin maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B12, B29, B30 in the [register](../README.md): the legacy plugin runtime (`packages/tui/src/plugin/runtime.ts`,
1442 lines) loads internal/v1/v2 plugins, distinguishes success/error/timeout cleanup, tracks generations, and supports
hot reload. The v2 contract (`packages/plugin/src/v2/{effect,promise,tui}`) is the new shape, but the runtime still routes
through the legacy registration path and the `TuiPlugin` / `TuiPluginModule` types. The opportunity is a single
architectural spec for v2: the contract, the runtime seam, hot reload, capability gating, scoped ownership, and the
migration path from v1 to v2.

## Scope and Non-Goals

Define the v2 plugin contract as the canonical shape (effect + promise + tui modules), the runtime seam that loads and
unloads v2 plugins, the hot-reload protocol, and the capability/compatibility gates. Preserve the existing v1 plugins and
internal plugins (background, browser, brain, etc.) — they stay loadable through the legacy path until each is migrated.
Do not introduce a second runtime, allow remote/external plugin loading, change autoload permission defaults, or break
existing v1 plugin compatibility before a tested migration window is open.

## Design and Requirements

1. A v2 plugin is a `V2.Plugin` module exporting `effect` (Effect-side tools/scheduler), `promise` (Promise-side tools), and
   `tui` (TUI-side routes/commands/keymaps). At least one of the three is required; an empty module fails compatibility
   check. The contract is the source of truth; the runtime treats it as a stable API and rejects unknown exports.
2. Manifest: each v2 plugin declares a `manifest` with `id` (scoped, e.g. `org:plugin`), `version` (semver), `kind`
   (`internal`/`user`/`remote-disabled`), `capabilities` (`tools`, `commands`, `routes`, `keymap`, `scheduler`, `storage`,
   `http`), `hostRequirements` (effect version, opentui version, node version), and `permissions` (file system globs,
   network domains, command execution). The runtime refuses to load a plugin whose manifest is incompatible with the host.
3. The runtime is one Effect module per slot: `PluginLoad`, `PluginReload`, `PluginUnload`, `PluginRun`. Each is a scoped
   Effect operation that owns the plugin's lifetime. Quiesce old generation → revoke registrations → dispose acquired
   resources → activate new generation. Activation failure restores the prior validated generation or leaves the plugin
   explicitly disabled; it never runs both generations at once.
4. Each generation gets a revocable `Plugin.Generation` scope: keybindings, slots, routes, subscriptions, timers,
   owned async operations, and host mutations. Revocation happens **before** awaiting plugin cleanup; a late disposer or
   install continuation cannot register into the newer generation. The scope is `Scope.Scope` from Effect, not a Solid
   `onCleanup`, and it composes with the TUI's owner.
5. Hot reload: a file watcher (per-host) emits `Plugin.ReloadRequested(pluginID)`. The runtime serializes reload per
   plugin, validates the new module/compatibility without side effects, quiesces the old generation, disposes it, then
   activates the new one. Validation includes manifest shape, capability grants, schema checks for `tools`/`routes`.
   Failed validation does not dispose the old generation.
6. Capability gating: the host declares the capabilities it can supply at plugin start; the plugin can only call
   capabilities it requested. Missing capabilities disable the corresponding UI actions with a reason; the plugin does
   not invent a stub. The host capability surface is the one EOT-08 already exposes (`configSources`, `upgrade`, `mobile`,
   `serverStart`).
7. Storage: v2 plugins get a scoped key-value store (`Plugin.Storage`) keyed by plugin id. Stores are bounded; a plugin
   cannot read another plugin's store; the runtime evicts store entries on plugin unload. There is no shared global store
   for v2 plugins.
8. Scheduler: a v2 plugin with the `scheduler` capability can register typed `Schedule`s. The runtime enforces non-overlap
   (one run at a time) and bounded retries with `Schedule.exponential`/`Schedule.jittered`. A scheduled task that has
   not finished its previous run does not start a new one.
9. Tools: `V2.EffectTool` and `V2.PromiseTool` schemas share a single declaration. Tool descriptors are typed by the
   contract, generated into the SDK via `generate:httpapi-clients`-equivalent codegen, and validated at load time. Tool
   invocations use `Effect.tryPromise`/`Stream` and respect `Schema.TaggedError`; permission gating follows EOT-17.
10. TUI surface: a v2 `tui` module can register routes, keymaps, slash commands, dialogs, and store keys. The runtime
    merges them into the existing providers (`RouteProvider`, `KeybindProvider`, `DialogProvider`, `CommandProvider`,
    `KVProvider`) without a parallel plugin system. Slot IDs are namespaced under the plugin id to avoid collisions.
11. Compatibility: a v1 plugin continues to load through the legacy runtime. The runtime detects v1 vs v2 by the
    presence of the `manifest` field; both paths can coexist in the same process. Migration is per-plugin, not a flag
    day. Until migrated, the plugin id is reported as `legacy:<id>` for diagnostics.
12. Reload API: a programmatic `Reload(pluginID)` runs the same validation + quiesce + activate path as the file
    watcher. A reloaded plugin that throws during `setup()` is reported as a typed `PluginError.SetupFailed`, never as a
    silent removal.

## Runtime Topology

```text
Host (CLI/embedded/standalone)
  -> PluginLoader (one Effect module)
    -> manifest validation + capability check
    -> scoped generation: register, run, dispose
    -> Storage, Scheduler, Tool, Tui surface (capability-gated)
    -> Hot reload: quiesce → dispose → activate
```

## Failure and Cancellation

Use `Schema.TaggedError`: `PluginError.ManifestInvalid`, `PluginError.Incompatible`, `PluginError.CapabilityDenied`,
`PluginError.SetupFailed`, `PluginError.ReloadConflict`, `PluginError.CleanupTimeout`, `PluginError.StorageQuotaExceeded`.
Cleanup has a per-plugin budget (candidate 5 s) and a process-wide budget; timed-out cleanups revoke capabilities and
record the straggler. A Promise timeout is not evidence the underlying work stopped; the runtime observes the cleanup
finalizer, not the Promise. Migration from v1 to v2 must preserve existing user-visible behavior; behavior changes require
an explicit, separate decision and a flag flip.

## Acceptance and Verification

- A v2 plugin loads in the standalone host and the embedded worker; manifest violations, capability denials, and
  incompatible host versions all fail with typed errors.
- 100 reloads with late registration, throwing disposer, hung disposer, failed import, and incompatible plugin cases:
  exactly one generation is active at any time; owned registrations return to baseline after unload; no double
  registration of the same key/id.
- A v1 plugin continues to load through the legacy path; v1 and v2 plugins can coexist in the same host.
- Storage quotas are enforced; cross-plugin storage reads return `PluginError.Forbidden`; quota exhaustion surfaces as a
  typed failure, not a silent eviction.
- Tool invocations validate inputs against the typed schema and decode outputs before returning; permission gating runs
  before side effects.
- Reload from a programmatic `Reload(pluginID)` produces the same outcome as the file-watcher path.
- Extend `packages/tui/test/plugin`, `packages/nikcli/test/tui/plugin-v2.test.ts`, `packages/nikcli/test/tui/plugin-dispose.test.ts`,
  `packages/nikcli/test/plugin/`, and existing capability tests.
- From `packages/nikcli`: `bun test test/tui/plugin-v2.test.ts test/tui/plugin-dispose.test.ts test/plugin/`. Run
  `packages/tui` smoke (`bun run smoke:standalone`) to confirm no transitive backend import. One final root
  `bun run typecheck` after the slice.
- Meet EOT-01 startup/memory gates; reload latency p95 below the reload budget; reload that runs while streaming does
  not drop events.

## Migration and Rollback

Inventory all existing v1 plugins and classify them. Migrate one internal plugin (`background`) to v2 first, then one
user-facing plugin (`brain` or `observability`), then sweep. Each migration is its own PR with a feature flag that
selects v1 vs v2 loading; the legacy path is removed only when no v1 plugins remain. Roll back by flipping the per-plugin
flag to v1; never delete a manifest or storage entry as part of a migration. Storage entries are additive; a v1 plugin
that has not been migrated sees its data, a v2 plugin sees only its scoped store.

## Discipline Addendum — 2026-09-20

`script/check-plugin-v2.ts` is in CI (commit `644a8f28`). It pins three structural invariants without importing the plugin package, so it costs no build step:

1. `packages/plugin/src/v2/manifest.ts` exports `parseManifest`, `hasManifest`, `Capability`, `ManifestSchema` and the three typed failures, and each failure still carries its `PluginV2*` tag. The tags are what consumers `catchTag` on, so a rename that keeps the code compiling would still break every handler.
2. The tool registry never imports a config-dir tool without consulting `NIKCLI_ALLOW_PLUGIN_AUTOLOAD` or `tool.allow`. Autoload is a hard opt-in: the gate has to be read _before_ the import, because an import is already execution.
3. `packages/nikcli/AGENTS.md` documents the same opt-in. A contract enforced only by a script is one a human reviewer cannot check, and the two drift in opposite directions.

`test/plugin/v2-manifest.test.ts` and `test/plugin/autoload-safety.test.ts` cover the behaviour the gate can only assert structurally.

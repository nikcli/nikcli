# V2 Config Review

| Field   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | **Proposed** — a decision ledger, not a contract. No field below has been renamed or removed yet                                                                                                                                                                                                                                                                                                                                                                      |
| Scope   | `src/config/config.ts` (`Config.Info`), `src/config/paths.ts`, `src/config/tui-schema.ts`                                                                                                                                                                                                                                                                                                                                                                             |
| Missing | Nothing testable. The test this row asked for landed 2026-09-21 — `test/config/legacy-keys.test.ts` (pure mappings) and `test/config/legacy-keys-loader.test.ts` (the three that need a document on disk) cover **all six** mappings the loader performs today. This document stays `Proposed` because it is a ledger and **no field below has been renamed yet**, not because coverage is missing. It is promoted by executing a group, not by writing another test. |

This document breaks nikcli's configuration schema into review groups. Work through one group at a
time and decide whether each field is ported as-is, removed, or redesigned.

`nikcli.json` is the one schema in the codebase that is authored in **zod** and converted to Effect
Schema (`util/zod-effect.ts`) rather than the other way round. That is deliberate — the JSON Schema
published at `https://nikcli-ai.dev/config.json` is the user-facing contract — and it means every
decision here is a zod edit, not a Schema edit.

## Status Labels

- `pending`: not discussed yet
- `keep`: port with substantially the existing meaning
- `remove`: do not carry forward
- `redesign`: keep the capability with a different shape, scope, or owning module

## Schema Scope And Discovery

One schema, no split between global and location config. Fields such as `autoupdate` are meaningfully
global-only, but not enough of them survive this review to justify two schemas. Revisit if that
changes.

Documents are discovered as `nikcli.json` in:

- the global config directory (`Global.Path.config`),
- every ancestor directory between the instance directory and the worktree (`findUp`),
- every `.nikcli` config directory and `NIKCLI_CONFIG_DIR`.

`NIKCLI_CONFIG_CONTENT` merges last and therefore wins. Arrays concatenate rather than replace
(`mergeConfigConcatArrays`); objects merge deeply. `NIKCLI_DISABLE_PROJECT_CONFIG` suppresses the
project walk entirely.

nikcli does **not** support `nikcli.jsonc`. Upstream's v2 config accepts a `.jsonc` sibling; adopting
that is a discovery change, listed as an open question below rather than decided here.

## Group 1: File Metadata

| Field     | Current Purpose                  | Status | Notes                                                                                                            |
| --------- | -------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `$schema` | Editor validation and completion | keep   | Read-only metadata. `Config.update` already writes it when absent on save; loading must not create files for it. |

## Group 2: Process, Server, And Client Settings

| Field           | Current Purpose                                | Status   | Notes                                                                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logLevel`      | Logging level                                  | remove   | No config consumer. `Log.init` in `src/cli/main-effect.ts` takes the level from the `--log-level` CLI option, falling back to `DEBUG` for local installs and `INFO` otherwise.                                                                                                                 |
| `server`        | Host, port, mDNS, and CORS for `serve` / `web` | remove   | No reader found in `src`. `Server.listen` takes its options from the CLI (`src/cli/network.ts`), and `corsWhitelist` is a `ServerRouter` option, not a config read. Same conclusion upstream reached, for the same reason.                                                                     |
| `remote`        | Remote Control defaults                        | keep     | Consumed: onboarding writes it (`dialog-onboarding.tsx`) and `dialog-remote.tsx` reads it back through the synced config.                                                                                                                                                                      |
| `teleport`      | Default remote server for `/teleport`          | pending  | No reader found in `src` or `packages/tui`. Either wire it into the teleport command or drop it; do not leave it published in the JSON Schema unread.                                                                                                                                          |
| `autoupdate`    | `true` / `false` / `"notify"`                  | keep     | Global-only user preference.                                                                                                                                                                                                                                                                   |
| `theme`         | TUI theme name                                 | remove   | **Already migrated out.** `migrateTuiConfig` moves `theme`, `keybinds`, and `tui` from every `nikcli.json` into a sibling `tui.json` (schema `https://nikcli-ai.dev/tui.json`), skipping locations that already have one. The fields remain in `Config.Info` only so old documents still parse. |
| `keybinds`      | Keybind overrides                              | remove   | Same migration. Note the loader still fills in parsed defaults when absent, so removal has to check that path.                                                                                                                                                                                 |
| `tui`           | TUI-specific settings                          | remove   | Same migration. `src/config/tui.ts` reads `tui.json`, and flattens a nested `tui` key so documents written in the old shape still apply.                                                                                                                                                       |
| `locale`        | BCP-47 primary subtag for UI and replies       | keep     | Affects model output, not only presentation, so it is not purely a client concern and should not follow `theme` into `tui.json`.                                                                                                                                                               |
| `ads`           | User-defined tips shown in the TUI tips area   | redesign | Move into `tui.json` the same way. Consumed only by `src/cli/handlers/ads/`.                                                                                                                                                                                                                   |
| `notifications` | Todo notification toggle                       | redesign | Same move.                                                                                                                                                                                                                                                                                     |
| `layout`        | Deprecated layout selection                    | remove   | Already documented as `@deprecated`; stretch layout is always used.                                                                                                                                                                                                                            |

There is no `shell` field. If a configurable default shell is wanted, it belongs in this group.

## Group 3: Commands And Project Resources

| Field          | Current Purpose                         | Status   | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`      | User-defined commands                   | pending  | Upstream removes this in favor of skills. nikcli's commands are also loaded from `{command,commands}/**/*.md` under every config directory (`loadCommand`), so removing the config field does not remove the capability — but nikcli commands carry `agent`, `model`, `subtask`, and template substitution that skills do not currently express. Decide with the skill surface, not before it. |
| `reference`    | Named git or local directory references | redesign | Rename to plural `references`. Keep the named local-path and git-repository entries.                                                                                                                                                                                                                                                                                                           |
| `instructions` | Additional ambient instruction sources  | keep     | One array of local paths, globs, or URLs. Already the right shape.                                                                                                                                                                                                                                                                                                                             |
| _(no field)_   | Skill discovery locations               | pending  | nikcli discovers skills by glob (`{skill,skills}/**/SKILL.md` for nikcli's own roots, `skills/**/SKILL.md` for external ones) with no config surface. Upstream proposes a `skills` array of local roots and remote URLs. Adding it is additive and low-risk.                                                                                                                                   |

Keep ambient instructions separate from skills: instructions are automatically included as model
context, skills are loaded or invoked intentionally. Each instruction source is unambiguously either
a local path/glob or a URL, so the flat array shape stands.

## Group 4: Plugins

| Field    | Current Purpose                         | Status   | Notes                                                                                                                                                                                          |
| -------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin` | Plugin module list                      | redesign | Rename to plural `plugins` and allow `{ package, options? }` entries beside bare strings. Today it is `string[]`, deduplicated at load, with order preserved.                                  |
| `tool`   | Tool autoload allowlist and sha256 pins | keep     | Belongs with plugins conceptually but is a security surface with its own contract — see [tool-plugin-autoload-security.md](./tool-plugin-autoload-security.md). Do not fold it into `plugins`. |

Load order stays part of the contract: hook registration and execution depend on it. The configured
list is package-loaded plugins only; local plugin code stays discovered from `{plugin,plugins}/*.{ts,js}`
under every config directory.

## Group 5: Filesystem And Tool Runtime

| Field        | Current Purpose                    | Status   | Notes                                                                                                                                                                              |
| ------------ | ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watcher`    | Filesystem watcher ignore patterns | keep     | `{ ignore?: string[] }`.                                                                                                                                                           |
| `snapshot`   | Enable filesystem snapshots        | redesign | Rename to plural `snapshots`. Today a bare boolean; it gates undo/revert.                                                                                                          |
| `formatter`  | Formatter configuration            | keep     | `boolean \| Record<string, entry>`. Singular is correct: it configures one subsystem.                                                                                              |
| `lsp`        | Language server configuration      | keep     | Same shape and same reasoning. Custom servers must declare `extensions`.                                                                                                           |
| `attachment` | Attachment handling                | redesign | Rename to plural `attachments`. Singular `attachment` is already a model capability flag, and the collision is live in this codebase (`Model.capabilities.attachment`).            |
| `websearch`  | Web search configuration           | keep     | No upstream counterpart; nikcli-specific tool configuration.                                                                                                                       |
| `rag`        | RAG embedding configuration        | keep     | nikcli-specific.                                                                                                                                                                   |
| `image`      | Image generation configuration     | keep     | nikcli-specific.                                                                                                                                                                   |
| `computer`   | Computer-use tool configuration    | keep     | nikcli-specific; the tool is permission-gated separately.                                                                                                                          |
| `speak`      | Text-to-speech configuration       | keep     | nikcli-specific.                                                                                                                                                                   |
| `mobile`     | Mobile/Tophat integration          | keep     | nikcli-specific.                                                                                                                                                                   |
| `browser`    | Browser tool configuration         | remove   | Already documented in-schema as deprecated and ignored; the `browser_control` tool needs no config.                                                                                |
| _(no field)_ | Tool output truncation limits      | pending  | Truncation is currently constant-driven in `src/tool/tool.ts`. Upstream exposes `tool_output: { max_lines?, max_bytes? }`. Worth adding only if a user actually needs to raise it. |

## Group 6: Sharing And Identity

| Field        | Current Purpose                      | Status | Notes                                                                                                                                                         |
| ------------ | ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `share`      | `"manual"` / `"auto"` / `"disabled"` | keep   | The single sharing setting. See [share-v2-contract.md](./share-v2-contract.md).                                                                               |
| `autoshare`  | Legacy automatic-sharing flag        | remove | Already deprecated; the loader maps `autoshare: true` to `share: "auto"` when `share` is unset. Keep the migration, drop the field from the published schema. |
| `enterprise` | `{ url? }`                           | keep   | Selects the sharing service endpoint when no organization account is active.                                                                                  |
| `username`   | Display name in conversations        | keep   | Defaults to the OS username at load when unset. Identity for conversation and telemetry, not HTTP auth.                                                       |
| `analytics`  | Anonymous per-day model totals       | keep   | On by default; `false`, `DO_NOT_TRACK=1`, or the nikcli-specific env var opts out. No upstream counterpart.                                                   |
| `sync`       | Remote sync hub URL                  | keep   | `NIKCLI_REMOTE_URL` overrides. No upstream counterpart.                                                                                                       |

## Group 7: Providers And Model Selection

| Field                | Current Purpose                      | Status   | Notes                                                                                                                                                               |
| -------------------- | ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`           | Custom providers and model overrides | redesign | Rename to plural `providers`. See [provider-model.md](./provider-model.md) for the record shape it patches.                                                         |
| `disabled_providers` | Disable auto-loaded providers        | remove   | Already deprecated in-schema; `Policy.statements` translates it into deny statements.                                                                               |
| `enabled_providers`  | Provider allowlist                   | remove   | Same — translated into a deny-all followed by allows. Keep the translation, drop the fields.                                                                        |
| `model`              | Default model                        | keep     | Fallback when session and agent specify none.                                                                                                                       |
| `small_model`        | Small/utility model                  | keep     | **Diverges from upstream, which removes it.** nikcli's consumers are wider than title generation, and `""` is a meaningful value meaning "no small-model fallback". |

Provider selection rules already live in `experimental.policies` and are already implemented — see
[provider-policy.md](./provider-policy.md). The only work left in this group is the rename and
dropping the two deprecated fields from the published schema once the translation has a test.

## Group 8: Agents And Permissions

| Field           | Current Purpose                           | Status   | Notes                                                                                                                                                                                     |
| --------------- | ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`         | Primary, subagent, and specialized agents | redesign | Rename to plural `agents`. Also loaded from `{agent,agents}/**/*.md` under every config directory (`loadAgent`), so the config field is an override surface, not the only authoring path. |
| `mode`          | Deprecated agent alias                    | remove   | The loader already merges `mode` entries into `agent` with `mode: "primary"`. Keep the migration, drop the field.                                                                         |
| `default_agent` | Default primary agent                     | keep     | **Diverges from upstream, which defers it.** It is implemented, documented, and falls back to `build` on an invalid value. Removing it would be a regression with no replacement.         |
| `permission`    | Tool permission rules                     | redesign | Rename to plural `permissions`. The normalized ordered ruleset already exists — see [permission-ruleset-and-coupling.md](./permission-ruleset-and-coupling.md).                           |
| `tools`         | Legacy tool enable/disable map            | remove   | The loader already converts booleans into permission rules, collapsing `write`/`edit`/`patch`/`multiedit` into `edit`. Lossy input; keep the conversion, drop the field.                  |

Agent entries keep `mode` (`"primary"` / `"subagent"` / `"all"`) — the nested role field, distinct
from the removed top-level alias of the same name.

Adopt `disabled?: boolean` consistently for named configurable entries, matching formatters, language
servers, and MCP servers. Runtime state may still track `enabled`; that is not user-authored config.

## Group 9: Integrations

| Field        | Current Purpose               | Status   | Notes                                                                                                                                                                                                            |
| ------------ | ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp`        | MCP server definitions        | redesign | Nest the server map under `mcp.servers` so protocol-wide settings live in the same subsystem. Keep nikcli's explicit `type: "local"` / `type: "remote"` entries; do not adopt the copy-paste `mcpServers` shape. |
| `connectors` | Figma, Slack, GitHub, Lovable | keep     | nikcli-specific. No upstream counterpart.                                                                                                                                                                        |

MCP timeouts should become `{ startup, request }` in milliseconds under `mcp.timeout`, with
per-server overrides. Today there is one flat `experimental.mcp_timeout` covering requests only.

## Group 10: Conversation Lifecycle

| Field        | Current Purpose                | Status   | Notes                                                                                                                                                                      |
| ------------ | ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compaction` | `{ auto?, prune?, reserved? }` | redesign | Rename `reserved` to `buffer`: it is the token headroom reserved so automatic compaction triggers before the input window is exhausted, and "reserved" reads like a quota. |

`NIKCLI_DISABLE_AUTOCOMPACT` and `NIKCLI_DISABLE_PRUNE` override `auto` and `prune` at load; both
survive the rename.

Upstream additionally proposes `keep.tokens` for the verbatim-history budget written into the
compaction checkpoint. nikcli has no config for that today; add it only alongside the rename.

## Group 11: Experimental

`experimental` is where nikcli has drifted furthest from a review-able shape: it currently holds
policy statements, hooks, four feature flags for the TUI, brain settings, timeouts, and several
one-off booleans. The group needs splitting before it can be reviewed field by field.

| Field                                | Status   | Notes                                                                                                                                                                                         |
| ------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `experimental.policies`              | redesign | Promote to top-level `policies`. It is implemented, tested, and no longer experimental.                                                                                                       |
| `experimental.hook`                  | redesign | Promote to top-level `hooks`. `file_edited` and `session_completed` are stable.                                                                                                               |
| `experimental.brain*`                | redesign | Promote to a `brain` object — see [brain-consolidation-pass.md](./brain-consolidation-pass.md). Four flat keys (`brain`, `brainMinHours`, `brainMinSessions`, `brainModel`) is four too many. |
| `experimental.tool_timeout`          | keep     | Genuinely a runtime budget; `false` disables.                                                                                                                                                 |
| `experimental.task_timeout`          | keep     | Same.                                                                                                                                                                                         |
| `experimental.mcp_timeout`           | redesign | Move to `mcp.timeout.request`.                                                                                                                                                                |
| `experimental.chatMaxRetries`        | keep     | Rename to snake_case for consistency with its neighbors.                                                                                                                                      |
| `experimental.queued_message_wrap`   | keep     | Four-way union is unusual but each arm is load-bearing; off unless set.                                                                                                                       |
| `experimental.nativeLlm`             | keep     | The gate for native `@nikcli-ai/llm` route streaming. Off by default; falls back to the AI SDK when no `ModelRef` resolves.                                                                   |
| `experimental.tui.*`                 | redesign | Move to the TUI config surface with the rest of `tui`.                                                                                                                                        |
| `experimental.requests.*`            | keep     | Narrow coalescing flags; genuinely experimental.                                                                                                                                              |
| `experimental.memory`                | pending  | Overlaps `brain`. Decide together.                                                                                                                                                            |
| `experimental.openTelemetry`         | remove   | Observability is process-level; `OTEL_EXPORTER_OTLP_ENDPOINT` already gates export. See [observability-otlp-and-in-process-panel.md](./observability-otlp-and-in-process-panel.md).           |
| `experimental.disable_paste_summary` | remove   | Client presentation behavior.                                                                                                                                                                 |
| `experimental.batch_tool`            | remove   | No longer a supported feature.                                                                                                                                                                |
| `experimental.primary_tools`         | remove   | Agent tool access is configured through permissions.                                                                                                                                          |
| `experimental.continue_loop_on_deny` | remove   | Legacy denied-tool loop behavior.                                                                                                                                                             |

A field that is implemented, tested, and documented is not experimental. The promotions above are the
main body of work in this group; the removals are the easy part.

## Review Order

1. File Metadata
2. Providers And Model Selection
3. Agents And Permissions
4. Experimental (the promotions, which unblock the two groups above)
5. Commands And Project Resources
6. Plugins
7. Filesystem And Tool Runtime
8. Sharing And Identity
9. Integrations
10. Conversation Lifecycle
11. Process, Server, And Client Settings

Experimental is placed fourth rather than last because promoting `policies` and `hook` changes the
top-level shape that groups 2 and 3 are being reviewed against.

## Open Questions

- Does nikcli accept `nikcli.jsonc`? Upstream v2 does. Adding it is a `findUp` change plus a
  JSONC parser at one call site.
- Every plural rename above is a breaking change to a published JSON Schema. Does the loader accept
  both keys for one release, or does a migration rewrite `nikcli.json` in place the way
  `migrateTuiConfig` already does for TUI settings?
- `tui.json` already exists and `migrateTuiConfig` already populates it. What is the deprecation
  window after which `theme`, `keybinds`, and `tui` can be deleted from `Config.Info` outright —
  and does `ads` / `notifications` / `experimental.tui` ride the same migration or a second one?

## The Two Precedents Do Not Disagree — 2026-09-21

[todo.md](./todo.md) presents the migration mechanism as an open choice between two precedents that
conflict, and asks that one be picked "before the first rename lands, not after the third". Counted
against the source, they are not in conflict. They answer different questions, and the ledger's
renames only ever ask one of them.

| Mechanism                      | Times used | What it is for                              |
| ------------------------------ | ---------- | ------------------------------------------- |
| Accept both keys in the loader | **6**      | a rename **within** the same document       |
| Rewrite the file               | **1**      | moving fields into a **different** document |

The six: `autoshare` → `share`, `mode` → `agent`, top-level `tools` → `permission`, agent-level
`tools` → `permission`, agent-level `maxSteps` → `steps`, and `enabled_providers` /
`disabled_providers` → policy statements. The one: `migrateTuiConfig`, which moves `theme`,
`keybinds` and `tui` into a sibling `tui.json` — a _different_ published schema, which is precisely
what loader mapping cannot do.

Every rename this ledger proposes (`plugin` → `plugins`, `agent` → `agents`, `permission` →
`permissions`, `provider` → `providers`, `snapshot` → `snapshots`, `attachment` → `attachments`)
stays inside `nikcli.json`. So the file rewrite is not a candidate for them, and the choice the todo
describes is not one.

This is an argument, not a ratification: the decision belongs to whoever owns the published schema at
`https://nikcli-ai.dev/config.json`, and nothing here has been renamed.

### Execute the three statuses separately — they are not one job

The ledger's 68 fields split into three groups with incomparable risk, and running them as one pass
is how a breaking change reaches users behind a cleanup.

- **17 `remove` is two jobs, not one.** The fields with _no reader at all_ — `logLevel`, `server`,
  `teleport`, verified 2026-09-21 as having zero readers in `src` and `packages/tui` — can leave the
  published schema without changing any behaviour, because nothing observes them. The fields that are
  _read but superseded_ — `theme`, `keybinds`, `tui`, already migrated into `tui.json` — must keep
  parsing so old documents still load; those get hidden from the published schema, not deleted from
  `Config.Info`.
- **16 `redesign` is the part with the public contract.** One PR per group, with the mapping in the
  loader and a case added to `test/config/legacy-keys.test.ts` in the same change.
- **5 `pending` are decisions**, not work. They cost a line each and block nothing until answered.

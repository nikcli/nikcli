# nikcli Agent Guidelines

This file contains guidelines for AI agents operating in the nikcli repository.

## Build/Test Commands

### Package Manager

- **Install dependencies**: `bun install`
- **Lockfile update**: `bun update`
- **Clean**: `bun run clean`

### Development

- **Run nikcli**: `bun run dev` (runs in browser mode)
- **Build**: `bun run build`
- **Watch mode**: Use `--watch` flag with appropriate commands

### Type Checking & Linting

- **Typecheck**: `bun run typecheck` (uses the native TypeScript 7 compiler, `tsc` from `@typescript/native`)
- **Lint**: `bun run lint` (runs tests with coverage)

### Testing

- **Unit (PR-blocker)**: `bun run test` — ignores `*benchmark*` and `*integration*` suites
- **Integration**: `bun run test:integration`
- **Benchmarks**: `bun run test:bench` (or set `NIKCLI_TEST_BENCH=1` to enable preload bookkeeping)
- **E2E / TUI**: `bun run test:e2e`
- **Single file**: `bun test test/tool/tool.test.ts`
- **Pattern**: `bun test --match "pattern"`
- Prefer `withIsolatedDatabase` (`test/helpers/sqlite.ts`) for SQLite-touching suites and `makeToolContext` + `withProjectDirectory` (`test/helpers/tool-context.ts`) for tool behavioural tests

### Client & OpenAPI Generation

- **Regenerate HTTP clients**: `bun run generate:httpapi-clients`
- **Regenerate the OpenAPI document**: `bun dev generate`
- **HttpApi route coverage**: `bun run check:routes` (inventoryFailures today). `--strict` is honored as of 2026-08-17 (H4 landed `AccountGroup` + `ConfigManagementGroup.profilesList`; the script reads `process.argv`). Today `--strict` is the same rules as default; future strict-only checks land in `script/check-route-coverage.ts`.

- **Build the publishable SDK**: `bun run --cwd ../sdk/js build` — regenerates
  the client from the contract, then emits `dist`. hey-api is gone; there is no
  OpenAPI round-trip in the client path.

Consumers import `@nikcli-ai/sdk/httpapi`, which exposes the generated Promise
client (`NikCli.make`) plus `createNikcliClient`, a namespaced view of it
declared exhaustively in `src/server/httpapi/client-compat.ts` and emitted to
`packages/sdk/js/src/httpapi/generated/compat.ts`. Generation rejects missing,
unknown, duplicate, colliding, or adapter-incompatible entries, so adding an
endpoint requires an explicit stable caller path. `src/httpapi/compat.ts` keeps
only the request-selection and `{ data, error }` adapters. Calls resolve rather
than rejecting (pass `throwOnError` to opt out), and accept `directory` /
`workspace` for instance selection.

## Server architecture

The nikcli HTTP server is Effect HttpApi + raw Request/Response handlers on Bun.serve. There is no Hono app, no `Server.App()`, and no `NIKCLI_EXPERIMENTAL_HTTPAPI` fallback. In-process clients use `Server.fetch(request)`. OpenAPI and the generated clients both come from `PublicApi`.

Request path: `Server.fetch` / `Server.listen` → `ServerRouter` (body limit, CORS, auth, instance selection) → Effect HttpApi groups + raw handlers.

`src/server/httpapi/public.ts` exports two APIs:

- `PublicHttpApi.Api` — the **served** subset: every group has handlers.
- `PublicApi` — the **generation contract**: served groups plus contract-only
  groups whose routes are served by raw implementations (share, users, sync
  stats, SSE feeds, websocket upgrades). This is what codegen compiles.

## HTTP integration workflow

Adding or changing an endpoint:

1. **Contract** — edit the group in `src/server/httpapi/<group>.ts`:
   `HttpApiGroup.make(...)` + `HttpApiEndpoint.<method>(name, path, { params, query, payload, success, error })`.
   Pin the operationId with `.annotate(OpenApi.Identifier, "...")` when the
   client method name must stay stable.
2. **Compose** — add the group in `src/server/httpapi/public.ts`: to
   `PublicHttpApi.Api` if you are writing Effect handlers, to `PublicApi` only
   if a raw implementation serves it.
3. **Handler** — `HttpApiBuilder.group(Api, "<group>", (b) => b.handle(...))`
   for encoded JSON, or `.handleRaw(...)` when you need the raw
   Request/Response (streaming, websocket upgrade, redirects).
4. **Raw routes** — if the route is served outside the HttpApi handlers, list
   it in `src/server/httpapi/inventory.ts` so coverage stays accounted for.
5. **Regenerate** — `bun run generate:httpapi-clients`. It compiles `PublicApi`
   directly (no OpenAPI round-trip) and writes three targets:
   - `packages/sdk/js/src/httpapi/generated` (Promise client and namespaced compatibility view)
   - `src/server/httpapi/client/generated` (Effect client)
   - `src/server/httpapi/client/api` (Effect shape)
     Add every new Promise endpoint to `PublicClientCompat`; generation fails
     exhaustively when an endpoint is missing. Commit the generated output with
     the change.
6. **Verify** — `bun run check:routes`, `bun run typecheck`, and
   `bun test test/server/`.

### Schema rules for the contract

- **Never leave `Schema.Unknown` on an endpoint's `success` or on a domain
  object.** The codegen emits it as `any`, which silently removes type safety
  from every client. Measure with:
  ```sh
  grep -cE '^export type [A-Za-z0-9_]+ = (any|Array<any>)$' ../sdk/js/src/httpapi/generated/types.ts
  ```
  Only genuinely open payloads may stay `Unknown` (upstream passthrough,
  polymorphic event-sourced entries, SSE frames, bodyless redirects). Each
  one is justified in `specs/README.md` §Open payloads. Effect/TUI architecture
  work follows `specs/ROADMAP.md`; do not skip EOT-01 evidence or later
  dependency gates.
- **Reuse, do not redefine.** Reference the Effect Schema the service already
  owns (`Session.InfoSchema`, `Project.InfoSchema`, `Pty.InfoSchema`,
  `Workspace.InfoSchema`, `ManagedWorktree.InfoSchema`, `MessageV2.PartSchema`
  / `WithPartsSchema`, `Snapshot.FileDiffSchema`, `Monitor.RecordSchema`,
  `SessionGoal.StateEffect`, `Provider.ModelSchema`). Export the const if it is
  private rather than writing a second definition.
- **`Config` is derived, not hand-written.** The `nikcli.json` document comes
  from the zod in `config/config.ts` via `util/zod-effect.ts` (`fromZod`) — the
  one place schemas flow zod → Effect. Add a field to the zod and the contract,
  clients and OpenAPI follow. A `.transform()` that changes the output type must
  be pinned next to its definition with `overrideZod`.
- **Shared domain schemas go in `src/server/httpapi/domain.ts`** when more than
  one group describes the same object and the service defines it only in zod
  (loops, routines). That module imports nothing but `effect`, so contract
  modules can describe a loop without pulling `loop/engine` into their graph.
- **Effect handlers validate responses at runtime** — unlike the old Hono
  routes, which serialised whatever they were given. A schema that does not
  match what the service actually returns turns into a failed request, not a
  dropped field. Verify a new schema against real data, not just typecheck.
  Pick the optional flavour from what the **producer** actually writes:
  `Schema.optionalKey` rejects a present `undefined` and fails the whole
  request with an empty 400, while `Schema.optional` accepts it and puts
  `null` on the wire. So a service that assigns `field: cond ? x : undefined`
  needs either `Schema.optional`, or a producer that omits the key. Handlers
  that still push bodies through `jsonSafe` get absent keys for free — that
  helper is load-bearing, not decoration
  (see `specs/effect-tui/10-contracts-errors-security.md`). Two shipped 400s
  came from exactly this: `mission.ts` `featureMutate` and `config/tui.ts`
  `plugin_meta`.
- `handleRaw` endpoints and contract-only groups are **not** encoded at
  runtime, so their schemas shape the SDK without any request-time risk.

## Security & quality gates

### Logging redaction

- All `Log` serialisation goes through `safeStringify` / `redactUrl` (`src/util/redact.ts`).
- Default on; set `NIKCLI_LOG_REDACT=0` to disable for local debugging.
- Do not bypass `safeStringify` in logging paths.

### Plugin / custom-tool autoload

- Config-dir `{tool,tools}/*.{js,ts}` is **not** imported by default.
- Opt in with `NIKCLI_ALLOW_PLUGIN_AUTOLOAD=1`, or pin via nikcli.json:
  `{ "tool": { "allow": ["my-tool.ts"], "pin": { "my-tool.ts": "<sha256>" } } }`.
- `Plugin.Service` hook tools still load as before.

### Plugin hot reload and the `plugin` tool

- Config dirs load `{plugin,plugins}/*.{ts,js}` and folder plugins
  `{plugin,plugins}/<name>/` (entry: package.json `main`, else `index.ts`/`index.js`;
  `tui/` is reserved for TUI plugins). A folder plugin is named after its folder.
- `InstanceReload` reconciles external plugins per plugin (`Plugin.Service.reload()`):
  changed → `dispose()` then load, removed → `dispose()`, unchanged → untouched.
  Internal plugins never reload. Local plugins import through a fresh specifier and
  their folder's modules are evicted, because Bun caches failed resolutions outside
  `require.cache`.
- The `plugin` tool (`src/tool/plugin.ts`) writes, reloads and reports plugins. Its
  permission `plugin` asks by default and is denied to `plan`.

### Permission coupling

- Explicit map: `PermissionRuleset.TOOL_PERMISSION` (e.g. `monitor` → `bash`, edit-family → `edit`).
- A deny on `bash` covers `monitor`; a deny on `monitor` alone does **not**.

### Stack traces

- User-facing formatters suppress stacks unless `NIKCLI_DEBUG=1` (`formatStack` in `src/cli/error.ts`).

## Code Style Guidelines

### Runtime & Modules

- **Runtime**: Bun with TypeScript ESM modules (`.ts` extension, `"type": "module"` in package.json)
- **File naming**: camelCase for files (e.g., `tool.ts`, `memorySearch.ts`)
- **Module paths**: Use `@/` alias for project-relative imports (e.g., `@/util/fn`)

### Imports

- Use named imports for clarity: `import { Log } from "./util/log"`
- Use `import z from "zod"` (not `import { z }`)
- Use type-only imports where appropriate: `import type { Foo } from "./types"`
- Import Zod schemas as default: `import z from "zod"`

### Naming Conventions

- **Variables/functions**: camelCase
- **Classes/types/interfaces**: PascalCase
- **Namespaces**: PascalCase (e.g., `Tool.define()`, `Session.create()`)
- **Agent names**: kebab-case (e.g., `fast-explore`, `code-reviewer`)

### Type System

- **Validation**: Use Zod schemas for all input validation
- **Type inference**: Use `z.infer<typeof Schema>` for type extraction
- **Metadata types**: Use `Record<string, unknown>` for flexible metadata
- **Avoid `any`**: Prefer specific types or `z.unknown()`

### Zod Schema Patterns

```typescript
// Basic schema definition
const MySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
})

// With metadata
export const Info = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .meta({
    ref: "MyInfo",
  })

// Export types
export type Info = z.infer<typeof Info>
export type Output = z.output<typeof Info>
```

### Error Handling

- Use Result patterns for tool results (return error info in output)
- Avoid throwing exceptions in tool `execute()` methods
- For fatal errors, use `NamedError` from `@nikcli-ai/util/error`
- Session-domain misses throw `SessionError.NotFoundError` (HTTP wire stays `"NotFoundError"`).

```typescript
// In tools, handle errors gracefully
export const MyTool = Tool.define("my-tool", async (args, ctx) => {
  try {
    const result = await riskyOperation()
    return { title: "Success", metadata: {}, output: result }
  } catch (error) {
    return { title: "Error", metadata: {}, output: `Failed: ${error}` }
  }
})
```

### Logging

- Use `Log.create({ service: "name" })` for namespaced loggers
- Log levels: `debug()`, `info()`, `warn()`, `error()`
- Timing: Use `logger.time("operation")` for performance tracking

```typescript
const log = Log.create({ service: "my-service" })

// With timing
using _ = log.time("expensive operation")
// Automatically logs duration when scope exits

// With extra data
log.info("operation completed", { count: 42, status: "ok" })
```

### Storage Patterns

Durable domain state lives in `nikcli.db` behind domain repos (`SessionRepo`, `ProjectRepo`, `LoopRepo`, `MissionRepo`, `MonitorRepo`, `ShareRepo`, `ArtifactRepo`, `GoalRepo`, `BackgroundRunRepo`, `RoutineRepo`, `SessionDiffRepo`, …). Functions are synchronous over `Database.syncDb()`; `data` holds the whole record. Do not add JSON file stores for a domain that already has a repo. Leftover `storage/*.json` trees stay on disk for downgrade only; runtime does not read them. Bounded persistence and job ownership continue in `specs/effect-tui/09-jobs-persistence.md`.

```typescript
SessionRepo.upsert(session)
const data = SessionRepo.get(sessionID)
SessionRepo.update(sessionID, (draft) => {
  draft.time.updated = Date.now()
})
```

### Tool Definition Pattern

```typescript
import z from "zod"
import { Tool } from "@/tool/tool"

export const MyTool = Tool.define("my-tool", async (args, ctx) => {
  // ctx contains: sessionID, messageID, agent, abort, ask, etc.
  return {
    title: "Result Title",
    metadata: {
      /* metadata */
    },
    output: "output text",
  }
})

// With parameter schema
export const ParamTool = Tool.define("param-tool", {
  description: "Does something useful",
  parameters: z.object({
    input: z.string(),
    count: z.number().optional().default(1),
  }),
  execute: async (args, ctx) => {
    return {
      title: "Done",
      metadata: {},
      output: `${args.input} x${args.count}`,
    }
  },
})
```

### Session & Message Patterns

- Use `Identifier.schema("type")` for ID validation (session, message, part)
- Session IDs use descending IDs for natural ordering
- Message parts use ascending IDs for chronological ordering

```typescript
import { Identifier } from "@/id/id"

// Generate new IDs
const sessionID = Identifier.descending("session")
const messageID = Identifier.ascending("message")

// Validate with schema
const validated = Identifier.schema("session").parse(inputSessionID)
```

### Agent Configuration

- Agents defined in `Agent` namespace with default tool permissions
- Primary agents: `ralph`, `build`, `plan`
- Subagents: `explore`, `fast-explore`, `planner`, `code-reviewer`, `debugger`, `test-runner`, `refactor`, `delegator`
- Use `Task` tool with `background: true` for parallel subagent work

### Function Wrappers (fn pattern)

- Use `fn()` wrapper for validated async functions
- Provides `.parse()` and `.force()` methods on the function

```typescript
export const getSession = fn(Identifier.schema("session"), async (sessionID) => {
  const session = SessionRepo.get(sessionID)
  if (!session) throw new SessionError.NotFoundError({ message: `Session not found: ${sessionID}` })
  return session
})

// Usage
const session = await getSession(sessionID) // auto-validated
getSession.force(unvalidatedInput) // skip validation
```

## Architecture

- **Tools**: Implement `Tool.Info` interface with `execute()` method
- **Context**: Pass `sessionID` in tool context, use `App.provide()` for DI
- **Validation**: All inputs validated with Zod schemas
- **Logging**: Use `Log.create({ service: "name" })` pattern
- **Storage**: Durable state goes through SQL domain repos. The JSON `Storage` module is gone; leftover JSON trees on disk are downgrade-only.
- **API Client**: The TypeScript TUI (built with SolidJS + OpenTUI) communicates with the Nikcli server using `@nikcli-ai/sdk`. When adding or modifying an endpoint, edit its contract in `src/server/httpapi/` and run `bun run generate:httpapi-clients` — see "HTTP integration workflow" above. Endpoints do not live in `src/server/server.ts`; that file only owns the listener and the request pipeline.

## Parallel Execution

- **ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE**: Use `task(background: true)` and `delegation` for parallel work
- Launch multiple agents for independent tasks
- Use `delegator` tool to monitor background tasks

## Important Notes

- **Default branch**: `live-main`
- **Test files**: Located in `test/` directory, use `.test.ts` suffix
- **Tool files**: Use kebab-case naming (e.g., `memory-search.ts`)
- **Avoid mocks/placeholders**: All code should be production-ready
- **Modify existing files**: Only create new files when absolutely necessary

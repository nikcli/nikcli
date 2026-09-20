# TUI Package Extraction

| Field  | Value                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------ |
| Status | **Complete** 2026-08-14/16. `packages/tui` stands alone and has a second consumer that proves it |
| Scope  | `packages/nikcli/src/cli/cmd/tui` → `packages/tui` (**done**)                                    |
| Buys   | A TUI that builds, tests, and starts without the backend graph                                   |

## Goal

Move the terminal application from `packages/nikcli/src/cli/cmd/tui` into a self-contained workspace package while the CLI keeps using the same implementation.

```text
packages/tui
name: @nikcli-ai/tui
```

Target dependency graph:

```text
packages/nikcli ----\
                     > @nikcli-ai/tui -> @nikcli-ai/sdk
packages/desktop ---/
```

The TUI may depend directly on terminal and UI infrastructure — `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, `solid-js`, Effect, `@nikcli-ai/tui-math`, `@nikcli-ai/tui-image` — and on generic presentation libraries. It must not depend on `packages/nikcli` internals.

The SDK is the TUI's backend boundary. Missing data or operations get added to the HttpApi and the generated client, not imported from a server module.

## Current State

Measured 2026-08-15, after sections 1–3 (superseded by sections 4–6 on 2026-08-16; the tree now lives in `packages/tui`):

| Fact                        | Value                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Files                       | 256 `.ts`/`.tsx`                                                                                       |
| Lines                       | ~68,000                                                                                                |
| Largest subtrees            | `component/` 75, `feature-plugins/` 47, `routes/` 40, `util/` 33, `context/` 26                        |
| Files already using the SDK | 73                                                                                                     |
| `@/` import statements      | **17 static, 0 dynamic** (was 240 static) — 12 in host files, 4 in `photon`, 1 deliberate in `app.tsx` |
| Path alias                  | `@tui/*` → `./src/cli/cmd/tui/*` (already package-shaped)                                              |

The `@tui/*` alias is the good news: internal imports are already written as if the directory were a package root, so most files move without an edit.

### What Actually Blocks The Move

There are **17 static `@/` import statements** left and no dynamic ones, and **none of them is movable work**: twelve are in host files (`thread.ts`, `worker.ts`, `plugin/host-local.ts`), four are the `photon` exception, and one is `app.tsx`'s deliberate local config read.

Section 3 is therefore complete: **the terminal no longer calls a backend service in-process anywhere.**

| Remaining import                                               | Count | Why it stays                                                                                                           |
| -------------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------- |
| `@/{cli,project,server,mobile,installation,bus,config,effect}` |    12 | `thread.ts`, `worker.ts` and `plugin/host-local.ts` — host files that stay in `packages/nikcli` (see the boundary).    |
| `@/image/photon`                                               |     4 | **Deliberate.** It primes the WASM path before the decoder's first `import()`; only a compiled binary can validate it. |
| `@/config/tui` in `app.tsx`                                    |     1 | **Deliberate.** The one config read that happens before any transport exists — see `GET /tui/config` below.            |

**There are no `await import("@/…")` left.** There were four, and they mattered: lazy-loading a subsystem keeps it out of the startup graph, which is why they were written that way, but it decouples nothing and hides the dependency from exactly the measurement this document runs on. Keep counting both forms.

**`@/image/photon` stays where it is on purpose.** It primes `globalThis.__NIKCLI_PHOTON_WASM_PATH` before the decoder's first `import()`, and its own comment records the failure mode when that resolution is wrong: _"a compiled binary loses the WASM decoder entirely."_ Moving a bundler-sensitive asset path for four imports, when no test exercises image decoding from the installer binary, trades a verified state for an unverifiable one.

### The first service over the wire: `GET /tui/config`

Landed 2026-08-14, as the worked example of the pattern the rest of the list follows. Three things it taught, none of which were visible from the source:

**The renderer's config read cannot go over the wire.** `tui()` reads the config to build `rendererConfig`, so it happens _before the renderer exists_ — and at that instant no transport does either. The HTTP server has not been asked to listen, and the worker has not installed its RPC `onmessage`. Over HTTP the call fails with `ClientError: Transport`; over worker RPC it is worse, because `Rpc.call` posts a message and waits on a promise with no timeout, so the first frame never arrives. That one read stays local, deliberately, with a comment saying why. Everything after the first frame uses `sdk.client.tui.config()`.

**The response encoder validates, and `undefined` is not JSON.** Merging the config search path leaves explicitly-`undefined` keys behind. Encoding one fails with `SchemaError: Expected JSON value, got undefined`, which surfaces as **400 with an empty body** — from the terminal, indistinguishable from an empty config, and nothing is logged unless you run the server with `--print-logs`. The handler round-trips through JSON, the way `loop.ts` already does. Regression test: `test/server/httpapi-tui-config.test.ts`, verified to fail when the round-trip is removed.

**`zod-effect` could not describe the document.** `fromZod` threw `unsupported zod node "tuple"` on `PluginSpec` — a plugin entry is either a bare specifier or a `[specifier, options]` pair — so the route could not be declared at all until the walker learned tuples. That gap was reachable from `nikcli.json` too, not just here.

### Services that already had endpoints

Two more moved the same day, and neither needed a new route — only a call site.

**Connectors.** `feature-plugins/connectors` ran `Connectors.status()`, `ConnectorAuth.remove()` and the three `invalidate*` calls in-process, lazily importing `@/connectors` because it drags the `ai` package chain. `GET /connectors/`, `DELETE /connectors/:name/auth` and `POST /connectors/invalidate` already covered all of it, including the "invalidate everything" case (the handler branches on whether `name` is present). Four imports gone, the lazy-import concern with them, and `Connectors.Status` came from the contract as `ConnectorStatus`.

**Mobile pairing** — and a contract drift worth generalising. The dialog polls `MobileAuth.list()` to see whether a phone has connected, which it decides from `lastUsedAt`. `sdk.client.mobile.auth.token.list()` returned a type without that field: the Effect schema in `httpapi/mobile.ts` was **hand-copied** from the zod `MobileAuth.PublicToken` and had fallen behind it. Deriving it with `fromZod` — the same treatment `config.ts` documents — restored `lastUsedAt` and removes the whole class of drift. Any hand-written Effect struct sitting next to a zod source is a candidate for the same fix.

**Brain.** The session footer recomputed the brain's state from three in-process reads — `getBrainConfig()`, `readLastBrainAt()`, `getSessionsCountSince()` — on a 60-second timer, and `GET /brain` already returns exactly that triple plus `shouldTrigger` and the model. The settings dialog wanted the same config, and `/brain/trigger` covered the plugin's "Run Brain" command. Four dynamic imports gone; only `initBrainScheduler()` stays, because starting a scheduler is a host operation, not a read.

Verifying these means curling the routes against a real server; `bun run src/index.ts serve --port …` is enough and much faster than building a binary. Watch for stray writes while you do it: creating a mobile token during a probe writes to the user's real token store, so revoke it afterwards.

### `/user`, and the credential that stays local

The read half landed 2026-08-15. `GET /user/me` and `/user/status` already existed; `GET /user/me/stats` is new and returns the profile view's two counters. It derives the account from the bearer, never from a path parameter — in process the dialog passed whichever id it held, and that is not a check a route may skip. Regression test: `test/server/httpapi-user-stats.test.ts`, which gives one user's token and counts another user's contact.

**The session token deliberately does not move behind an endpoint.** It is what the terminal presents to authenticate, so a server cannot answer "which session does this machine hold" without already having it — and it must be readable before any transport exists. It was a four-function file store inside `UserDB` touching none of its tables, so reaching it cost the terminal drizzle and the whole user schema for one line of text; it is now `@nikcli-ai/util/user-session`, with `UserDB` re-exporting the four names so no backend caller changed. This is the same call as `@/image/photon`: local because of what it is, not because moving it was hard.

Two consequences worth keeping:

**An authoritative check became a late one.** `verifySession` answered during render; `GET /user/me` answers a frame later. Rendering the signed-out branch meanwhile would offer "Sign in" to someone already signed in, so the account menu holds on `Checking account…` — over worker RPC that is one frame. The profile counters show `—` rather than `0` until they arrive, because `0` reads as "no contacts".

**`null` is not `false`.** `UserApi.hasUsers` answers `null` when the question could not be asked. `app.tsx` treats only an explicit `false` as first run — reading an unreachable server as "no users" would restart onboarding for someone who already has an account.

Since `/user/*` sits outside the OpenAPI surface there is no generated type, so `PublicUser` is declared once in `@nikcli-ai/util/user-schema` and `UserDB.User` is now that shape plus `password_hash` — the alternative was a hand-copy that drifts, which is the `MobileAuth.PublicToken` failure again.

The write half landed the same day, and needed exactly one new route. Registration, password login and logout already existed: `POST /user/register` and `POST /user/login` both answer `{token, user}`, which is the whole of `dialog-login.tsx`. Only the self-service password change had no home — `PATCH /user/:id` can set a password but never asks for the current one, because an admin resetting another account has none to give. `POST /user/me/password` verifies the old one where the hash lives, instead of the terminal reading the user row and deciding for itself. Regression test: `test/server/httpapi-user-password.test.ts`, including that a wrong current password leaves the old one working.

`dialog-login.tsx` and `dialog-auth-manage.tsx` no longer import `@/user/users` at all. Three things fell out of routing them:

- **The dialogs can no longer say _which_ credential was wrong.** `/user/login` answers the same `Invalid credentials` for an unknown email and a bad password, so the two retry prompts collapsed into one. That is the route declining to confirm whether an address has an account here.
- **Registration now obeys policy it used to bypass.** `UserDB.create` ran whatever the dialog asked; the route refuses when OAuth is required, and once any account exists only an admin may add another.
- **`useSDK()` is unreadable from `DialogLogin.run`.** It runs from an async continuation, where Solid's owner is gone and `useContext` returns undefined — so the transport is a parameter, passed by the caller that still holds the context. Any dialog entry point reached through `await` has the same constraint.

### `/account`, and the four places that decide what is instance-less

Landed 2026-08-15. Three raw handlers — `GET /account`, `POST /account/login`, `POST /account/login/complete` — retire `@/account` from the terminal. Raw again for the `/user/*` reason, and more so: the flow has eight tagged error cases that a dialog renders as one string.

**Adding an instance-less path meant editing four files, not one.** The bridge, `Server.fallback`, the router's `global` test and `PublicRoutes.globalRequest` each spelled out `/user/`, and they had to agree. `/account` adds a trap the `/user/` prefix never had: the bare path is itself a route, so `startsWith("/account/")` sends `GET /account` down the instance branch, where it 404s with no directory bound — and a 404 there reads as "no account", which is a legitimate answer. Hence one `isAccountPath` predicate the four import, and `test/server/httpapi-account.test.ts` asserting the bare path reaches the handler.

Closed 2026-08-16 (roadmap H2): the roots are a table in `httpapi/instance-less.ts` and the four sites ask it. The part worth carrying forward is that the compiler now checks the agreement — each raw dispatcher declares its handlers as a full `Record` keyed by the root union, so a new root does not typecheck until every dispatcher says what answers it. A predicate the four _may_ call is still four places that can forget; a `Record` they _must_ fill is not.

**The poll became one blocking request.** `complete` waits for the browser approval server-side and hands back the issuer session. Its `onPending` callback had no wire form and needed none: it only rewrote a status line that says the same thing for every unfinished poll, so the dialog sets it once before waiting. Escape aborts the request through the caller's own `AbortSignal` — which is why `send` takes one instead of always imposing its 30s timeout.

**It deliberately does not mint a local session.** The access token _is_ the bearer, and `server/identity-auth.ts` provisions the local user from it on the first authenticated request; issuing an `nku_` session here as well would create a second identity for the same person. The terminal stores the token and asks `GET /user/me` — which is also why `ensureExternalUser` never needed a route.

**`GET /account` answers `null`, not 401, without a bearer.** "Who is signed in" and "nobody is" are the same answer to a dialog, and the terminal asks on mount, before any sign-in. The bearer check exists at all because the route carries an email address and the server can be listening on a port — in process there was nothing to ask.

### TTS: a hook, not a second implementation

`@/tool/speak/openrouter` was on this list as "needs an audio-models endpoint". It did not. `getAudioModels()` returns three hardcoded strings and the voice catalog is a constant — the terminal only ever asks for those two, and never synthesizes; the `speak` tool runs server-side in the worker, with its own module instance of `ttsRegistry`.

What actually tied the module to the backend was one method: `getConfig()` reading `Auth.get("openrouter")` and the provider options out of `nikcli.json`. So the provider moved whole to `@nikcli-ai/util/tts/openrouter` with the credential lookup behind a `resolveCredentials()` hook that reads env, and `src/tool/speak/openrouter.ts` is now a subclass that overrides it — precedence unchanged (env, `auth.json`, `provider.openrouter.options`), 276 lines down to 70. One provider id, one catalog, one request path.

The general form, and it is worth applying before writing any endpoint: **when a module is backend-bound by one method, extract the method, not the module.** An endpoint would have shipped a second copy of the catalog and a network round trip for a constant.

### The chat-bot manager, and a group that is not raw

The `/chatbot/*` webhook receivers stay raw — platform SDKs verify signatures against the untouched `Request` — but the three management routes are declared (`GET /chatbot/bots`, `POST /chatbot/bots/:name/{start,stop}`). The caller decides: a TUI **feature plugin** reaches the server through `api.client.<group>`, the generated client, and a raw handler is unreachable from there. That is the rule for anything a plugin must call.

Three things this cost that the next declared group will not:

- **A shared prefix means the raw branch must fall through.** Both dispatch sites answered `404` for anything under `/chatbot/` that `ChatbotHttp.handle` did not match, which would have shadowed the declared routes entirely. They now fall through, and unmatched paths 404 from the router instead — same answer, one layer later.
- **A path parameter has to be declared.** `HttpApiEndpoint.post("start", "/bots/:name/start", …)` without a `params` schema fails codegen, not typecheck: `GenerationError: Missing path parameter: name`.
- **`compat.ts` is hand-maintained.** Codegen produced the raw and Effect clients happily; `api.client.chatbot` did not exist until the group was added to the namespaced view by hand.

**And one that cost an hour.** `public.ts` imports the group module to declare it, so a top-level `import { ChatBot }` there loads the Chat SDK into every process that merely serves HTTP — and it registers state on import. The symptom was **71 failures across `ToolRegistry`, the permission surfaces and the OpenAPI baseline**, none of them in a chatbot test, and every one of them passing when its file ran alone. The import is now lazy inside the handlers. Anything a declared group touches at module scope is paid by the whole server: keep the group file to schemas, and reach for the subsystem inside the handler.

The join of "configured" and "running" also moved server-side, because only the process that owns the bots knows which are up — the terminal was reading its synced config and calling `getAllBots()` in process, and only half of that was ever derivable from config.

### The herdr and island bridges were never backend

Both were filed under "host operations to invert". They are not operations at all: they are **terminal integrations** — herdr talks to a local multiplexer over a unix socket, island writes snapshot files macOS reads — and between them, 1,418 lines whose only backend import was `GlobalBus`, an `EventEmitter` with no imports of its own. So the bus moved to `@nikcli-ai/util/global-bus` (with `src/bus/global.ts` re-exporting for every backend caller) and both bridges followed it, joining `remote-tunnel` as things that live in the shared package because both sides run them.

The island bridge needed two answers it could not have there: the HTTP port and a session's parent/title. Neither could move — they belong to whoever owns the server and the session store — so `IslandBridge.configure({ port, identity })` takes them from `src/bus/index.ts`, right where `start()` is already called on publish. Both stay lazily imported, and both already had working fallbacks (`0`, empty strings), so a terminal that never configures the bridge degrades exactly as before instead of failing.

This is the same shape as the TTS split, and the second time it has paid: **a module is rarely backend-bound as a whole, only at one or two points.** Find the points, hand them in, and the module stops being backend code.

### Voice: move the call, not the key

The prompt composer resolved the OpenRouter API key from `auth.json` and `nikcli.json` and posted the recorded WAV to OpenRouter itself — about 200 lines, two endpoint shapes and a 402 special case, all of it needing `Auth` and the Effect runtime _in the terminal_.

The obvious translation is a route that hands the key to the client. That is not a translation: it turns a file only the local user can read into something any authenticated caller can fetch. **Recording is a device concern and stays in the terminal; the credential is not, so the call moved instead.** `POST /voice/transcribe` takes base64 audio and returns a transcript, and `src/voice/transcribe.ts` owns both endpoint shapes. The composer is 25 lines: read the file, send bytes, read a string.

The route reports failure in the body rather than as an HTTP error, because every failure is a sentence the composer shows verbatim — "credits required", "no transcript returned", "API key not configured" — and none of them changes what the client does next.

### Plugin lifecycle: three moves and one inversion

The last chunk was `plugin/runtime.ts` — five backend imports for a file whose whole job is loading plugins into the terminal. Splitting it needed both tools, and which one applied was decided by _what the dependency actually was_, not by where the file sat.

**Three moves.** `plugin/shared.ts`, `plugin/meta.ts` and `plugin/install.ts` are path work, manifest parsing and JSONC patching — 732 lines, and between them exactly two backend touch points: one line calling `BunProc.install`, and `ConfigPaths.fileInDirectory`, which is two `path.join`s. The installer is now a `configurePluginInstaller` hook that `src/plugin/shared.ts` sets on import (so every backend caller keeps both its path and its behaviour), the filename pair became `@nikcli-ai/util/config-file` with `ConfigPaths` delegating to it, and all three modules live in `@nikcli-ai/util`. `packages/util` gained `jsonc-parser` and `semver`.

**One inversion.** What was left is genuinely host work: enumerate the config files to watch, force a re-read when one changes, wait for a plugin's dependencies to install. Those are `TuiPluginHost`, supplied by `thread.ts` and `attach.ts` from `plugin/host-local.ts` — a **host file** that keeps `@/config/tui` and `@/effect`, and stays in `packages/nikcli` at section 4 alongside `thread.ts` and `worker.ts`.

**Each operation takes its directory.** That is what removed `@/effect`: the runtime used to wrap its own calls in `withInstanceAsync`, so the instance binding moved to the host, where the instance actually lives. Two wrappers disappeared with it — and the one around `load()` was also catching, so its `try`/`catch` had to be reinstated by hand. A removed wrapper is not only a removed argument.

The rule these three sections converged on: **an endpoint is for data the server owns; a hook is for a dependency the module has; an inversion is for an operation the host performs.** Reaching for the wrong one shows up as a second copy of a catalog, a client-side credential, or a terminal running `bun install`.

### The brain scheduler belongs to the host

`initBrainScheduler()` ran from the TUI plugin's activation, which meant the hourly consolidation only happened while a terminal was attached, and made the terminal responsible for starting a background job it does not own. It is now armed in `project/bootstrap.ts` next to `Routine.restoreSchedulers()` — the same place, for the same reason — and lazily imported there so a bootstrap that never reviews does not evaluate the provider chain.

### `/profile`, and where a preview belongs

The profile dialog ran five `Profile.Service` operations in-process. They are now `GET`/`PATCH`/`DELETE /profile` plus `GET`/`DELETE /profile/habits`, with two details worth keeping:

**An absent profile has to encode as `null`.** `profile.get()` returns `undefined` when the user has not set one up, and the encoder rejects that — the same "Expected JSON value, got undefined" trap as `/tui/config`, hit from a different direction. The handler maps it, and the test asserts the `null`.

**The prompt preview moved to the server, not to a shared module.** The dialog showed what agents receive by calling `Profile.render(info)` and `renderHabits()` locally. Extracting those looked right until the render turned out to read fifteen fields through a helper — a second renderer to keep in step with the first, for a preview whose whole point is fidelity. `GET /profile/preview` returns the rendered lines and the habits path from the code that actually builds the block. Regression test: `test/server/httpapi-profile.test.ts`.

Loop validation went the other way for the same reason: `isValidModel`, `validateStage` and `validateDefinition` produce the messages a user sees _while typing_, so a round trip is the wrong shape. They are `@nikcli-ai/util/loop-validation`, typed structurally, with `loop/schema.ts` re-exporting them. When copying a block like that, extract it from the file rather than retyping it — `formatDuration` has a two-branch shape that is easy to "remember" wrong, and every interval message depends on it.

### Three more that were never backend

`cli/error` (176 lines) already imported nothing but `@nikcli-ai/util/*` — pure error presentation, now `@nikcli-ai/util/cli-error`. The mobile pairing dialog wanted three helpers (`buildMobilePairingDeepLink`, `getLocalIPs`, `isLoopbackHostname`) and imported the whole `mobile` **command** to get them, dragging `Server` and `MobileAuth` in to build a URL; they are now `@nikcli-ai/util/mobile-pairing`.

The four `TuiEvent` definitions split the same way: names and payloads are `@nikcli-ai/util/tui-event-schema`, and `src/bus/tui-event.ts` is now just the `BusEvent.schema` wrapping. One definition, two projections — the terminal takes the names to subscribe and the zod form to parse a toast, and neither can drift from what the server publishes.

**A bug found by moving one of them.** `app.tsx` reported a failed self-update with `error instanceof Installation.UpgradeFailedError ? error.stderr : …`. That check could never be true: the upgrade runs in the worker, and `Rpc.deserializeError` rebuilds a plain `Error` from `{name, message, stack}` — the class does not cross a worker boundary, and `stderr` was not even serialized. Since `UpgradeFailedError.message` is empty by design, every failed update showed the generic "Update failed" with no reason. Worse, a source-reading test _required_ the broken form. `serializeError` now carries the error's own fields and the handler matches on `name`; `test/tui/rpc-error.test.ts` covers the round-trip, and the old test asserts the `instanceof` form is **absent**.

`cli/remote` — 1889 lines across seven files, with **zero** `@/` imports — moved to `@nikcli-ai/util/remote-tunnel`. Two traps there. A grep for `cli/remote` said the TUI dialog was the only consumer; `src/cli/cmd/remote.ts` and `src/cli/ui.ts` reach it as `../remote` and `./remote`, so the relative forms have to be part of the search or the conclusion inverts. And `packages/util`'s exports map is `"./*": "./src/*.ts"`, which resolves a _file_: a directory needs its own entry, hence the explicit `"./remote-tunnel"`. It is named for the tunnel rather than "remote" because `@nikcli-ai/remote` is a different package it depends on.

### Inverting the server start

`worker.ts` is the one that decides the transport, and section 3 must preserve what it does rather than replace it with a URL. In a normal run the TUI has **no listening HTTP server**: `thread.ts` sets `url = "http://nikcli.local"` — a synthetic hostname — and hands the SDK `createWorkerFetch(client)`, which marshals requests over worker RPC straight into `Server.fetch`. A host that "hands the TUI a base URL" without also handing it that transport produces a TUI where every request fails DNS silently: no error, no router log line, and nothing that fails at build time. This is not hypothetical — it is what disabled the analytics panel's history for weeks (see `test/tui/analytics-transport.test.ts`).

## Migration Rules

- Keep one canonical implementation of every TUI feature. Do not copy the tree and synchronize two of them.
- Land each section below independently and commit at its boundary. Every intermediate commit must build and typecheck (`bun run typecheck`).
- Use temporary compatibility re-exports only where they materially reduce conflict risk, and mark them for removal in a named later section.
- Do not preserve a private import by aliasing `packages/tui` back into `packages/nikcli`.
- Keep tool rendering tolerant of unknown tools and wire-format drift. Local checks over `unknown` metadata are fine; importing a backend tool implementation for type safety is not.
- Keep CLI argument parsing, server startup, worker management, auth, and config discovery **outside** `@nikcli-ai/tui`.

## Ownership Boundary

### `@nikcli-ai/tui` owns

- The OpenTUI renderer lifecycle and app entry (`app.tsx`)
- Solid application composition, routes, dialogs, components, contexts
- Themes, keymaps, i18n, and UI primitives
- Feature plugins (`feature-plugins/`, 47 files) and the TUI plugin host
- Rendering of tool calls, diffs, markdown, and math

### `packages/nikcli` keeps

- The `tui` command, server bootstrap, and instance binding — **including `thread.ts` and `worker.ts`**, which contain no UI. `worker.ts` is the backend half of the worker (it owns `Server`, `Instance`, `InstanceBootstrap`, `GlobalBus`, upgrades and event streams); `thread.ts` is the yargs `$0` command that spawns it and then calls `tui()`. Together they carry 12 of the TUI tree's remaining `@/` imports, and they are most of the reason the tree still looks coupled.

  **They keep their current path and filenames** (`src/cli/cmd/tui/{worker,thread}.ts`). That path is load-bearing: `script/build.ts`, `packages/nikcli/script/{build,cross-build-windows}.ts` and the `NIKCLI_WORKER_PATH` define all name `./src/cli/cmd/tui/worker.ts` literally, and the compiled binary emits the worker chunk at the matching bunfs path. Section 4 therefore **excludes these two files from the tree move** rather than relocating them beforehand — the exclusion is the cheap operation, the rename is not. Relocating them was tried on 2026-08-14 and reverted; it works (build and binary verified) but buys nothing that the exclusion does not.

- Everything under `src/session`, `src/server`, `src/provider`, `src/tool`
- Config discovery and the auth flows the TUI triggers over HTTP

## Sections

Each section is independently landable and independently revertible.

**1. Extract shared infrastructure.** Move `@/util/*`, `@/flag`, `@/id`, and `@/global` path resolution into a package both sides depend on (`packages/util` already exists — extend it rather than creating another).

Before moving anything, check who the consumers actually are. A module the TUI alone uses does not belong in a shared package; it belongs in the TUI, where relocating it costs nothing and needs no dependency decision.

Landed 2026-08-14. `packages/util` now depends on `effect` and `xdg-basedir`, which was the decision blocking most of this.

| Module                                                                            | Move                             | Why                                                                    |
| --------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `util/keybind`, `util/rpc`                                                        | → `@tui/util/*`                  | Zero consumers outside the TUI.                                        |
| `util/iife`                                                                       | deleted → `@nikcli-ai/util/iife` | Byte-identical duplicate of the packaged one.                          |
| `global`                                                                          | → `@nikcli-ai/util/global`       | 81 call sites; brought `xdg-basedir` with it.                          |
| `flag/flag`                                                                       | → `@nikcli-ai/util/flag`         | 49 call sites, pure leaf.                                              |
| `util/{locale,token,record,defer,format,redact,hash,teleport-archive,user-error}` | → `@nikcli-ai/util/*`            | Shared leaves.                                                         |
| `util/{filesystem,process,effect-zod,log,flock}`                                  | → `@nikcli-ai/util/*`            | Unblocked by the Effect dependency.                                    |
| `util/error`                                                                      | → `@nikcli-ai/util/error-format` | Renamed: the packaged `error.ts` is `NamedError`, a different concern. |

Two things are deliberately left where they are:

- **`id/id` (5).** `packages/util/src/id.ts` already exports a namespace called `Identifier`, and so does this one. They are two implementations of the same idea, not a collision of names — the nikcli one adds prefixes, zod and an Effect schema. Renaming the file would ship the duplicate rather than resolve it, so reconcile the two first.
- **`util/runtime` (1).** It imports `./lazy`, and `packages/util/src/lazy.ts` is a _different_ module from `src/util/lazy.ts`. Moving the file would silently rebind it.

Note for anyone repeating this kind of sweep: `src/permission/ruleset.ts` is not valid text to `grep`, which skips it in `-l` mode without saying so. Every repo-wide import rewrite must be verified by `bun run typecheck`, never by a clean `grep` alone.

**2. Close the tool-rendering seam.** Landed 2026-08-14 for the type surface: 44 `@/tool/*` imports → **10**.

The 34 type-only imports typed `input` and `metadata` in `tool-view.tsx` as `Tool.InferParameters<BashTool>`. They now come from `@tui/util/tool-shapes`, declared from what the renderers actually read — 26 distinct fields across 13 tools, every one optional. The view already cast a dozen sites to `any`, so the exact types were never the whole story; what they did buy was a hard dependency on the server's module graph for something the view sees only as wire data. A local `diagnosticMessage` replaced the sole use of `LSP.Diagnostic.message`, which also removed the `@/lsp` value import. A further 17 identical type imports in `routes/session/index.tsx` were dead — left behind when the renderers were split out — and were deleted outright.

Regression test: `test/tui/tool-seam.test.ts`.

The remaining 10 are value imports and need a decision, not a rewrite: `@/tool/opentui` (the viz decoder, 4) and `@/tool/speak/*` (TTS voice catalogs, 6) are TUI-facing code that sits under `src/tool/` because the tools that produce it are registered server-side. Splitting the codec and the catalogs out of the tool definitions is the move; where they land is the open question.

**3. Replace backend-proper imports with SDK calls.** In progress.

The inversion this section was written to perform **already exists**. `thread.ts` resolves the network options, spawns the worker, and calls `tui({ url, fetch, events, args, onExit, onRestart, checkUpgrade, upgradeNow, startServer, createMobileToken })` — the app entry receives its transport and its host operations as props and never reaches for the server itself. What remains is not a redesign but an ownership correction: `worker.ts` and `thread.ts` are host files living in the TUI directory (see the boundary above).

Landed 2026-08-14, all of them modules that only looked backend:

| Module                                        | Move                                   | Why                                                                                                           |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `lsp/language`                                | → `@nikcli-ai/util/language`           | A pure extension→language map; 4 of its 5 consumers were TUI.                                                 |
| `provider/parse`                              | → `@nikcli-ai/util/model`              | Four lines, no deps, two of three consumers were TUI.                                                         |
| `agent/prompt/support-docs`                   | → `@tui/util/support-docs`             | Zero consumers outside the TUI.                                                                               |
| `cli/cmd/tui/util/prompt-blob`                | → `@nikcli-ai/util/prompt-blob`        | Breaks a cycle — see below.                                                                                   |
| loop shapes                                   | → `@nikcli-ai/sdk/httpapi`             | `LoopDefinition`, `LoopRun`, `LoopTemplate` and `LoopPullRequestRef` are all in the generated contract.       |
| `Snapshot.FileDiff`, `MobileAuth.PublicToken` | → `@nikcli-ai/sdk/httpapi`             | Same: `FileDiff` and `MobileAuthTokenPublic` were already there.                                              |
| analytics merge helpers                       | → `@tui/util/analytics-merge`          | 184 lines of `Math.max` over wire shapes, `await import()`-ed from the panel; no server caller.               |
| `session/primitives`                          | → `@nikcli-ai/util/session-primitives` | Its own comment says it exists for the TUI; 31 pure lines.                                                    |
| `config/features`                             | → `@nikcli-ai/util/features`           | A predicate over `experimental`; every field is read with `=== true`, so naming `Config.Info` bought nothing. |
| `Installation.VERSION`                        | → `@nikcli-ai/util/version`            | Seven files pulled the whole upgrade subsystem to print a string in a footer. `Installation` re-exports it.   |
| viz catalog + codec                           | → `@nikcli-ai/util/viz` (+ `viz.txt`)  | The contract between the `opentui` tool and the terminal; the tool module went from 804 lines to 24.          |
| `tool/speak/{provider,elevenlabs}`            | → `@nikcli-ai/util/tts/*`              | Registry and voice catalog. `openrouter` stays: `getAudioModels` reads auth through `@/effect`.               |
| `interaction/spec`                            | → `@tui/util/interaction-spec`         | 274 lines whose only consumer was the TUI.                                                                    |
| `provider/fusion`, `brain/constants`          | → `@nikcli-ai/util/*`                  | Constant tables.                                                                                              |

A third pattern showed up late and is worth naming, because it applies to almost everything still on the list: **when the TUI reaches into a backend namespace for one small pure thing, extract that thing rather than the namespace.** `Skill.commandName` is a slug plus a six-character hash — reaching for it pulled in the skill loader and with it `@/session`, `@/bus` and the Effect runtime. `Config.pluginSpecifier`/`pluginOptions` are three-line accessors over a `string | [string, options]` tuple. Both now live in `@nikcli-ai/util` and the original namespaces re-export them, so no caller changed.

The other two patterns:

- **A shape the server declares and the wire carries belongs to the contract.** Before writing a local type or moving a module, check `packages/sdk/js/src/httpapi/generated/types.ts` — the loop and analytics shapes were already there under contract names (`AnalyticsGlobal`, `AnalyticsDaily`, `AnalyticsSession`). Substituting them typechecks, which is also the proof that the two definitions agree.
- **A helper only the TUI calls is TUI code, wherever it currently sits.** `keybind`, `rpc`, `support-docs` and the analytics merge functions all lived in the backend tree with zero backend callers.

### The cycles — closed 2026-08-14

`packages/nikcli` importing `packages/tui` is the allowed direction. `packages/tui` importing back is not, and five backend modules did exactly that. Each would have failed section 4 outright rather than merely looking untidy, and none was visible in the `@/` import count, which only looks one way.

| Backend module                                                 | Imported from the TUI                             | Fix                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt/stash-store`                                           | `util/prompt-blob` (runtime), `PromptInfo` (type) | Store moved to `@nikcli-ai/util/prompt-stash`; `parts` is `unknown[]` there — persistence never inspects a part — and the composer narrows on read. |
| `bus/all-events`, `server/httpapi/tui`, `mcp`, `session/toast` | `cli/cmd/tui/event`                               | `TuiEvent` is a bus contract, not UI. Moved to `src/bus/tui-event.ts`.                                                                              |
| `cli/cmd/upgrade`                                              | `cli/cmd/tui/win32`                               | Terminal/FFI handling with one `bun:ffi` import. Moved to `@nikcli-ai/util/win32`.                                                                  |
| `session/toast.tsx`                                            | `cli/cmd/tui/component/border`                    | **Deleted.** An orphaned 107-line copy of `cli/cmd/tui/ui/toast.tsx` with no importer at all.                                                       |

What is left pointing into the TUI is `cli-main.ts` registering `AttachCommand` and `TuiThreadCommand` — the host wiring up its own commands, which is the direction the target graph wants.

Sections 4–6 closed the leftovers that used to sit here (`@/effect` service calls, `@/config/*`, `@/plugin/*`). What remains under `src/cli/cmd/tui/` is host-only: `thread.ts`, `worker.ts`, `attach.ts`, `plugin/host-local.ts`. Ordered leftover work after this extraction is in [ROADMAP.md](./ROADMAP.md), not another TUI move.

> Since the CLI framework migration ([`specs/cli-framework.md`](./cli-framework.md)) that set is two files: `worker.ts` and `plugin/host-local.ts`. `thread.ts` is gone — the default command is now `src/cli/handlers/default.ts` — and `attach.ts` moved to `src/cli/handlers/attach.ts`. The boundary argument below is unchanged; only the file list is.

**4. Create the package and move the tree.** Landed 2026-08-16. `packages/tui` holds 264 files; `src/cli/cmd/tui/` keeps four host files — `thread.ts`, `worker.ts`, `attach.ts` and `plugin/host-local.ts` — so the literal `./src/cli/cmd/tui/worker.ts` in the three build scripts is still correct and the compiled binary still emits the worker chunk at the matching bunfs path. (Two of those four have since moved; `worker.ts` has not, so the build-script path and the bunfs claim still hold — see the note in section 3.)

It was not only a `git mv`. What the move actually cost, in the order it surfaced:

- **`exports` needs both extensions.** `"./*": "./src/*.ts"` cannot reach `context/sdk.tsx`. The fallback-array form works: `"./*": ["./src/*.ts", "./src/*.tsx"]`.
- **The last five `@/` imports had to go, not be aliased.** Aliasing `packages/tui` back at `packages/nikcli` is the one thing the migration rules forbid, so `app.tsx`'s deliberate local config read became a `tuiConfig` prop that `thread.ts` and `attach.ts` fill — which is _better_ placed than before, since the read has to happen before any transport exists and the host is who can do it — and `photon` moved to `@nikcli-ai/util/photon`, where the server's `image.ts` also uses it.
- **Ambient declarations do not travel through a package boundary.** `photon` imports a `.wasm` asset, so every program compiling it needs `wasm.d.ts` in its own include set: `packages/tui` and `packages/util` each got a copy.
- **Two non-source assets moved with it.** `parsers-config.ts` (tree-sitter highlight config, TUI-only) sat at the `packages/nikcli` root behind a six-level relative import.
- **The test paths were already prepared** — `TUI_SRC` was a one-line edit, exactly as intended — but four tests _outside_ `test/tui/` still spelled `packages/nikcli/src/cli/cmd/tui/app.tsx` and failed loudly with ENOENT, which is the good failure. One assertion had to change meaning: `cli-commands-benchmark-suite` checked every module specifier contained `/cli/`, which is no longer what a TUI module looks like.

**Verified:** `bun run typecheck` (34 packages, 0 errors), `packages/tui` typechecking with no path to `packages/nikcli`, `bun test` at its two-failure baseline, a real `--single` build, and `bun run smoke:tui` — the compiled binary booting the real TUI in a PTY and painting 6,641 characters. `--version` and `--help` prove nothing here; only the smoke does.

**Startup did not regress**, which this section had no way to check until now. `bun run bench:startup <binary>` spawns the real binary in a PTY and stops the clock at the first frame carrying printable text; all runs share one `NIKCLI_TEST_HOME` and the first is discarded, because a fresh home pays for migrations and config bootstrap — real costs, but not ones a packaging change moves.

| Binary                      | Warm, best of 3 |
| --------------------------- | --------------: |
| Released 1.285.0 (pre-move) |  6110 / 6099 ms |
| This build (post-move)      |  6181 / 6068 ms |

Two interleaved pairs, because one series each proves nothing about ordering. The spread within a series (6068–6248 ms) is larger than the difference between them. The baseline is the _installed release binary_ rather than a rebuild of the old tree — that is what makes the comparison possible without checking out over uncommitted work, and it is the honest label for it.

A fresh home costs 7.3–11.0 s to first paint, against 6.1 s warm. Migrations and config bootstrap are most of a first run, and no packaging change will move that number.

_Prepared 2026-08-15._ The tests no longer spell the tree's path. Twenty-four files did: seventeen imported modules through `../../src/cli/cmd/tui/…` (now `@tui/…`, which the alias repoints for free) and eight read the source as _text_, which is the case that matters. Those now take their root from `test/tui/tui-source.ts` — `SRC`, `TUI_SRC`, `source()`, `tuiSource()`, `stripComments()` — so the move edits one line.

The reason to centralise it is a failure mode, not tidiness. A missing file read throws, but `theme-tokens.test.ts`'s `Bun.Glob.scan` over a cwd that no longer exists yields **nothing**, so its asserted-absence check passed while reading zero files. `TUI_SRC` is existence-checked at import (verified: pointing it at a non-existent directory turns that test red), and the scan now asserts it walked more than 200 files.

One path stays hardcoded on purpose: `./src/cli/cmd/tui/worker.ts` in `script/build.ts`, `packages/nikcli/script/build.ts` and `cross-build-windows.ts`. It is correct precisely because section 4 excludes `worker.ts` from the move — the exclusion _is_ the mitigation. A stale cross-package `"@tui/*"` alias in `packages/sdk-next/tsconfig.json`, unused by any file there, was removed rather than repointed.

**5. Delete the compatibility re-exports.** Landed 2026-08-16. `src/bus/global.ts`, `src/plugin/shared.ts` and the four `UserDB.{get,save,clear}ActiveSession*` aliases are gone, along with the three older ones (`FUSION_*` from `provider/transform`, `BRAIN_SESSION_TITLE` from `brain/index`, `HerdrBridge` from `plugin/herdr/index`) and `OPENROUTER_VOICES_LIST` from the speak tool. Callers import the shared package directly.

**One of them was doing real work, not just forwarding.** `src/plugin/shared.ts` also _configured_ the installer hook as a side effect of being imported — so whether the terminal could install a plugin depended on some module further down its import graph having pulled that file in first. It happened to work because `thread.ts` reaches `@/config/tui`, which imported it. That is luck, not design. The wiring is now `src/plugin/installer.ts` with one exported function, called explicitly by the two entry points that can install: `cli-main.ts` and `plugin/host-local.ts`.

A re-export that has a side effect is not a compatibility shim — deleting it silently removes behaviour. Check what each one _does_ before treating it as forwarding.

**6. Add the second consumer.** Landed 2026-08-16 — as an executable check rather than a product surface.

`packages/desktop` was the obvious candidate and is the wrong one: it is a Tauri webview app, and the TUI renders through `@opentui/solid` to a terminal. (`@opentui/webrenderer` does not bridge that gap — it is a _webview inside the TUI_, the opposite direction.) Rendering the terminal in the desktop is a product feature, not a packaging check, and section 6 exists for the packaging check.

So the second consumer is `packages/tui/bin/nikcli-tui.ts` → `src/host/standalone.ts`: the real terminal, attached to a nikcli server it did not start, importing `@nikcli-ai/tui` and the SDK and **nothing** from `packages/nikcli`. That boundary is structural — `packages/tui/package.json` has no dependency on `nikcli-ai` — so if a backend chain creeps back in, this host stops building while the CLI's own entry points keep working, because they carry the backend anyway.

Two things it does without, both honest limits rather than stubs:

- **No external plugins.** The plugin runtime needs the config _surface_ — which files to watch, when a dependency install finished — and that is local filesystem work belonging to whoever owns the project. A client attached to someone else's server has no such surface, so `remotePluginHost` reports none and only internal plugins load.
- **No local config read.** `tui()` takes the renderer config as a prop because it is needed before any transport exists; here the transport is a server that is _already listening_, so the host simply asks it.

**Verified** by `bun run smoke:standalone <url>` against a real `nikcli serve`: 580 printable characters painted. Two failures on the way there are worth keeping:

- `bun run <file>` resolves its argument as a _script name_ first and prints the script list instead of executing the file. The harness spawns `bun <file>`.
- Bun reads `jsxImportSource` from the nearest tsconfig **to the cwd**, not to the entry file. Started from a scratch directory, JSX fell back to `react/jsx-dev-runtime` and the app could not load — a failure that looks like a missing dependency and is not one. A consumer runs from its own package root; the CLI does the equivalent explicitly, by passing `tsconfig` and the Solid plugin to `Bun.build`.

**Deployment**: `packages/tui` is a build-time dependency of the nikcli binary, so `Dockerfile`, `Dockerfile.serve` and `script/railway-deploy.sh` each copy it twice — once as a manifest for the `bun install` layer, once as source. It cannot be one of the stubbed workspace entries in `Dockerfile.serve`: `thread.ts` imports `@nikcli-ai/tui/app` and the build bundles it.

## Verification

- `packages/tui` typechecks with `packages/nikcli` excluded from its `tsconfig` references.
- No import in `packages/tui` matches `@/` or resolves into `packages/nikcli`.
- The TUI starts from the installer binary, not just from a dev checkout — the binary is where bundling assumptions break (see the Playwright `__dirname` precedent in the browser work).
- Startup time does not regress. The TUI startup graph was deliberately cut once already (server chains removed from the module graph, AI SDKs made lazy), so measure warm, best of three, before and after section 4 — a packaging change that re-imports a backend chain undoes that work invisibly.

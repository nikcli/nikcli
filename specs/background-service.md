# Background service

## Why

Every `nikcli` invocation evaluates the whole engine graph in its own process:
~988K `Function` objects, ~23K `FunctionExecutable`, ~125 MB of JS heap, and
~423 MB peak RSS on the compiled binary — paid again on every start, and paid a
second time by the TUI's worker thread, which is a separate isolate.

opencode v2 does not pay this per invocation. Its CLI process is thin and the
session engine lives in a **persistent background service** that every client
connects to over HTTP (`packages/cli/src/server-process.ts`, plus its
`service start/stop/status/restart` commands). The engine graph is evaluated
once per machine and stays warm across invocations.

nikcli already has every piece this needs:

- `Server.listen()` binds a real HTTP server (`server/server.ts`).
- `nikcli serve --stdio` prints `{"url":"..."}` on stdout once `/global/health`
  answers — a readiness handshake explicitly "for parent processes".
- `GET /global/health` is public and returns `{ healthy, version, revision? }`,
  which is both the liveness probe and the version check.
- The HTTP API is **directory-scoped** already (`x-nikcli-directory` header or
  `?directory=`), so one global service serves every project.
- `nikcli attach <url>` runs the complete TUI against an external server in 38
  lines — no worker thread, no custom `fetch`, no synthetic origin.
- `serve` already suspends active sessions on shutdown and resumes them on the
  next start (`specs/v2/session-restart-continuation.md`).

So this is lifecycle management on top of `serve --stdio`, not a rewrite.

## Model

One service per **channel**, per data directory, on loopback. Two things follow
from "per channel" that are easy to miss and expensive to get wrong:

- The registration file is `service.json` for the shared channels
  (`latest`/`dev`/`beta`/`next`) and `service-<channel>.json` otherwise. Without
  it a `local` dev build and an installed release discover _each other's_
  service and restart it on every version check, forever.
- The default port is per channel too — `0xc0de` shared, `0xc0df` local,
  otherwise hashed into 10000-60000 — so two builds never race for one socket.
  `serve` still falls back to an ephemeral port when it is taken and the
  registration records what was actually bound, so nothing depends on it.

```json
{ "id": "9f2c…", "pid": 1234, "url": "http://127.0.0.1:49374", "version": "1.348.0", "startedAt": 1757680000000 }
```

**The service writes and removes its own registration** (`serve --service`), and
the client polls discovery rather than reading a handshake off a pipe: a spawned
daemon whose stdout stays piped to a parent that then exits takes EPIPE on its
next write, so a true daemon wants every stdio stream ignored. The write is
`temp file + rename` at mode `0600`, so a client polling during startup never
parses a half-written file.

### One service per channel, enforced by the service itself

Each instance stamps a random `id`. A watchdog re-reads the registration every
5s and, if the entry is no longer its own, **stands the process down**. Cleanup
on shutdown is ownership-checked for the same reason, so an older instance
exiting cannot delete its successor's entry.

That, not locking, is what keeps two services from serving one channel
indefinitely: the client-side lock only narrows the spawn race, while this
resolves it after the fact no matter how two instances came to exist.

### Discovery

`BackgroundService.discover()` returns a live service or `undefined`, believing
a registration only after all three checks pass — cheapest first:

1. The file parses and names a pid.
2. `process.kill(pid, 0)` says the process exists.
3. `GET /global/health` answers `healthy: true` within a short timeout.

Any failure means "not running": the entry is stale and gets removed. A stale
file must never be fatal — a machine that crashed mid-session should start
cleanly, not report an error.

Two refinements keep that from turning on a live service:

- **A timeout is not a refusal.** A refused connection is final at once; a probe
  that times out means something accepted the connection and did not answer —
  a service whose event loop is blocked. It is retried for up to 6s before the
  entry is written off, because removing a live service's entry evicts it and
  suspends every session it runs.
- **Removal is ownership-checked.** The entry is deleted only if it still names
  the registration that was judged stale. Between reading it and deciding, a
  new service can register, and deleting _its_ entry stands it down.

The service's watchdog makes the matching distinction: a missing file or a
different owner stands it down, but a read that _fails_ (EMFILE, EIO) says
nothing about ownership and is ignored until the next tick.

### Version skew

Health returns the service's version, and a client must never drive a service
built from different code — both sides of the HTTP contract are generated from
one source tree. The check is **channel-aware**, not exact equality: preview
channel versions carry a build counter (`0.0.0-<channel>-<n>`), so requiring
equality would read every rebuild as skew, restart the service each time, and
leave the engine permanently cold — the exact opposite of the point.

### Start

Spawn `serve --service --port <configured or channel default> --hostname
127.0.0.1` with `detached: true` (verified to place the child in its own process
group, so Ctrl+C in the client's terminal does not reach it), every stdio stream
ignored, and the handle `unref`'d. Then poll `discover()` until healthy, or give
up after the start timeout.

Two clients starting at once race, so start is guarded by an atomic
`service.lock` created with `wx`; whoever loses polls discovery until the winner
registers. The winner runs discovery once more after taking the lock: the
caller's own check ran before the lock was held, and a service that finished
starting in between must be returned, not answered with a second engine. A lock
older than the start timeout is treated as abandoned — a client killed mid-spawn
must not wedge every later start.

The child's cwd is the user's home, not the spawning client's project. The
service serves every project and outlives the client; requests name their own
directory, and a project cwd would leak into whatever still falls back to
`process.cwd()` — and pin a directory that may be deleted or sit on an
unmounted volume. Every client therefore names one: the SDK client on each call,
the TUI's raw `/sync/*` requests as `?directory=`, and `nikcli attach` to the
service, without `--dir`, the directory it runs in.

### Settings

`nikcli service get|set|unset` persist `hostname`, `port`, `cors` and `env` next
to the registration, per channel, and `start` applies them. Clients spawn the
service, so there is nowhere to pass these at the moment it actually starts;
this file is that "nowhere". **Every mutation stops the running service** — a
setting that only takes effect after the user happens to restart is a setting
that looks broken.

### Stop

`SIGTERM` to the pid; `serve` already handles it by suspending live sessions so
the next start resumes them. Wait for the process to disappear, then remove the
registration; `SIGKILL` only if it outlasts the stop timeout.

The pid is signalled only once it is proven to be the service: a registration
outlives a crash and the OS reuses pids, so a live pid alone may be any process
of the user's. The registered URL must answer health with the registered
version (opencode's daemon makes the same check). A probe that times out counts
as the service — something holds the registered port without answering, which
is a wedged service, the case `stop` exists for. Anything else leaves the pid
alone and drops the entry as stale.

### Authentication

The service always requires a password, as opencode's daemon does. Loopback is
not a boundary on its own: every local user can reach the port, and so can any
web page the user opens. The credential is what only the service's own user
holds.

- **One password per channel**, in `service.password` (or
  `service-<channel>.password`) next to the registration, mode `0600`. The first
  client or service to need it generates 32 random bytes; creation is
  create-if-absent (a hard link of a complete temp file), so concurrent first
  starts converge on one password instead of each writing its own.
- **The service reads it itself.** `serve --service` adopts the file's password
  before it listens (`Auth.useServicePassword`), so there is no moment it answers
  without one. It never travels through the environment: the shells, MCP servers
  and language servers the service spawns do not inherit it. It outranks
  `NIKCLI_SERVER_PASSWORD`, whose value belongs to whichever client happened to
  spawn the service.
- **Username `nikcli`, HTTP Basic** — opencode's `ServerAuth.headers` shape.
- **The credential is the trust boundary, not the socket.** Two layers stay
  apart: _admission_ (may this caller talk to the server — the password, a
  tailnet identity, or nothing on an unsecured server; `Auth.serverAdmission`)
  and _identity_ (which user — a bearer). Public without either: the health
  check (`/global/health`), CORS preflight, and the routes that issue a user
  its credential (`/user/status|login|register`), which check what they are
  given themselves. A loopback caller counts as this machine's operator
  (`Auth.markLocal`, which lets `sessionFor` answer with the machine's own
  account) only once it satisfies admission; before, anyone on the socket got
  that account — its email, and through `/user/register`'s admin check a user
  whose bearer the server then admitted without the password.
- **`/account/*` is the operator's.** It reads and replaces this machine's
  signed-in account, so it takes admission and nothing less — a user's bearer
  identifies a user, not the operator — and the LAN pairing socket serves none
  of it. It is exempt only from the signed-in-user requirement
  (`NIKCLI_REQUIRE_OAUTH`), since signing in is how a machine gets a user.
- **Every client presents it.**
  - One rule, `BackgroundService.withCredentials`: the credential goes in the
    `Authorization` header, and a bearer the request already carries (the
    `/user/*` calls send the terminal's issuer token) moves to `?token=`, the
    `auth_token` scheme the server accepts wherever it accepts a bearer — one
    header cannot hold both.
  - The TUI's service path, `nikcli attach` and `nikcli run --attach` resolve a
    URL through `BackgroundService.connection`: the channel password for the
    service, sent to its origin only, plus the directory the client runs in;
    `NIKCLI_SERVER_PASSWORD` for any other server.
  - In-process SDK clients (plugins, the embedded TUI worker, `nikcli run`)
    use `Server.localFetch`, and `nikcli acp`'s client of its own listener
    sends `Auth.authorizationHeader()`.
  - The Discord bot the server starts receives the credentials; the island
    snapshot (0600, in a 0700 directory) carries the `Authorization` its
    permission replies need.
  - WebUI and anything outside nikcli sign in as `nikcli` with the output of
    `nikcli service password`.
- **`nikcli service set env NIKCLI_SERVER_PASSWORD|USERNAME`** is refused: the
  service password outranks them, so the setting would do nothing.
- **`nikcli service password [value]`** prints the password, or replaces it and
  stops the running service. It writes before it stops — the reverse of
  opencode — because a client starting between a stop and the write would
  spawn a service on the old password while every client reads the new one.
  Clients still running on the old password are refused until restarted.

CORS origins are matched on the parsed hostname, not a prefix of the origin:
`startsWith("http://localhost")` also admitted `http://localhost.evil.com`.

### Mobile pairing

The service binds loopback, so a phone has nowhere to point. `POST
/mobile/host/lan` opens a **second** listener on `0.0.0.0`, in the engine
process, and answers with its URL; `GET` reports whether one is bound. The TUI's
pairing dialog calls it over the ordinary SDK client, so the same code serves
both the service path and the private in-process one.

Two properties are load-bearing:

- **The LAN socket gets its own router**, with `mobileAuthRequired` on. That flag
  used to be set on the process-wide pipeline, which every local client shares:
  turning it on answered 401 to the very TUI that had just asked for a pairing
  link. Only requests arriving on the LAN socket are held to a mobile token now.
- **Starting is idempotent.** Pairing again — or from a second client — reuses
  the bound listener, so a QR code a phone already scanned keeps working.

The listener outlives the client, like the sessions do. `Server.stopMobile()`
closes it on server shutdown; a pairing is revoked by revoking its token.

### Deliberate differences from opencode

Behaviour follows opencode's daemon (`services/daemon.ts` in its `packages/cli`). What nikcli adds, each
for a failure opencode's shape does not cover:

- **Per-channel registration, port, password and settings**, so a `local` build
  and an installed release never discover — and restart — each other.
- **Channel-aware version check** instead of exact equality, so preview builds
  do not restart the service on every rebuild.
- **A start lock**, re-checked after it is taken, on top of the ownership
  watchdog opencode relies on alone.
- **A busy grace**: a health probe that times out is retried before the entry is
  written off, where opencode replaces the service after one failed probe.
- **Suspend on stop, resume on start**, so a session survives a restart.

## Measured

TUI booted under `@nikcli-ai/terminal-control` in a fresh test home; **peak** RSS
of the process tree, sampled every 2s over a **fixed 30s dwell after first
paint**. The dwell has to be fixed: an adaptive wait (`stable`) settles at
different times in the two modes, compares two different load states, and
reported this backwards the first time it was run.

|                                     |     client | service |      total |
| ----------------------------------- | ---------: | ------: | ---------: |
| in-process, eager commands (before) |     973 MB |       — |     975 MB |
| service, eager commands             |     412 MB |  517 MB |     929 MB |
| in-process, lazy commands           |     819 MB |       — |     821 MB |
| **service + lazy commands**         | **340 MB** |  450 MB | **790 MB** |

What the table says, which is not what you would guess:

- **The service's win is the client, not the total.** 973 → 412 MB eager,
  819 → 340 MB lazy: roughly −58% either way. The total barely moves (975 → 929
  eager) because the engine does not disappear, it relocates. The real payoff is
  amortisation — a second concurrent TUI costs another 340 MB client, not another
  engine — and it needs more than one client to show up at all.
- **Lazy commands are worth less in-process than the module graph suggests.**
  `@/cli-main` drops 364 → 127 MB, but in-process RSS only 975 → 821 MB, because
  the TUI worker still loads a full engine in its own isolate no matter what the
  main thread skipped. The two changes compose: together, 975 → 790 MB total and
  973 → 340 MB for the client.

## Command registration

> **Superseded.** This section proposes a `lazy()` wrapper for the yargs
> registration tree. That tree is gone: [`specs/cli-framework.md`](cli-framework.md)
> replaced it with `effect/unstable/cli`, where the command table is data and
> _every_ handler — the default `$0` included — is already a `() => import()`.
> That went further than the numbers below (`154K` → `33K` `Function` objects),
> so there is nothing here left to implement. Kept for the measurements and for
> the reasoning in points 1–3, which is what the effect tree ended up doing.
> Do not reintroduce `src/cli/cmd/lazy.ts`.

`cli-main` imported all ~44 command modules eagerly. Because `run [message..]`
pulls the whole engine, the main thread loaded a complete engine graph _and_ the
TUI worker loaded another in its own isolate — two engines per session, to run a
command that is almost always the default TUI.

Registering through `lazy()` (`src/cli/cmd/lazy.ts`) takes `@/cli-main` from
**988K `Function` / 125 MB heap / ~364 MB RSS / ~745 ms eval** to
**154K / 26 MB / ~127 MB / ~237 ms**, and `nikcli heap` from 0.90s to 0.40s warm.

This is the change commit `1e6e0ce304` made and had reverted for making the tool
worse. Three differences:

1. `$0` — the interactive TUI — stays eager. Only named, one-shot commands defer.
2. Nothing gets slower. Under eager registration _every_ invocation paid for all
   44 command modules, so each command now loads strictly less than before.
3. `describe` and `command` stay at the registration site, so `--help`, command
   matching and completion never load a handler. yargs awaits an async `builder`,
   so per-command flags still parse identically; `test/cli/lazy-commands.test.ts`
   holds each duplicated spec to the module it points at.

## Rollout

**On by default**, matching opencode, whose `--standalone` flag means "run with a
private server instead of the background service". nikcli's TUI takes the same
shape:

|                                    | path                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| `nikcli`                           | shared background service                                    |
| `nikcli --standalone`              | private in-process server                                    |
| `NIKCLI_SERVICE=0`                 | private in-process server                                    |
| `--port` / `--hostname` / `--mdns` | private server, since the caller wants their own listener    |
| `NIKCLI_DRIVE` (simulation)        | private, always — the deterministic mock lives in the client |
| `NIKCLI_TEST_HOME` set             | private, unless `NIKCLI_SERVICE=1`                           |

The test-home rule is not cosmetic. A service outlives its client by design, so a
suite that boots the TUI would leave one daemon per test home behind, and stray
nikcli processes are already a documented cause of bogus measurements and flaky
runs. Tests that _want_ the service ask for it with `NIKCLI_SERVICE=1`.

A service that will not start is not fatal: the client logs a warning and falls
through to the private path. The failure modes are environmental — a wedged port,
a killed spawn — and a user who cannot open their editor has a worse problem than
a cold engine.

The one behaviour change to know about: **a session now outlives the client**.
Closing the TUI no longer stops the work; `nikcli service stop` does.

Upgrade runs in the _client_, not the service: it replaces the installed binary,
and the service is a different (older) copy of it. After an upgrade the running
service is on the previous version, and the next client restarts it on the version
skew check.

## Not in scope here

- Lazy command handlers with a static spec. They only pay off once the engine is
  out of the CLI process — before that, deferring a command module just relocates
  the monolith, which is why the previous attempt was reverted. Revisit after the
  service is the default.
- Service supervision (restart on crash) and idle shutdown.

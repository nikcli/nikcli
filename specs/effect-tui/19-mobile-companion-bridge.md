# EOT-19: Mobile Companion Bridge

Status: proposed. Tier: 2. Phase: P3. Dependencies: EOT-04, EOT-08, EOT-12, EOT-15.
Owner: `packages/nikcli/src/server/mobile/*`, `packages/companion/`, `packages/remote/`, and mobile dispatch
maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B36, B37 in the [register](../README.md): `packages/nikcli/src/server/mobile/` is 3,605 lines spread across 18
modules (`auth.ts`, `dispatcher.ts`, `events.ts`, `features.ts`, `git.ts`, `github.ts`, `helpers.ts`, `host-status.ts`,
`loops.ts`, `memory.ts`, `misc.ts`, `missions.ts`, `pty.ts`, `request.ts`, `session-lifecycle.ts`, `session.ts`,
`teleport.ts`, `worktree.ts`). The routes themselves are an Effect HttpApi group:
`packages/nikcli/src/server/httpapi/mobile.ts` (1,319 lines) declares the `/mobile/*` endpoints and
`mobile-handlers.ts` (355 lines) binds them, while `packages/nikcli/src/server/websocket.ts` (122 lines) owns the
upgrade. There is no `server/mobile.ts` monolith — a resurrected copy of that file silently shadows the split directory
and empties the mobile session list, so do not reintroduce one. The `packages/companion` (Cloudflare Workers + UI) and
`packages/remote` (tunneled proxy + UI) ship separate clients. The opportunity is a single architectural spec covering the **bridge protocol**: authentication,
session lifecycle, event delivery, command dispatch, capability gating, and multi-device ordering. Today the surface is
large but loosely coordinated; a unified spec lets each module follow a single contract.

## Scope and Non-Goals

Define the canonical mobile companion bridge architecture: protocol, authentication, session lifecycle, event delivery,
command dispatch, capability gating, and multi-device coordination. Preserve the existing `httpapi/mobile.ts` route
group and the `server/websocket.ts` upgrade; preserve `companion/` and `remote/` packages. Do not invent a second
transport, replace the existing websocket, reintroduce a `server/mobile.ts` monolith, or change the on-disk layout.

## Design and Requirements

1. The bridge protocol is a single document: a typed contract covering all RPC-style operations the mobile app needs
   (`session.list`, `session.create`, `session.send`, `session.abort`, `session.warp`, `permission.respond`,
   `question.respond`, `loop.list`, `loop.run`, `mission.list`, `mission.run`, `pty.run`, `git.status`, `git.diff`,
   `github.pr.*`, `teleport.upload`, `teleport.download`, `worktree.create`, `memory.read/write`, `host.status`).
   Each operation is a typed Effect with `Schema.TaggedError`. The contract is generated; there is no hand-written
   client.
2. Authentication uses the existing JWT-verified `externalSessionForToken` flow. The mobile app presents a short-lived
   token minted by the TUI/CLI; the server validates it against the issuer. A revoked token returns
   `MobileError.TokenRevoked`, not a network error.
3. WebSocket upgrade is the canonical long-lived transport for events and pings. The handshake validates the token,
   negotiates capabilities (`read`, `write`, `pty`, `teleport`), and emits a `MobileEvent.Hello`. Reconnect uses
   EOT-04's bounded backoff; a successful reconnect resumes the event stream from the per-aggregate watermark.
4. Session lifecycle is the mobile-aware subset of EOT-15. The mobile app reads and writes sessions through the
   bridge; the bridge applies `originDeviceID` and the multi-device ordering. Read-after-write uses
   `(watermark >= newWatermark)` to guarantee visibility on the device that issued the mutation.
5. Event delivery reuses the EOT-04 admission/flush coordinator. The mobile websocket gets its own admission queue
   with the same count/byte bounds; a slow mobile subscriber is evicted with `MobileError.QueueOverflow`, not a silent
   drop. Heartbeats are typed operations; missing heartbeats trigger reconnect, not domain mutation.
6. Command dispatch is typed: `MobileRequest(command, args)` carries a typed payload and a request id; the response is
   `MobileResponse(requestID, data | error)` with a typed `MobileError`. Dispatch is per-request, never per-connection
   state, so a single websocket can multiplex commands and events. The dispatcher rejects unknown commands with
   `MobileError.UnknownCommand`; rate-limited commands return `MobileError.RateLimited` with a `retryAfter`.
7. PTY runs over the websocket with typed frames (`PtyInput`, `PtyOutput`, `PtyResize`, `PtyExit`). Cancellation closes
   the pty and waits for `PtyExit`; a missing `PtyExit` within a deadline returns `MobileError.PtyLeaked`. PTY output is
   bounded; oversized output is truncated at the buffer, not the wire.
8. Teleport (file upload/download): chunked transfer over HTTP, typed envelope, server validates against
   `WorktreeRef` and `Permission.Ruleset`. The server enforces per-route body limits (EOT-10) and per-request content
   length. A failed chunk is retried at the chunk level, not the request level.
9. Capability gating: the bridge advertises capabilities per device. A device without `pty` cannot open a pty; a device
   without `teleport` cannot upload/download; a device without `git` cannot read git status. The UI surfaces missing
   capabilities as typed affordances, not silent no-ops.
10. Memory: `memory.read/write` are scoped to the user's account; cross-account reads return `MobileError.Forbidden`.
    The TUI/CLI memory service backs the mobile calls; the mobile app is a thin client.
11. Companion and remote packages: `companion` is the Cloudflare-hosted client (browser UI); `remote` is the tunneled
    proxy for self-hosted servers. Both consume the same bridge contract; the only difference is the transport
    (Cloudflare Workers vs. tunneled WebSocket). Capability discovery is part of the contract; both clients surface
    the same affordances.
12. Multi-device coordination: when a TUI session and a mobile session both attach to the same user, both receive
    events with `originDeviceID`. A mobile-initiated mutation that conflicts with a TUI mutation is resolved per
    EOT-15's per-aggregate rules. The bridge never silently merges; it returns a typed conflict and lets the UI
    resolve.

## Bridge Topology

```text
Mobile app / companion UI / remote proxy
  -> WebSocket + HTTP bridge
       -> JWT verification
       -> capability negotiation
       -> command dispatch (typed)
       -> event admission (bounded queue)
       -> multi-device ordering (originDeviceID, watermark)
  -> nikcli server (mobile handlers)
       -> typed Effect operations
       -> domain services (session, loop, mission, pty, git, teleport, worktree, memory)
  -> bus + SSE/SDK + TUI
```

## Failure and Cancellation

Use `Schema.TaggedError`: `MobileError.TokenRevoked`, `MobileError.TokenExpired`, `MobileError.CapabilityDenied`,
`MobileError.QueueOverflow`, `MobileError.RateLimited`, `MobileError.UnknownCommand`, `MobileError.PtyLeaked`,
`MobileError.TeleportChunkFailed`, `MobileError.Forbidden`, `MobileError.Conflict`, `MobileError.HeartbeatLost`.
Cancellation closes the websocket and disposes per-device resources. Reconnect resumes from the watermark; a missing
`PtyExit` returns `PtyLeaked` and the resource is force-closed. Rate-limited commands return `retryAfter`; the client
honors it without retrying sooner. Multi-device conflicts return `Conflict`; the UI is the resolver.

## Acceptance and Verification

- A recorded session lifecycle exercise: connect, hello, send, abort, reconnect, resume from watermark. Heartbeat loss
  triggers reconnect; capability denial is reported as typed; rate-limited commands return `retryAfter`.
- PTY run + cancel: output is bounded, oversized output is truncated, and missing `PtyExit` returns `PtyLeaked`.
- Teleport upload: chunked transfer resumes after a failed chunk; per-route body limits enforced; cross-account
  attempts return `Forbidden`.
- Two devices on the same account receive events with `originDeviceID`; conflict resolution matches EOT-15's
  per-aggregate rules.
- Companion (`packages/companion`) and remote (`packages/remote`) consume the same contract; the only difference is the
  transport, which is verified by a shared schema test.
- Reconnection with the EOT-04 backoff produces the same final state as a clean connection.
- Extend `packages/nikcli/test/mobile/`, `packages/nikcli/test/server/event-feed.test.ts`,
  `packages/nikcli/test/server/event-visibility.test.ts`, `packages/companion/test/`, `packages/remote/test/`, and
  existing pty/teleport tests.
- From `packages/nikcli`: `bun test test/mobile/ test/server/event-feed.test.ts`. From `packages/companion` and
  `packages/remote`, use each package's own harness. One final root `bun run typecheck` after the slice.
- Meet EOT-01 budgets; reconnect resumes within the backoff cap; mobile admission queue respects the same byte/count
  bounds as the SDK; redaction tests assert no token leakage in error paths.

## Migration and Rollback

Phase by capability group: session lifecycle first (mobile sees sessions), then events/heartbeat, then PTY, then
teleport, then worktree. Each group flips a per-capability flag; the legacy HTTP/websocket paths stay until both
directions are tested. Roll back by toggling the per-capability flag to the legacy handler; never delete the typed
errors or the multi-device ordering. Per-device state is additive; never delete device records as part of a bridge
refactor.

## Discipline Addendum — 2026-09-20

`GET /mobile/bootstrap` is on the app's connect path, and it was unbounded (commit `d1e2f99e`).

`Expo.doctor` spawned `npx eas --version` with **no timeout at all** — the sibling expo probe got one through `exec`, this one was spawned directly — so the request stayed open for as long as npx wanted. And npx wanted a while: without `--no-install`, `npx <pkg> --version` fetches the package from the registry before answering, so a probe asking "is this installed" installs it and takes however long the network does. Measured here: 8s+ against a 950ms fix (`--no-install`, a 3s ceiling, and the three independent probes run concurrently instead of in sequence).

Two rules for this bridge:

1. **A capability probe is a local question and must be answered locally.** Anything on a connect path that can reach the network for an answer the filesystem already has is a hang waiting for a bad café. Actions the user explicitly asked for — `start`, `build`, `install`, `publish` — still fetch, because fetching is the point there.
2. **Every spawn on a request path carries its own deadline.** `exec` has one; a hand-rolled `Bun.spawn` beside it does not, and the difference is invisible at the call site.

`test/server/mobile-pairing-listener.test.ts` was failing its 5s budget on this for the authenticated request — the one that actually reaches the handler. It passed only when another file in the run had already warmed the probes, which is why it read as a flake for as long as it did.

## A Sync Token Reaches Only the Sync Transport — 2026-09-24

Capability gating (`MobileAuth.requiredCapability`) guards pty, teleport and git, and deliberately leaves `read` and
`write` unclassified. That left a `cli-sync` token — the credential `nikcli sync token create` hands to a remote hub —
able to reach every route no capability guarded: sessions, config, files.

The fix does not classify the whole API. `MobileAuth.scopeReaches` makes that one scope an allowlist of the transport's
own routes, taken from its only callers (`src/sync/transport.ts`, `src/sync/remote-client.ts`): `POST /sync/event`,
`GET /sync/outbox`, `GET /sync/stream`, plus the read-only `GET /sync/snapshot/:aggregateID`. The routes that
reconfigure this machine — `/sync/config`, `/connect`, `/disconnect`, `/drain` — are outside it. A refused route is a
403 naming the scope, for the reason the capability refusal is. `mobile` and `studio` tokens are unchanged; classifying
`read`/`write` for them remains open.

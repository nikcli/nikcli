# EOT-21: Gadgets — Device SDK, Bridge and Agent Tool

Status: proposed; first slice implemented as plugins (no change to nikcli's core). Tier: 2. Phase: P3.
Dependencies: EOT-04, EOT-10, EOT-14, EOT-17, EOT-19. Owner: plugin SDK and bridge maintainers.
[Roadmap](../ROADMAP.md).

## Problem and Evidence

Muse Gadgets (Meta, 2026-10-02, `facebookincubator/muse-gadget-sdk`) lets a cheap device — an ESP32 board or a Linux
single-board computer — pair with an agent and become one of its hands: the agent runs `system.run`, `file.read`,
`file.write` and `device.health` on the device, the device pushes a message into a session (`send-user-msg
--session-id`), a button starts a turn, and a display shows what the agent answers. Pairing needs an SDK token and a
physical confirmation, and Muse itself says the token on an ESP32 is "an identifier rather than a password".

nikcli had every half of that and none of the whole:

- **Tools from plugins.** A server plugin returns `tool: { … }` and `packages/nikcli/src/tool/registry.ts` turns each
  into a registry tool; `ctx.ask` is how a tool asks the operator before it acts.
- **A client into the running instance.** `PluginInput.client` is the generated HttpApi client, which can create a
  session, send a prompt (`session.promptAsync`) and deliver a UI event to mods (`mod.event`).
- **A v2 plugin surface for the TUI.** `packages/plugin/src/v2/manifest.ts` and the capabilities the TUI host supplies
  (`TUI_HOST_CAPABILITIES` in `packages/tui/src/plugin/v2.ts`: `routes`, `commands`, `storage`).
- **Mod trees and `ui.press`.** `packages/nikcli/src/mod/ui.ts` defines the bounded drawing tree; the same limits are
  reused for a gadget's display.

What was missing is the device: something that is neither a terminal, a phone nor a browser, that can pair, declare what
it can do, receive invocations, report results, push messages and draw. This spec defines it as a **gadget**, with the
device SDK, the bridge, the agent tool and the TUI commands — all as plugins.

## Decision: a plugin, not core

An earlier draft of this spec changed the core: a `gadget` scope in `MobileAuth`, a `/gadget/*` HttpApi group, a new mod
`Surface`. It was dropped. A device is an extension, `PluginInput.client` already reaches everything the bridge needs, and
a plugin can be removed by deleting one line of config. So nothing under `packages/nikcli/src` changes.

Two facts about the loader shaped the result and are recorded so nobody rediscovers them:

- `plugin` in `nikcli.json` is `z.string().array()`: server plugins are bare specifiers and cannot carry options. The
  bridge is configured by environment variables, and the second argument of `server()` overrides them for a host that
  passes one. The TUI side does take options in `tui.json`.
- The server loader imports the package's `.` export (or, for a `file://` spec, the file it names; a directory with the
  loader's `?generation=` suffix does not resolve). So the plugin is its own package, not a subpath of the SDK, whose `.`
  is the device-side `Gadget`.

## Scope and Non-Goals

In scope, and implemented:

1. `@nikcli-ai/gadget` (`packages/gadget`) — the device SDK, TypeScript on Bun (Node refuses to run TypeScript from
   `node_modules`, and the package does not claim it), and a portable C client for devices without it: `Gadget`, the four built-in
   commands, display and button drivers, the transport, `nikcli-gadget pair|run|send|health|status|unpair|init`,
   `install.sh`, five examples, and the wire protocol in `linux/src/protocol.ts`.
2. `@nikcli-ai/plugin-gadgets` (`packages/gadget-plugin`) — the bridge, the `gadget` tool and the TUI plugin.

Non-goals, stated so nobody scopes them in by accident:

- **No built ESP32 firmware and no Nintendo Switch homebrew.** The portable C client (`packages/gadget/c`) is built and
  tested on a host; the ESP-IDF shell around it is written but has never been compiled, and no libnx shell exists. Nothing
  claims either works on a device.
- **No per-command tools.** They need the tool registry to re-derive on a device's hello, which today it does only on
  instance reload.
- **No second transport and no change to nikcli's auth.** The bridge is a separate listener with its own token scheme.
- **No code from a device ever runs in nikcli.** Only JSON the registry validated crosses in.
- **No new permission evaluator.** Gating is `ctx.ask` under permission id `gadget`; this spec adds patterns, not a mechanism.

## Requirements (as implemented)

1. **Two packages, one protocol file.** `linux/src/protocol.ts` holds routes, limits, frame shapes, `GadgetError` and
   `parseHello`; the plugin imports it as `@nikcli-ai/gadget/protocol`. A change there changes both ends.
2. **A gadget is a paired device with a declared command set.** Its id is the slug of its name. On every connect it
   sends a `Hello` — name, version, platform, `commands[]` (`namespace.name`, description, JSON Schema args, optional
   `timeoutMs` and `maxOutputBytes`), optional `display`, `buttons`, `audio` — which replaces the previous declaration
   whole. A malformed hello is refused as `HelloInvalid` with the first problem named and leaves the previous declaration
   in place; the valid subset is never loaded.
3. **Pairing is a ten-minute window, a six-digit code and, when the device has one, a button.** The code is single use;
   five wrong guesses close the window. A device that declares a button must press it (`POST /pair/confirm`) before its
   hello is accepted. Pairing always mints a fresh token. The same machine pairing again keeps its id, gets a new token,
   and the old one is revoked.
4. **Tokens are device credentials.** `nkg_…`, hashed (SHA-256) at rest in a file written with mode 0600, compared in
   constant time, revocable. A hello must carry the fingerprint the device paired with — omitting it is refused as
   `Denied`, not skipped — and the feed opens only after a hello accepted by _this_ process, since the stored declaration
   survives a restart and the proof of the fingerprint does not. The fingerprint **identifies** a device; it does not
   authenticate one: a MAC-derived value is guessable on a LAN and whoever can read the token can read the identity file, so
   it notices a token copied to another machine by mistake, not a determined thief, who is stopped by revoking the token.
   The other device routes accept the token alone. A revoked token answers `TokenRevoked`, an unknown one `NotPaired`; the
   SDK stops retrying on either and tells the operator to pair again. A token opens only its own device, and a device that
   has not pressed its button opens nothing: `Unconfirmed` on every device route except the confirmation. The SDK's
   fingerprint is a random value written once to its state directory (mode 0600) and kept with the pairing: not the OS
   machine id, which cloned SD cards and two gadgets on one host share, and the bridge reads an equal fingerprint as "the
   same device pairing again" and revokes the old token. It survives `unpair` and interface changes; on a read-only system
   it falls back to a hash of the machine's own identifiers.
5. **The bridge is a separate listener (default 4097).** The only unauthenticated routes are `GET /` and `POST /pair`, and
   `/pair` needs the code. `/admin/*` answers only loopback callers with no `X-Forwarded-For` or `Forwarded` header, and
   refuses what a browser sends — a request with an `Origin`, a `Host` that is not a loopback name (DNS rebinding), or a
   body that is not JSON — because a loopback source address is not proof the caller is the operator: any page the
   operator has open can send a request from their browser to 127.0.0.1. The admin routes are `list`, `pair`, `health`,
   `message` and `revoke`: what the TUI uses. There is deliberately **no** route to run a command or draw, because over HTTP
   any local process — the agent's own shell included — could call it without the `ctx.ask` the `gadget` tool performs.
   What remains trusts any process on this machine, so `pair` and `revoke` can be done without asking by a process that can
   run `curl`; the gate for that is the permission on the shell tool, not this bridge.
6. **The invocation feed is one SSE stream per device.** Frames: `hello`, `invoke`, `show`, `message`, `ping`, `bye`. A
   ping every 15 s; a feed 256 frames behind is evicted and everything waiting on it fails `Offline`; a newer connection
   replaces the old one; a device with no feed is `Offline` immediately, not queued. The SDK reconnects with backoff
   when the bridge ends the stream by itself (two processes sharing one token would otherwise evict each other at full
   speed), treats three missed pings (45 s of silence) as a dead connection, and a frame that fails to draw is logged and
   does not drop the feed. A device may declare `maxFrameBytes`, the largest frame it can read; the bridge refuses a bigger
   `invoke`, `show` or `message` with `PayloadTooLarge` and the sizes, instead of sending what the device would drop.
7. **Invocations are serialized and bounded.** One command in flight per device and eight waiting behind it; the next
   waiter is `Busy` with a retry time. The time allowed runs from the moment a command is sent, not from when it was queued,
   and travels in the `invoke` frame as `timeoutMs`, relative to receipt: the bridge's clock and the device's are not the
   same clock, and a Pi with no battery-backed RTC can be hours off before NTP. The device aborts the handler when it has
   run that long. A late result for a dropped call is discarded. A result is one
   POST; output is cut at the command's `maxOutputBytes` (default 256 KB, ceiling 4 MB) and marked `truncated`. File
   commands move 64 KB chunks.
8. **The built-in commands are Muse's four.** `system.run` (argv, no shell unless asked), `file.read` and `file.write`
   (64 KB chunks; a write lands in a part file and replaces the target only on the final chunk), `device.health` (uptime,
   load, memory, disk, temperature where present). They run as the account the SDK runs as, with that account's
   permissions. `fileRoots` restricts `file.*`; `builtins: false` removes all four.
9. **The agent reaches a gadget through one tool, `gadget`.** Actions `list`, `health`, `run`, `show`, `send`, `pair`,
   `revoke`. `run` (except `device.health`), `pair` and `revoke` call `ctx.ask` with permission `gadget` and patterns
   `<device>:<command>`, `pair`, `<device>:revoke`; an unmatched call asks, a deny is a deny, and a denied call never
   reaches the device. `system.run` and `file.write` take any argument, so they offer no "always allow": a stored rule for
   them would allow `rm -rf` as readily as `ls`. A user who wants one writes the rule by hand. Typed failures reach the model as `GadgetError.<tag>: …`.
10. **A device message is a session message.** `POST /devices/:id/message` starts a session titled "Gadget: <name>" or
    continues one **that device started** — a device cannot write into the operator's other sessions — and delivers the text prefixed `[gadget <id>]` through `session.promptAsync`; the answer is
    202 with the session id. At most 60 messages a minute per device, counted whether or not a feed is open (`send` has none), then `RateLimited`
    with `retryAfterMs`. With no
    nikcli instance ready the answer is `Offline`, not a crash.
11. **A button is a UI event.** `POST /devices/:id/event` is delivered as `mod.event` with `component: "Gadget"` and
    `requestId: <id>`, so a mod that drew a `Button` for the gadget answers it as it answers a terminal press; the reply
    says whether it was handled.
12. **A display takes a bounded tree, or finished pixels.** `show` validates the tree against depth 16, 2,000 nodes and
    10,000 characters, and a Box's `gap` and `padding` to whole numbers from 0 to 16 (`treeProblem`) before it is sent;
    layout clamps them again on the device, because layout work grows with them and the bridge runs inside nikcli. A `tree` display lays it out itself (`display.layout`) and draws it
    with a driver (`terminal`, `framebuffer`). A `bitmap` display declares `width` and `height` in pixels (8 to 2048) and an
    optional `scale` (1 to 8); the bridge lays the tree out for the cells that fit, rasterizes it with a built-in 5×7 font and
    sends a `show` frame carrying `{ width, height, format: "1bpp", data }` — rows padded to bytes, most significant bit
    first, base64, 1 = ink — which the SDK unpacks (`display.bitmap`) for the vendor's panel library. A device with no
    font and no layout engine needs neither.
13. **The TUI side is commands and one sidebar block.** The v2 plugin `nikcli:gadgets` declares `commands` and `routes` (the
    capability a slot needs), both supplied by the TUI host, and registers `/gadget` (`list`, `pair`, `health <id>`,
    `send <id> <text>`, `revoke <id>`), a palette entry to pair, and a `sidebar.content` slot that lists paired gadgets with
    their state and draws nothing until one is paired. It reaches the bridge's `/admin` routes, so the TUI must run where the
    server runs.
14. **One bridge per process.** Every project instance that loads the plugin shares a bridge keyed by host and port; the
    last `dispose` stops it. A taken port is recorded and reported by the tool, never thrown from the plugin.
15. **Failures are typed.** `GadgetError.{NotPaired, HelloInvalid, Offline, Busy, Timeout, CommandUnknown, Denied,
PayloadTooLarge, RateLimited, TokenRevoked, PairingClosed, Unconfirmed, BadRequest}`, each with a status and a
    message that renders on its own.

## Wire Protocol

| Operation    | Method and path                   | Auth     | Body / frames                                                              |
| ------------ | --------------------------------- | -------- | -------------------------------------------------------------------------- |
| Info         | `GET /`                           | none     | `{ name, version, protocol, pairing }`                                     |
| Pair         | `POST /pair`                      | the code | `{ code, name, platform, fingerprint, button }` → `{ id, token, confirm }` |
| Confirm      | `POST /pair/confirm`              | token    | `{}`                                                                       |
| Hello        | `PUT /devices/:id/hello`          | token    | `Hello` (replaces the declaration)                                         |
| Feed         | `GET /devices/:id/commands`       | token    | SSE: `hello`, `invoke`, `show`, `message`, `ping`, `bye`                   |
| Result       | `POST /devices/:id/result`        | token    | `{ callID, output, exitCode?, isError?, truncated? }`                      |
| Event        | `POST /devices/:id/event`         | token    | `{ kind: "press" \| "input", key, value? }` → `{ handled }`                |
| Message      | `POST /devices/:id/message`       | token    | `{ text, sessionID? }` → 202 `{ sessionID }`                               |
| List         | `GET /admin/devices`              | loopback | `GadgetInfo[]`                                                             |
| Open pairing | `POST /admin/pair`                | loopback | `{ code, expiresAt, url }`                                                 |
| Tell         | `POST /admin/devices/:id/message` | loopback | `{ text }`                                                                 |
| Health       | `GET /admin/devices/:id/health`   | loopback | `HealthInfo`                                                               |
| Revoke       | `DELETE /admin/devices/:id`       | loopback | `{ ok }`                                                                   |

## Runtime Topology

```text
Device (Bun on a Pi, the C client on a microcontroller, or anything speaking HTTP+SSE)
  @nikcli-ai/gadget  new Gadget → hello, SSE feed, one handler per command, result POST
        │  HTTP + SSE, token nkg_…
        ▼
nikcli process
  @nikcli-ai/plugin-gadgets (server plugin)
    Bridge (own Bun.serve listener, 4097) ── Registry (devices, queue, deadlines, rate limit)
         │ message → client.session.create / promptAsync         ◄─ PluginInput.client
         │ press   → client.mod.event { component: "Gadget" }
    tool `gadget` ── ctx.ask (permission `gadget`) ◄─ rules, tool.check mods
  @nikcli-ai/plugin-gadgets/tui (v2 plugin, `commands`) ── /admin over loopback
```

## Files

- `packages/gadget/linux/src/protocol.ts` — the protocol.
- `packages/gadget/linux/src/gadget.ts`, `transport.ts`, `state.ts`, `cli.ts` — the runtime, the HTTP and SSE client,
  the pairing file, the CLI.
- `packages/gadget/linux/src/commands/`, `display/`, `button/` — built-ins and drivers.
- `packages/gadget/c/` — the C client (`include/nikcli_gadget.h`, `src/`), its POSIX host build, and an ESP-IDF shell that
  has not been compiled.
- `packages/gadget-plugin/src/registry.ts`, `bridge.ts`, `tool.ts`, `index.ts`, `tui.tsx`, `sidebar.tsx` — the plugin.
- `packages/nikcli/test/plugin/gadgets.test.ts` and `packages/nikcli/test/tui/plugin-gadgets.test.ts` — the plugin through
  nikcli's own loader and through the real v2 TUI host.

## Failure and Cancellation

A timeout cancels on both ends: the bridge fails the call with `Timeout` and forgets its id, the SDK aborts the
handler's `signal` (the C client passes the handler a deadline on its own clock). A feed that goes away, is evicted, replaced or revoked fails every call waiting on it with `Offline`
before it is dropped, so a caller is never left awaiting a result the bridge has forgotten. A hello that fails
validation leaves the previous declaration. A message with no instance ready is `Offline`. The SDK reconnects with
bounded backoff and re-sends hello; it stops on `TokenRevoked` and `NotPaired`.

## Security Posture

- A gadget token reaches `/devices/*` and nothing else, and the bridge is not nikcli's server: a device has no route to
  sessions, files or config.
- Tokens are hashed at rest, bound to a fingerprint that identifies and does not authenticate, revocable. A stolen token
  is device impersonation until revoked; the spec does not claim otherwise.
- A command runs on the device, as the device's account. State-changing calls ask the operator on the nikcli side; a
  device cannot ask for itself.
- Everything is bounded: body 4.25 MB, output per command, tree depth and size, 8 queued calls, 60 messages a minute,
  256 frames of lag.
- Like Muse, pairing has no manufacturer attestation: the code and the button prove presence, not identity. The listener
  binds all interfaces by default because devices are on the LAN; `NIKCLI_GADGET_HOST` narrows it. The pairing URL uses
  the address of a physical interface, not Docker's bridge, so the device can reach it.
- The admin routes trust any process on the machine (see requirement 5); they offer no way to run a command or draw.

## Acceptance and Verification

All run without hardware.

- `packages/gadget-plugin/tests/registry.test.ts`: pairing window, expiry, single use and five strikes, button confirm,
  re-pair, token hashing and persistence, fingerprint binding, hello validation, serialization, `Busy`, `Timeout`, late
  result, deadline from send, `Offline` on detach and on a full feed, truncation, replacement, show, rate limit, revoke.
- `packages/gadget-plugin/tests/bridge.test.ts`: the real SDK as the device over HTTP — pair, the four built-ins, a custom
  command and its failure, deadline abort, message, press, display, revoke, routes, loopback-only admin, proxy header,
  typed statuses, body limit, taken port.
- `packages/gadget-plugin/tests/plugin.test.ts` and `tui.test.ts`: the tool, its `ctx.ask` patterns, a denied run that
  never reaches the device, the shared bridge, the host hooks, the TUI commands against a live bridge.
- `packages/gadget/linux/tests`: protocol, display, runtime, commands.
- `packages/nikcli/test/plugin/gadgets.test.ts`: nikcli's `Plugin.Service` loads the plugin from a `file://` spec and a
  real SDK gadget pairs and runs a command through the tool. `packages/nikcli/test/tui/plugin-gadgets.test.ts`: the v2
  TUI host accepts the module, registers the slot and `/gadget pair` shows a code the bridge issued.
  `packages/nikcli/test/tui/gadgets-sidebar.test.tsx`: the sidebar painted by OpenTUI's real Solid renderer — nothing
  before a pairing, one row per device with its state, nothing when the bridge is down.
- Bitmap frames: protocol validation, pack and unpack, scale, the registry sending pixels instead of a tree, and the real
  SDK receiving them over HTTP (`packages/gadget/linux/tests/bitmap.test.ts`, registry and bridge tests).
- The C client, compiled with `-Wall -Wextra -Werror` and AddressSanitizer, UBSan and LeakSanitizer, run as a separate
  process against the real bridge (`packages/gadget-plugin/tests/c-client.test.ts`): pairing with a button, commands and
  their failures, truncation, a handler that stops before its deadline, bitmap frames that span many reads, a frame
  larger than the buffer, messages, presses, a wrong code, revocation, retry while the bridge is down. A sanitizer report
  at exit fails the test.
- One test per review finding: the admin routes refuse a browser's `Origin`, a rebound `Host` and a text/plain body; a
  hostile `padding` or `gap` is refused and clamped; an unconfirmed device reaches nothing; the message limit holds with
  no feed; a device cannot continue a session it did not start; `always` is empty for `system.run` and `file.write`; the
  time allowed is relative; a program that closes its stdin cannot kill the gadget; a hello without the fingerprint is
  refused.
- A smoke with separate processes: a bridge in one, `nikcli-gadget pair` and `run` in another, `send` from a third.

Not verified: any hardware (GPIO, framebuffer, the OBD-II example, `install.sh`), the ESP-IDF shell (never compiled), and
the plugin enabled in a user's `nikcli.json` inside a live TUI session.

## Migration and Rollback

Nothing is on by default: the plugin must be listed in `nikcli.json`. Removing the line, or `NIKCLI_GADGET=0`, removes the
tool and the listener; paired devices stay in `devices.json` and come back when it is re-enabled. Nothing in nikcli's core
changed, so there is nothing to revert.

Later slices, each dependency-gated: per-command tools on registry re-derivation; building and testing the ESP32 shell,
and a libnx shell for a Switch, which would link the C client as is; the nikcli-side mods the permission-beacon and deploy-key examples need; `plugin` options in
`nikcli.json` (a core change, and the reason the bridge reads the environment today).

## Muse ↔ nikcli Mapping

| Muse Gadgets                                     | nikcli                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| SDK token from gadgets.muse.ai                   | `nkg_` token minted by the bridge when the pairing code is entered       |
| Pair in the Muse app, button to confirm          | code from `/gadget pair`, `nikcli-gadget pair`, button when declared     |
| `COMMAND_SPECS` and `Executor.run`               | `commands` in `new Gadget`, JSON Schema args, one handler per command    |
| `system.run`, `file.read/write`, `device.health` | the same four, 64 KB file chunks, same account semantics                 |
| `send-user-msg --session-id`                     | `nikcli-gadget send "…" --session-id`, 202 with the session id           |
| Text and images to the display                   | a bounded tree, or a finished 1-bit bitmap the bridge renders; no images |
| Bluetooth LE pairing                             | HTTP on the LAN; no BLE                                                  |
| Home-network tunnel                              | none: the device reaches nikcli directly                                 |

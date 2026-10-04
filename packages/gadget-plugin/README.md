# @nikcli-ai/plugin-gadgets

The nikcli side of [gadgets](../gadget/README.md): a plugin that adds a bridge devices pair with, a `gadget` tool for the
agent, and `/gadget` commands in the TUI.

## Enable it

In `nikcli.json` (server) and `tui.json` (terminal commands):

```json
{ "plugin": ["@nikcli-ai/plugin-gadgets"] }
```

or drop the package's `src/index.ts` into `~/.config/nikcli/plugins/gadgets/` as a folder plugin.

| Variable                    | Default                                      | What                                              |
| --------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `NIKCLI_GADGET_PORT`        | `4097`                                       | Bridge port. `0` picks a free one.                |
| `NIKCLI_GADGET_HOST`        | `0.0.0.0`                                    | Bind address. Devices are on the LAN.             |
| `NIKCLI_GADGET`             | on                                           | `0` registers nothing.                            |
| `NIKCLI_GADGET_BRIDGE_FILE` | `~/.local/share/nikcli/gadgets/devices.json` | Paired devices (tokens stored hashed, mode 0600). |

`nikcli.json` lists server plugins as bare specifiers, so this is the way to configure the server half; the TUI half takes
`url` in `tui.json` if the bridge is not on `http://127.0.0.1:4097`.

## What it does

- **Bridge.** A listener of its own (not nikcli's server): `POST /pair` with the code, then token-authenticated
  `PUT /devices/:id/hello`, an SSE feed at `GET /devices/:id/commands`, `POST …/result`, `…/event`, `…/message`. One
  command in flight per device, eight waiting behind it, a deadline from the moment a command is sent, a 15 s ping, a feed
  evicted when it is 256 frames behind. `/admin/*` (list, pair, health, message, revoke) answers loopback callers without a proxy header only, refuses what a browser
  sends, and cannot run a command or draw.
- **`gadget` tool.** Actions `list`, `health`, `run`, `show`, `send`, `pair`, `revoke`. `run` (except `device.health`),
  `pair` and `revoke` ask through `ctx.ask` with permission `gadget` and pattern `<device>:<command>`.
- **Messages and presses.** A device message starts a session titled "Gadget: <name>" (or continues one) and is delivered
  with `[gadget <id>]` in front; a press is sent to the mods as `ui.press` with `component: "Gadget"` and
  `requestId: <id>`.
- **`/gadget`** in the TUI: `list`, `pair`, `health <id>`, `send <id> <text>`, `revoke <id>`, plus a palette entry to pair,
  and a "Gadgets" block in the sidebar once one is paired (polls `/admin/devices` every 5 s; draws nothing when none is paired
  or the bridge is unreachable).
- **Bitmap panels.** A gadget that declares `display.format: "bitmap"` (with `width`, `height`, optional `scale`) is sent
  a finished 1-bit image the bridge rendered, instead of a tree.

## Permission rules

```json
{ "permission": { "gadget": { "pi-office:device.health": "allow", "pi-office:*": "ask", "*": "ask" } } }
```

An unmatched call asks. Deny is deny.

## Layout

- `src/registry.ts` — devices, pairing window, tokens, queue, deadlines, rate limit. No sockets.
- `src/bridge.ts` — HTTP and SSE over the registry; `Bun.serve`.
- `src/tool.ts` — the `gadget` tool.
- `src/index.ts` — the server plugin: one bridge per process, shared by every project instance.
- `src/tui.tsx`, `src/sidebar.tsx` — the v2 TUI plugin (manifest: `commands`, `routes`) and the sidebar block.
- `tests/` — registry, bridge with the real SDK, tool and plugin, TUI.

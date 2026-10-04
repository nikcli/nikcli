# nikcli Gadget — Linux SDK

Turn a Raspberry Pi (3B+, 4, 5, Zero 2 W) or any Linux computer into a nikcli gadget: it runs commands for the agent,
pushes messages into sessions, draws on a display and reports button presses. TypeScript on **Bun**, no native
dependencies. (The package ships TypeScript, which Node refuses to run from `node_modules`; a device without Bun can use
the [C client](../c/README.md) instead.)

## Install

On the device:

```sh
curl -fsSL https://bun.sh/install | bash
bunx @nikcli-ai/gadget init                       # writes gadget.ts
bunx @nikcli-ai/gadget pair --server http://<nikcli-host>:4097 --code <code>
bunx @nikcli-ai/gadget run gadget.ts
```

As a service that survives reboots, `install.sh` sets up a systemd unit running as the account you choose, with the
pairing state in `/var/lib/nikcli-gadget`:

```sh
bash install.sh --from . --user pi               # interactive
bash install.sh --from . --user pi --yes          # unattended
```

Commands run as that account, with exactly that account's permissions.

## Pairing

The bridge prints a six-digit code when you ask nikcli to pair a gadget (`/gadget pair` in the TUI, or ask the agent).
The window is open ten minutes. `nikcli-gadget pair` trades the code for a token; a gadget with buttons finishes by
pressing one. The token is stored at `$XDG_STATE_HOME/nikcli-gadget/pairing.json` (0600), or wherever
`NIKCLI_GADGET_STATE` points. `nikcli-gadget status` shows it; `nikcli-gadget unpair` removes it.

## The built-in commands

| Command         | What it does                                                                               |
| --------------- | ------------------------------------------------------------------------------------------ |
| `system.run`    | Runs `argv` (no shell unless you run one) and returns stdout, stderr and the exit code.    |
| `file.read`     | Reads a file 64 KB at a time; the reply carries `size`, `next` and `eof`.                  |
| `file.write`    | Writes 64 KB chunks into `<path>.nikcli-part`; the final chunk renames it over the target. |
| `device.health` | Uptime, load, memory, disk, temperature.                                                   |

`fileRoots` on the gadget restricts `file.*` to directories; `builtins: false` turns all four off.

## Adding a command

```ts
import { Gadget } from "@nikcli-ai/gadget"

export default new Gadget({
  name: "pi-office",
  commands: {
    "ha.toggle": {
      description: "Toggle a Home Assistant entity",
      args: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] },
      timeoutMs: 10_000,
      async run({ entity }, ctx) {
        const res = await fetch(`http://homeassistant.local:8123/api/services/switch/toggle`, {
          method: "POST",
          headers: { authorization: `Bearer ${ctx.env.HA_TOKEN}` },
          body: JSON.stringify({ entity_id: entity }),
          signal: ctx.signal, // aborted at the bridge's deadline
        })
        return { output: `${entity}: ${res.status}`, isError: !res.ok }
      },
    },
  },
})
```

A command is a name (`namespace.name`), a description the agent reads, a JSON Schema for its arguments, optional
`timeoutMs` and `maxOutputBytes`, and `run(args, ctx)`. `ctx.signal` fires at the deadline; `ctx.maxOutputBytes` is the
cut the runtime applies to whatever you return. On the nikcli side every command you declare asks the operator before
it runs, until a rule allows it.

## Displays and buttons

```ts
import { Gadget, display, button } from "@nikcli-ai/gadget"

export default new Gadget({
  display: display.framebuffer({ device: "/dev/fb0", width: 480, height: 320, bytesPerPixel: 2, scale: 3 }),
  buttons: button.gpio({ pins: { ok: 17, next: 27 } }),
})
```

The bridge sends a drawing tree (`Box`, `Text`, `Markdown`, `Code`, `Button`); `display.layout` turns it into lines for
the panel's columns and rows, `display.rasterize` turns lines into 1-bit pixels with the built-in 5×7 font. Reference
drivers: `display.terminal()` (preview, logs) and `display.framebuffer()` (any `/dev/fb*`). For a panel with no layout
engine — an e-paper board, an OLED — use `display.bitmap({ width, height, scale, push })`: the bridge lays the tree out,
rasterizes it with the built-in font and sends a finished 1-bit image (`format: "bitmap"`, rows padded to bytes, most
significant bit first, base64); `push` receives the unpacked pixels and hands them to the vendor's library.

Buttons: `button.keyboard({ keys: { ok: "enter" } })` for development, `button.gpio({ pins })` on a Pi (sysfs, pull-up,
press to ground), `button.all(...)` to combine. A press is posted as `ui.press { key }` and reaches the mods on the nikcli
side.

## Sending a message

```sh
nikcli-gadget send "Front door opened"                     # starts a session titled after the gadget
nikcli-gadget send "…and closed" --session-id ses_01…     # continues it
```

From code: `await gadget.send(text, sessionID)`. Sixty messages a minute per device; past that the bridge answers
`GadgetError.RateLimited` with a `retryAfterMs`.

## Examples

`examples/` holds five gadgets to start from: `permission-beacon.ts`, `deploy-key.ts`, `desk-badge.ts`, `car-obd.ts`,
`home-assistant.ts`. Each file's header says what hardware it expects. They are typechecked, not run on real hardware: expect
to adjust pins, devices and paths.

## Testing

```sh
bun test linux/tests          # no hardware needed
bun run typecheck
```

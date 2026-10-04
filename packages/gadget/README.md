# nikcli Gadgets

Build hardware that works for your nikcli agent. A **gadget** is a device — a Raspberry Pi, a small board, any Linux
machine with a network stack — that pairs with a nikcli server you run, declares what it can do, and from then on:

- **runs commands** the agent calls (`system.run`, `file.read`, `file.write`, `device.health` out of the box, plus any
  you add), each one gated by nikcli's permission rules before it leaves the server;
- **pushes messages** into a session with a button, a sensor or a script (`nikcli-gadget send "…"`);
- **draws** what the agent answers on a display;
- **presses**: a physical button is a `ui.press` event that nikcli's mods can answer.

The shape follows [Muse Gadgets](https://github.com/facebookincubator/muse-gadget-sdk) — a device SDK, pairing with a
code and a button, a handful of built-in commands. The difference that decides everything else: the other end is **your**
nikcli server, on your LAN, with your permission rules. No cloud token, no tunnel.

Two packages, one protocol:

| Package                                          | Where              | What                                                                  |
| ------------------------------------------------ | ------------------ | --------------------------------------------------------------------- |
| `@nikcli-ai/gadget` (this directory)             | on the **device**  | The SDK and the `nikcli-gadget` CLI. TypeScript, runs on Bun.         |
| `@nikcli-ai/plugin-gadgets` (`../gadget-plugin`) | next to **nikcli** | A nikcli plugin: the bridge, the `gadget` tool, `/gadget` in the TUI. |

The wire protocol is one file, [`linux/src/protocol.ts`](linux/src/protocol.ts): JSON over HTTP and one server-sent-events
stream per device. `curl` can pair a device.

## Get started

1. **Enable the plugin** on the machine that runs nikcli. Add it to `nikcli.json`, and to `tui.json` for the `/gadget`
   commands:

   ```json
   { "plugin": ["@nikcli-ai/plugin-gadgets"] }
   ```

   It listens on port **4097** on all interfaces. `NIKCLI_GADGET_PORT`, `NIKCLI_GADGET_HOST` and `NIKCLI_GADGET=0`
   change that; devices are stored in `~/.local/share/nikcli/gadgets/devices.json` (`NIKCLI_GADGET_BRIDGE_FILE`).

2. **Open a pairing window**: `/gadget pair` in the TUI, or ask the agent to pair a gadget (it asks you first). You get a
   six-digit code and the URL; the window stays open ten minutes and the code works once.

3. **Pair the device**:

   ```sh
   bunx @nikcli-ai/gadget pair --server http://192.168.1.10:4097 --code 123456
   bunx @nikcli-ai/gadget run            # serves the four built-in commands
   ```

   A gadget that declares a button finishes pairing by pressing it once. The token lands in
   `~/.local/state/nikcli-gadget/pairing.json` (mode 0600); losing it means pairing again.

4. **Ask the agent**: "what is the load on pi-office?", "show BUILD GREEN on the badge". Commands that change state ask
   you first, in nikcli, before they reach the device.

## What is in here

| Path               | What                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `linux/src/`       | The SDK: `Gadget`, built-in commands, display and button drivers, the transport, the CLI, the protocol.               |
| `linux/tests/`     | Unit tests, no hardware needed.                                                                                       |
| `linux/examples/`  | Five gadgets to start from. **Written against the SDK and typechecked; not run on real hardware.**                    |
| `linux/install.sh` | Installs a gadget as a systemd service (needs Bun). **Not run in CI.**                                                |
| `c/`               | The C client, for devices without Bun: tested on a host against the real bridge. Its `esp32/` shell is **not built**. |

## Project ideas

- **Permission beacon.** A lamp that lights when the agent waits for a permission, and a button that answers. You see the
  ask from across the room. `linux/examples/permission-beacon.ts` is the device half; the nikcli mod that connects it to
  permissions is not included.
- **Deploy key.** A key switch the agent checks before a force-push or a deploy: a mod on `tool.check` would ask the
  gadget `key.state` and refuse while it is not turned. `linux/examples/deploy-key.ts` is the device half; the mod is not
  included.
- **Desk badge.** A framebuffer or e-paper panel showing what the agent is working on. `linux/examples/desk-badge.ts`.
- **Car gadget.** A Pi Zero on the OBD-II port reading RPM, speed, coolant temperature and fault codes.
  `linux/examples/car-obd.ts`. CarPlay and Android Auto are closed platforms; this reads the car and leaves the head unit
  to the phone.
- **Home Assistant hands.** What Muse's Home Link does, in forty lines. `linux/examples/home-assistant.ts`.
- **Homelab watchdog.** `device.health` on every box you own and a restart command behind an ask — the SDK with no code.

Not built, and not claimed: the **ESP32** shell in `c/esp32` has never been compiled (it needs ESP-IDF), and there is no
**Nintendo Switch** shell at all (it would link the same C client and needs devkitPro and libnx). Both are starting points
or ideas, not features.

A smartwatch that runs its own closed firmware (a Redmi Watch, an Apple Watch) cannot be a gadget: it has no way to join
your LAN or run code. It can still show the agent's notifications through the phone's nikcli app.

## Security, in one paragraph

A gadget token is a device credential, not a user: it reaches the bridge's `/devices/*` routes and nothing else, and the
bridge is a separate listener from nikcli's own server. The bridge hashes tokens at rest and binds each to the device's
fingerprint, which identifies the device and does not authenticate it: a stolen token is device impersonation until you
revoke it. The bridge's admin routes (used by the TUI) trust any process on the machine and cannot run a command. A command runs on the device as the device's account; nothing from a device is ever executed inside nikcli.
`run`, `pair` and `revoke` ask before every call unless a permission rule allows them. Pairing proves presence (a code
and, optionally, a button), not identity — the same limit Muse states, stated here too. Anyone on the LAN can reach
`/pair`, which needs the code; set `NIKCLI_GADGET_HOST` to bind a single interface if that is too open.

## Specification

`specs/effect-tui/21-gadgets-device-bridge.md` is the design this implements.

# nikcli Gadgets — for coding agents

`packages/gadget` is the device side (`@nikcli-ai/gadget`); `packages/gadget-plugin` is the nikcli side
(`@nikcli-ai/plugin-gadgets`). The wire protocol is `packages/gadget/linux/src/protocol.ts` and nothing else; the plugin
imports it as `@nikcli-ai/gadget/protocol`, so a change there is a change on both ends at once.

- `linux/AGENTS.md` — the SDK: layout, how to add a command, how to test.
- `../gadget-plugin/AGENTS.md` — the bridge, the tool, the TUI plugin.

Rules that hold across both:

1. **The protocol file is the contract.** Routes, limits, frame shapes and error tags are read from it, never restated.
2. **A device never approves itself.** Permission is decided on the nikcli side (`ctx.ask`, permission id `gadget`).
   Do not add a device-side allowlist that bypasses it.
3. **Bounded everything.** Output is cut at the spec's `maxOutputBytes`, file chunks at 64 KB, deadlines are honoured with
   an `AbortSignal`, feeds reconnect with bounded backoff, the queue per device is eight deep.
4. **No placeholders.** A driver that cannot work on a platform says so with an error, not a stub that succeeds.
5. **Tests run without hardware.** `bun test linux/tests` here, `bun test tests` in the plugin, and
   `bun test test/plugin/gadgets.test.ts test/tui/plugin-gadgets.test.ts` from `packages/nikcli` for the loader.
6. **Do not touch nikcli's core for this.** It is a plugin on purpose: no change to `src/server`, `src/mobile`, `src/mod`.

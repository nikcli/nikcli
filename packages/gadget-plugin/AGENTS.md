# gadget-plugin — for coding agents

The nikcli side of gadgets. Read `../gadget/AGENTS.md` first for the rules that hold across both packages.

- `src/registry.ts` is the logic and has no I/O except the devices file. Every rule in the spec is a test in
  `tests/registry.test.ts` that needs no network. Add a rule there first.
- `src/bridge.ts` is the HTTP layer. It never decides anything the registry should: it parses, authenticates, calls the
  registry, and maps `GadgetError` to a status through `ERROR_STATUS`.
- `src/index.ts` keeps **one bridge per process** keyed by host and port, refcounted across project instances; the last
  `dispose` stops it. A taken port is recorded on the bridge and surfaced by the tool, never thrown from the plugin.
- `src/tool.ts`: anything that changes state calls `ctx.ask` before it acts. A new action that does must too.
- `src/tui.tsx` and `src/sidebar.tsx`: the manifest asks for `commands` and `routes` (a slot needs `routes`), both in
  `TUI_HOST_CAPABILITIES`. The sidebar is TSX compiled by the host's Solid transform; colours are fixed because an external
  plugin has no handle on the theme. The tests here preload `@opentui/solid/preload` (`bunfig.toml`); the render test is
  `packages/nikcli/test/tui/gadgets-sidebar.test.tsx`.
- Never add a route to `/admin` that runs a command or draws: over HTTP it bypasses the `ctx.ask` in `src/tool.ts`, because any
  local process can call it. Those stay in-process, behind the tool.
- Do not import from `packages/nikcli`. The plugin reaches the instance only through `PluginInput.client`.

`nikcli.json` takes bare plugin specifiers; settings are environment variables (see the README).

Test: `bun test tests` and `bunx tsc --noEmit` here; `bun test test/plugin/gadgets.test.ts test/tui/plugin-gadgets.test.ts`
from `packages/nikcli` for the real loader and the real TUI v2 host.

# @nikcli-ai/devhub

Native desktop admin dashboard and developer platform for **nikcli**. It runs on your machine, talks to your
real local nikcli service and your real repository, and never shows placeholder data.

| Area          | What it does                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview      | Service health and latency, host CPU/memory, nikcli process totals, doctor checks, lifetime usage, recent runs                                   |
| Processes     | Every nikcli process and what it spawned (MCP, LSP, shells): CPU, resident/virtual memory, I/O, uptime, terminate/kill                           |
| Tests         | Every test file of every workspace package; runs real `bun test`, streams output, per-test results from bun's junit report, slowest tests       |
| Benchmarks    | Stored benchmark runs with run-vs-run comparison, the recorded perf baseline, live route probes against a real in-process server                 |
| Playground    | **Model bench** (same prompt across models, N runs: median/p95, tokens/s, cost), **endpoint load test** (p50–p99, req/s), **script lab** (Bun)   |
| Telemetry     | Live spans (`telemetry.record`) and bus events over SSE: operations table, trace waterfall, event feed                                           |
| Manage        | Sessions (rename/fork/stop/delete), providers and API keys, MCP servers, agents/skills/commands, effective config (secrets masked)               |
| API console   | Authenticated requests to the nikcli HttpApi with history                                                                                        |
| Activity      | Tokens, cost, tools, models, projects, recent sessions from nikcli analytics                                                                     |
| System        | MCP/LSP status, repository checks (typecheck, route coverage, …), on-disk storage, live logs                                                     |
| Settings      | Account sign-in (device-code flow), theme (every theme of the shared UI, live preview), repository, assistant behaviour                          |
| **Assistant** | A chat panel (⌘J) driven by a real nikcli agent. It is given the live state of the app as context and operates DevHub through typed actions.    |

## Run

```sh
bun run dev            # from packages/devhub: web build in a browser (no native features)
bun run native:dev     # the desktop app (Tauri)
bun run native:build   # bundle
bun test src           # unit tests (+ DEVHUB_LIVE=1 for the live protocol test)
cargo test --manifest-path src-tauri/Cargo.toml
```

DevHub finds the service the same way the TUI does: `~/.local/state/nikcli/service*.json` (+ the channel's
`.password` file). Services whose process is gone are marked _stopped_ and never preferred.
Shortcuts: ⌘1–9 pages, ⌘, settings, ⌘J assistant, ⌘K command palette, ⌘R sample now.

## Decisions

### ADR-1 — Tauri, not Expo / React Native

**Status:** accepted. The product is a local task manager: it must list and signal processes, spawn `bun`,
read logs and the repo, and keep authenticated streams to a local service. That is native-side work where Rust
is direct and Expo has no equivalent. The UI must reuse `@nikcli-ai/ui` (Solid, Kobalte, CSS tokens, the
Liquid-Glass theme), which runs unchanged in a webview and not at all in React Native. The repo already ships
a Tauri app (`packages/desktop`) and the Rust toolchain. Expo stays the right tool for `packages/mobile`.

### ADR-2 — The webview never holds credentials

**Status:** accepted. The channel password and the account token live in 0600 files. Rust reads them, attaches
Basic auth, and proxies requests (`api_request`), the SSE feed (`event_stream`) and the sign-in completion
(`account_complete` stores the token exactly as the TUI does). The webview only ever sees responses. The proxy
only talks to services discovered from the registration files, never to arbitrary hosts. Process signals are
limited to processes classified as nikcli's; task spawning is limited to `bun test|run|x` under the repo.

### ADR-3 — The assistant is nikcli, driven through a typed action protocol

**Status:** accepted. Each message is a turn in a real session of the local service (agent, model, tools,
cost and history are nikcli's own). Every message carries a `<devhub-context>` block with the live state of the
app. The agent answers in prose and may append `devhub-action` JSON blocks. Each block is decoded with an
Effect `Schema.Union` (unknown or malformed actions are reported back to the model, never executed), then run
against a `Host` port (the app's real state and tools). Read-only actions run freely, writes need a click or
auto-run, `kill` always asks; results return to the model as the next turn, capped at six automatic steps.
The shell and fetch tools are withheld from this agent so that what DevHub can do shows up in the app.

### Structure (Effect v4)

`lib/agent.ts` — `Gateway` and `Agent` services (`Context.Service`, tagged `GatewayError`) ·
`lib/actions.ts` — `ActionSchema`, `Host` port, `execute`, prompt and context rendering ·
`lib/modelbench.ts` — model benchmark as an Effect program · `lib/runtime.ts` — the layer graph ·
`lib/events.ts` — live stream store and span analytics · `src-tauri/src` — `service` (discovery, proxy, account),
`sys` (process sampler, pushed over an IPC channel), `tasks` (streamed `bun` runs), `events` (SSE), `repo`,
`shell` (menu bar, tray with live memory, vibrancy).

## Notes

- `.devhub/` at the repo root is scratch space (junit reports, perf probes, playground scripts); it is gitignored.
- The benchmark suite only persists its results when `NIKCLI_BENCHMARK_SAVE=1`; DevHub sets it for you.
- Sign-out and sign-in modify your real account session on this machine, so they were implemented against the
  TUI's own flow but not exercised automatically.

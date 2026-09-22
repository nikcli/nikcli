# nikcli

> **A fork of [OpenCode](https://github.com/anomalyco/opencode)** — the open source coding agent.
> Credit for the original project goes to the OpenCode authors and contributors. nikcli is an
> independent fork, not affiliated with or endorsed by them.

nikcli is a Bun-based AI coding agent combining a terminal UI, an HTTP server API, external service connectors, and a mobile companion app.

nikcli is an AI-powered development tool with connectors, a mobile companion, and a structured CLI command surface.

## Quickstart

```bash
# 1. Install (one of the methods below)
curl -fsSL https://nikcli-ai.dev/install | bash

# 2. Run the TUI
nikcli

# 3. Or run a one-shot prompt from the shell
nikcli run "explain this codebase"
```

Inside the TUI, the one shortcut to remember is **Ctrl+P** — it opens the command palette with every available action, slash command, and provider. From there, the `?` in the bottom-right footer hints shows the same.

| Surface         | Entry               |
| --------------- | ------------------- |
| Terminal UI     | `nikcli` (default)  |
| HTTP API        | `nikcli serve`      |
| Mobile host     | `nikcli mobile`     |
| Remote sessions | `nikcli remote`     |
| Connectors      | `nikcli connectors` |
| Bots            | `nikcli bot`        |

Run `nikcli --help` to see all available commands.

## Install

| Method | Command                                                           |
| ------ | ----------------------------------------------------------------- |
| curl   | `curl -fsSL https://nikcli-ai.dev/install \| bash`                 |
| npm    | `npm install -g nikcli-ai`                                        |
| pnpm   | `pnpm install -g nikcli-ai`                                       |
| bun    | `bun install -g nikcli-ai`                                        |
| brew   | `brew install nikcli` (or `nikomatt69/tap/nikcli` if not on core) |
| scoop  | `scoop install nikcli`                                            |
| choco  | `choco install nikcli`                                            |

`nikcli upgrade` picks the same method you installed with. `nikcli --version` prints the current version without mutating state.

## Development

```bash
bun install
bun dev
```

Local development runs the CLI entrypoint at `packages/nikcli/src/index.ts`.

## Packages

| Package           | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `packages/nikcli` | CLI, TUI, agent engine, server, connectors |
| `packages/mobile` | Expo mobile companion app                  |
| `packages/web`    | Documentation site (nikcli-ai.dev)          |
| `packages/sdk`    | Shared TypeScript SDK                      |

## Resources

- [Documentation](https://nikcli-ai.dev/docs)
- [Configuration reference](https://nikcli-ai.dev/docs/configuration)
- [CLI reference](https://nikcli-ai.dev/docs/cli)

## Specs

In-repo design and roadmap documents live at the repo root (`specs/`, not this package):

- [`specs/README.md`](../../specs/README.md) — catalog, evidence register, and open-payload policy.
- [`specs/ROADMAP.md`](../../specs/ROADMAP.md) — ordered Effect/TUI architecture program (EOT-01 to EOT-10).
- [`docs/sync-architecture.md`](../../docs/sync-architecture.md) — durable per-aggregate sync reference.

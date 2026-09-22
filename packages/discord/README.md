# nikcli Discord Integration

Run nikcli as a Discord bot over the Gateway websocket (discord.js). Mentions
open a thread, DMs are always processed, and sessions persist per thread.

This package is the Socket Mode equivalent of `packages/slack` — a long-running
bun process with channel memory, follow-ups, and `/nikcli-tools`. It is **not**
the thin `@chat-adapter/discord` chatbot path.

## Quick start

1. Open the nikcli TUI.
2. Run `/discord`.
3. Paste your bot token.
4. Open the invite URL it prints, then enable **Message Content Intent**.

That is the supported path. CLI setup below is a fallback.

## CLI fallback

```bash
cd packages/discord
bun run setup    # paste token, optional NIKCLI_URL / OPENROUTER_API_KEY
bun run dev
```

`bun run setup` writes `.env`, looks up the bot user, and prints the invite URL.

## How it behaves

In a Discord channel, mention the bot to start a conversation. Work happens in
a thread. Continue in that thread without mentioning again.

```
@nikcli Write a function to calculate fibonacci
```

- Direct messages are always processed.
- Session share URL is posted in the thread.
- Replies stream live (edit a "Thinking…" message, then chunk at 2000 characters).
- Voice messages / audio attachments are transcribed with Whisper when
  `OPENROUTER_API_KEY` is set.
- Admins manage per-channel tools with `/nikcli-tools list|allow|deny|reset`.

### Claude Tag–style surfaces

- **Channel tagging** — `@nikcli <task>` in any channel; work happens in the thread.
- **Direct messages** — DM the bot to work privately.
- **Channel memory** — remembers salient requests per channel. Toggle with
  `DISCORD_CHANNEL_MEMORY=false`.
- **Autonomous follow-ups** — pings the requester when a long job finishes and
  warns when it is taking unusually long. Toggle with `DISCORD_FOLLOWUPS=false`.
- **Per-channel tool policy** — `/nikcli-tools allow|deny <tool>`. Defaults from
  `DISCORD_DEFAULT_TOOLS`; admins in `DISCORD_ADMIN_USERS`.

## Privileged intent

The bot needs **Message Content Intent**. Without it, Discord closes the Gateway
with error **4014**. Enable it under Developer Portal → your app → Bot →
Privileged Gateway Intents.

## Environment variables

| Variable                      | Required | Description                                                        |
| ----------------------------- | -------- | ------------------------------------------------------------------ |
| `DISCORD_BOT_TOKEN`           | Yes      | Bot token from Developer Portal → Bot                              |
| `DISCORD_CLIENT_ID`           | No       | Derived via `users/@me` if unset                                   |
| `NIKCLI_URL`                  | No       | Remote nikcli server; when unset a local server is started         |
| `NIKCLI_USERNAME`             | No       | Basic Auth username for `NIKCLI_URL`                               |
| `NIKCLI_PASSWORD`             | No       | Basic Auth password for `NIKCLI_URL`                               |
| `OPENROUTER_API_KEY`          | No       | Whisper transcription for voice / audio                            |
| `DISCORD_ALLOWED_CHANNELS`    | No       | Comma-separated channel IDs; empty = all                           |
| `DISCORD_CHANNEL_MEMORY`      | No       | `"false"` disables per-channel memory (default on)                 |
| `DISCORD_CHANNEL_MEMORY_SIZE` | No       | Max remembered requests per channel (default `12`)                 |
| `DISCORD_FOLLOWUPS`           | No       | `"false"` disables autonomous follow-ups (default on)              |
| `DISCORD_FOLLOWUP_SLOW_MS`    | No       | Warn a job is slow after this many ms (default `120000`)           |
| `DISCORD_FOLLOWUP_DONE_MS`    | No       | Only ping on completion if job ran ≥ this many ms (`20000`)        |
| `DISCORD_DEFAULT_TOOLS`       | No       | Workspace tool defaults, e.g. `bash=false,write=false`             |
| `DISCORD_ADMIN_USERS`         | No       | Comma-separated Discord user IDs allowed to run `/nikcli-tools`    |
| `HEALTH_PORT`                 | No       | CLI health server port (default `3000`; not bound in library mode) |

## Library

`@nikcli-ai/discord` can be started from a host process (the nikcli server):

```ts
import { startDiscordBot, stopDiscordBot } from "@nikcli-ai/discord"
import { inviteUrl } from "@nikcli-ai/discord/invite"

await startDiscordBot({ botToken, nikcliUrl, directory })
```

Library mode does not bind `HEALTH_PORT` and does not register `SIGTERM`.

## Deploy

Two deployables live in this package, and they are not interchangeable:

| Surface             | Runs on                | Entry           | Reaches Discord via    |
| ------------------- | ---------------------- | --------------- | ---------------------- |
| Gateway bot         | Railway / Fly / Docker | `src/index.ts`  | websocket (discord.js) |
| Interactions Worker | Cloudflare             | `src/worker.ts` | HTTP webhook           |

The Gateway bot is the full experience — mentions, threads, channel memory,
follow-ups, voice transcription. It needs a persistent websocket, a git working
copy and (in standalone mode) a child `nikcli serve`, so it cannot run on
Cloudflare Workers. The Worker is the slash-command surface only.

### Railway (Gateway bot)

The `discord-bot` service builds `packages/discord/Dockerfile` with the repo
root as build context. Because the repo root already has its own
`railway.toml` for the nikcli server, the service's **Config File Path** must
point at `packages/discord/railway.toml` — otherwise Railway builds
`Dockerfile.serve` instead.

```bash
railway up --service discord-bot --ci
```

Required variable: `DISCORD_BOT_TOKEN`. Leave `NIKCLI_URL` unset to run a local
nikcli server inside the container against the repo cloned by
`docker-entrypoint.sh`, or set it to reach an existing server.

### Cloudflare (Interactions Worker)

```bash
bun run deploy:worker
bun run register                # registers the global /nikcli command
```

Then set the **Interactions Endpoint URL** in the Developer Portal to
`https://discord.nikcli-ai.dev/discord/interactions`. Discord verifies the
endpoint by sending a deliberately invalid signature, so it must be reachable
before you save.

Per-channel state is a Durable Object (`ChannelSession`), one instance per
Discord channel: it holds that channel's nikcli session id and serializes
prompts so two racing interactions cannot fork two sessions.

Worker secrets (`wrangler secret put <NAME>`):

| Secret                     | Required | Description                                   |
| -------------------------- | -------- | --------------------------------------------- |
| `DISCORD_PUBLIC_KEY`       | Yes      | Developer Portal → General Information        |
| `DISCORD_APPLICATION_ID`   | Yes      | Developer Portal → General Information        |
| `NIKCLI_URL`               | Yes      | The Worker has no local agent to fall back on |
| `NIKCLI_TOKEN`             | \*       | Bearer, for a `nikcli mobile serve` host      |
| `NIKCLI_USERNAME`          | \*       | Basic Auth username (default `nikcli`)        |
| `NIKCLI_PASSWORD`          | \*       | Basic Auth password                           |
| `DISCORD_ALLOWED_CHANNELS` | No       | Comma-separated channel IDs                   |

\* Which credential you need depends on how the nikcli server was started.
`nikcli mobile serve` sets `mobileAuthRequired`, which rejects Basic auth
outright and accepts only a bearer — a mobile pairing token, an external
session, or an `nku_` user token. A plain `nikcli serve` takes Basic auth.
Mint a pairing token on the host with `nikcli mobile pair`. When both are set
the bearer wins.

### Other targets

```bash
# Docker (build context = repo root)
docker compose -f packages/discord/docker-compose.yml up --build

# Fly.io
fly deploy --config packages/discord/fly.toml --dockerfile packages/discord/Dockerfile
```

## Development

```bash
cd packages/discord
bun run setup
bun run dev
bun run typecheck
```

## Troubleshooting

### 4014 Disallowed intents

Enable **Message Content Intent**, then restart the bot.

### Slash command `/nikcli-tools` not visible

Global commands can take up to an hour to appear. Kick and re-invite the bot, or
wait. The command is registered on Gateway ready.

### 401 from nikcli

`NIKCLI_USERNAME` / `NIKCLI_PASSWORD` must match the nikcli server. When
`NIKCLI_URL` is unset, this package starts a local server instead.

### Voice transcription not working

Set `OPENROUTER_API_KEY`. Supported audio: mp3, ogg, wav, m4a, webm, plus
Discord voice messages.

## Files

```
packages/discord/
├── src/
│   ├── index.ts             # CLI entry (health + signals)
│   ├── bot.ts               # Library: start/stop Discord Gateway bot
│   ├── worker.ts            # Cloudflare Worker: interactions + ChannelSession DO
│   ├── register-commands.ts # Registers /nikcli for the Worker
│   ├── invite.ts            # Invite URL + token lookup
│   └── setup.ts             # CLI setup wizard
├── Dockerfile               # Gateway bot image (Railway / Fly)
├── wrangler.toml            # Cloudflare Worker config
└── README.md                # This file
```

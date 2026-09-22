# nikcli Slack Integration

Deploy nikcli as a Slack bot using Cloudflare Workers.

## Architecture

```
┌─────────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│  Slack API      │────▶│  Cloudflare Worker       │────▶│  Nikcli Server  │
│                 │     │  nikcli-slack            │     │  (localhost)    │
└─────────────────┘     │  - Basic Auth            │     │  - Port 4096    │
                        │  - KV Session Storage    │     │  - Basic Auth   │
                        │  - Voice Transcription   │     └─────────────────┘
                        └──────────────────────────┘
                                      │
                           ┌──────────▼──────────┐
                           │  cloudflared tunnel │
                           │  (esponi server)    │
                           └─────────────────────┘
```

## Prerequisites

- [Cloudflare Workers](https://workers.cloudflare.com/) account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-update/) installed
- Slack App with Bot Token and Signing Secret
- nikcli server running with Basic Auth

## Quick Start

### 1. Setup nikcli Server

```bash
# Start nikcli server with external access
export NIKCLI_SERVER_PASSWORD="your-secure-password"
export NIKCLI_SERVER_USERNAME="slackbot"
nikcli serve --port 4096 --hostname 0.0.0.0 --mdns
```

### 2. Expose Server to Internet

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Run tunnel (separate terminal)
cloudflared tunnel --url http://localhost:4096

# Output: https://random-name.trycloudflare.com
# Save this URL for NIKCLI_URL
```

### 3. Create Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click "Create New App" → "From an app manifest"
3. Use the manifest below:

```yaml
_metadata:
  major_version: 1
  minor_version: 1
display_information:
  name: nikcli
  description: AI coding assistant for Slack
  background_color: "#1a1a2e"
features:
  bot_user:
    display_name: nikcli
    always_online: true
  assistant_view:
    # AI Assistant panel (the Claude-icon side panel surface)
    assistant_description: AI coding assistant
    suggested_prompts: []
  slash_commands:
    - command: /nikcli-tools
      description: Manage per-channel tool policy (admins)
      usage_hint: "[list | allow <tool> | deny <tool> | reset]"
      should_escape: false
  event_subscriptions:
    enabled: true
    request_url: https://your-worker.workers.dev/slack/events
  interactivity:
    enabled: true
    request_url: https://your-worker.workers.dev/slack/interactive
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write
      - chat:write
      - commands
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - files:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - assistant_thread_started
      - assistant_thread_context_changed
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    placeholder_text: Ask nikcli...
  org_deploy_enabled: false
  # Socket Mode (src/index.ts) needs socket_mode_enabled: true + an app-level
  # token with connections:write. The Cloudflare Worker (src/worker.ts) uses
  # HTTP events instead, so keep this false for the Worker deployment.
  socket_mode_enabled: false
```

4. Install to workspace
5. Copy Bot Token (`xoxb-...`) and Signing Secret

### 4. Deploy Worker

```bash
cd packages/slack

# Create KV namespace for sessions
bunx wrangler kv:namespace create "SESSIONS" --preview=false

# Set secrets
bunx wrangler secret put SLACK_BOT_TOKEN
bunx wrangler secret put SLACK_SIGNING_SECRET
bunx wrangler secret put SLACK_CLIENT_ID
bunx wrangler secret put SLACK_CLIENT_SECRET
bunx wrangler secret put OPENAI_API_KEY
bunx wrangler secret put NIKCLI_URL
bunx wrangler secret put NIKCLI_USERNAME
bunx wrangler secret put NIKCLI_PASSWORD

# Deploy with custom domain (optional)
bunx wrangler deploy src/worker.ts --name nikcli-slack --routes 'slack.nikcli-ai.dev/*'

# Or without custom domain
# bunx wrangler deploy src/worker.ts --name nikcli-slack
```

### 5. Update Slack App URLs

After deployment, update your Slack app:

- **Event Subscriptions URL**: `https://slack.nikcli-ai.dev/slack/events`
- **Interactivity URL**: `https://slack.nikcli-ai.dev/slack/interactive`

Reinstall the app.

## Environment Variables

| Variable                    | Required | Description                                                   |
| --------------------------- | -------- | ------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`           | Yes      | Bot OAuth Token (`xoxb-...`)                                  |
| `SLACK_SIGNING_SECRET`      | Yes      | Slack signing secret                                          |
| `SLACK_CLIENT_ID`           | No       | Slack OAuth Client ID (for /slack/install)                    |
| `SLACK_CLIENT_SECRET`       | No       | Slack OAuth Client Secret (for /slack/install)                |
| `SLACK_APP_TOKEN`           | No       | Required only for Socket Mode (`bun run dev`)                 |
| `OPENAI_API_KEY`            | No       | OpenAI API for voice transcription                            |
| `NIKCLI_URL`                | Yes      | Your nikcli server URL                                        |
| `NIKCLI_USERNAME`           | No       | Basic Auth username (default: `nikcli`)                       |
| `NIKCLI_PASSWORD`           | Yes      | Basic Auth password (`NIKCLI_SERVER_PASSWORD`)                |
| `GITHUB_TOKEN`              | No       | GitHub token for GitHub Actions mode                          |
| `GITHUB_REPO`               | No       | GitHub repo (e.g., `owner/repo`) for Actions                  |
| `GITHUB_ACTIONS_MODE`       | No       | Set to `"true"` to use GitHub Actions instead of direct API   |
| `SLACK_CHANNEL_MEMORY`      | No       | `"false"` disables per-channel memory (default on)            |
| `SLACK_CHANNEL_MEMORY_SIZE` | No       | Max remembered requests per channel (default `12`)            |
| `SLACK_FOLLOWUPS`           | No       | `"false"` disables autonomous follow-ups (default on)         |
| `SLACK_FOLLOWUP_SLOW_MS`    | No       | Warn a job is slow after this many ms (default `120000`)      |
| `SLACK_FOLLOWUP_DONE_MS`    | No       | Only ping on completion if job ran ≥ this many ms (`20000`)   |
| `SLACK_DEFAULT_TOOLS`       | No       | Workspace tool defaults, e.g. `bash=false,write=false`        |
| `SLACK_ADMIN_USERS`         | No       | Comma-separated Slack user IDs allowed to run `/nikcli-tools` |
| `CHANNEL_MEMORY_FILE`       | No       | Path for channel memory store (default `/tmp/...`)            |
| `CHANNEL_TOOLS_FILE`        | No       | Path for channel tool policy store (default `/tmp/...`)       |

## Commands

In Slack, mention the bot to start a conversation:

```
@nikcli Write a function to calculate fibonacci
```

Features:

- Text messages
- Voice message transcription (with `OPENAI_API_KEY`)
- Thread-based sessions (continue conversations in threads)
- Session sharing via URL

### Claude Tag–style surfaces & behaviours

The Socket Mode bot (`src/index.ts`) brings the nikcli agent to Slack the way
Claude Tag does:

- **Channel tagging** — `@nikcli <task>` in any channel; work happens in the thread.
- **Direct messages** — DM the bot to work privately.
- **AI Assistant panel** — open the assistant side panel and chat with nikcli from
  anywhere in Slack. Shows suggested prompts and a live "is thinking…" status.
- **Channel memory** — the bot remembers salient requests per channel (across
  threads) and feeds them back as context on new sessions. Toggle with
  `SLACK_CHANNEL_MEMORY=false`.
- **Autonomous follow-ups** — it pings the requester when a long-running job
  finishes and warns (tagging them) when a job is taking unusually long. Toggle
  with `SLACK_FOLLOWUPS=false`.
- **Per-channel tool policy** — admins restrict which nikcli tools the bot may use
  in each channel via `/nikcli-tools allow|deny <tool>`. Defaults come from
  `SLACK_DEFAULT_TOOLS`; admins are listed in `SLACK_ADMIN_USERS`.

## Development

```bash
# Run locally
bun run dev:worker

# View logs
bunx wrangler tail

# Typecheck
bun run typecheck
```

## Troubleshooting

### Worker not receiving events

- Verify Event Subscriptions URL is correct (`https://slack.nikcli-ai.dev/slack/events`) and uses HTTPS
- Check Slack app has required bot scopes
- Reinstall app after changing scopes

### 401 Unauthorized from nikcli server

- Verify `NIKCLI_USERNAME` and `NIKCLI_PASSWORD` match server config
- Ensure server is running and accessible at `NIKCLI_URL`

### Voice transcription not working

- Verify `OPENAI_API_KEY` is set
- Check audio file format (mp3, ogg, wav, m4a, webm)

### Sessions not persisting

- Verify KV namespace is created and bound in wrangler.toml
- Check worker logs for KV errors

## Files

```
packages/slack/
├── src/
│   ├── index.ts      # Socket Mode (local/VM deployment)
│   └── worker.ts     # Cloudflare Workers Mode
├── wrangler.toml     # Workers configuration
├── Dockerfile        # Socket Mode container
└── README.md         # This file
```

# nikcli Cloudflare Deployment Guide

## Overview

This document describes the complete deployment infrastructure for nikcli on Cloudflare.

## Deployed Resources

### Workers

| Worker         | Domain              | Status    | Environment Variables                   |
| -------------- | ------------------- | --------- | --------------------------------------- |
| `nikcli-slack` | slack.nikcli-ai.dev | ✅ Online | NODE_ENV, CF_REGION, WRANGLER_LOG_LEVEL |
| `nikcli-web`   | nikcli-ai.dev       | ✅ Online | ASSETS binding (dist)                   |

### Pages

| Project      | Domain            | Status    | Build Output |
| ------------ | ----------------- | --------- | ------------ |
| `nikcli-app` | app.nikcli-ai.dev | ✅ Online | dist/        |

### KV Namespaces

| Binding    | ID                               | Purpose                   |
| ---------- | -------------------------------- | ------------------------- |
| `SESSIONS` | 9992e7ff32c94e69b14635fee32fff8e | Slack session persistence |

---

## Quick Reference

### Deploy Commands

```bash
# Slack Bot
cd packages/slack
bunx wrangler deploy src/worker.ts --name nikcli-slack --routes 'slack.nikcli-ai.dev/*'

# Website
cd packages/web
bun run build
bunx wrangler deploy

# Web App
cd packages/app
bun run build
bunx wrangler pages deploy dist --project-name=nikcli-app --branch=main
```

### Secrets Management

```bash
# List secrets
bunx wrangler secret list --name nikcli-slack

# Set secret
bunx wrangler secret put SECRET_NAME --name nikcli-slack

# Delete secret
bunx wrangler secret delete SECRET_NAME --name nikcli-slack
```

### Logs

```bash
# Tail logs
bunx wrangler tail --name nikcli-slack
bunx wrangler tail --name nikcli-web
```

---

## Environment Variables

### Slack Worker (`wrangler.toml`)

```toml
[vars]
NODE_ENV = "production"
CF_REGION = "us"
WRANGLER_LOG_LEVEL = "info"
```

**Secrets (set via `wrangler secret put`):**

- `SLACK_BOT_TOKEN` - Bot User OAuth Token (xoxb-...)
- `SLACK_SIGNING_SECRET` - Slack app signing secret
- `SLACK_CLIENT_ID` - Slack OAuth Client ID
- `SLACK_CLIENT_SECRET` - Slack OAuth Client Secret
- `OPENAI_API_KEY` - OpenAI API key for voice transcription (optional)
- `NIKCLI_URL` - URL of nikcli server
- `NIKCLI_USERNAME` - Username for Basic Auth (default: nikcli)
- `NIKCLI_PASSWORD` - Password for Basic Auth

### Web Worker (`wrangler.toml`)

```toml
name = "nikcli-web"
main = "./dist/_worker.js"
compatibility_date = "2025-01-25"

[assets]
directory = "./dist"
binding = "ASSETS"
```

### App Pages (`wrangler.toml`)

```toml
[vars]
NODE_ENV = "production"
CF_REGION = "us"
```

---

## DNS Configuration

| Record              | Type  | Target               | Proxied |
| ------------------- | ----- | -------------------- | ------- |
| nikcli-ai.dev       | A     | Worker               | N/A     |
| nikcli-ai.dev       | A     | Worker               | N/A     |
| slack.nikcli-ai.dev | A     | Worker               | N/A     |
| app.nikcli-ai.dev   | CNAME | nikcli-app.pages.dev | ✅      |
| docs.nikcli-ai.dev  | A     | nikcli-web           | ✅      |

---

## Endpoints

### Slack Bot

| Endpoint                                           | Method | Description          |
| -------------------------------------------------- | ------ | -------------------- |
| `https://slack.nikcli-ai.dev/health`               | GET    | Health check         |
| `https://slack.nikcli-ai.dev/slack/events`         | POST   | Slack Events API     |
| `https://slack.nikcli-ai.dev/slack/interactive`    | POST   | Slack Interactivity  |
| `https://slack.nikcli-ai.dev/slack/install`        | GET    | Slack OAuth install  |
| `https://slack.nikcli-ai.dev/slack/oauth/callback` | GET    | Slack OAuth callback |

### Website

| Endpoint                      | Description   |
| ----------------------------- | ------------- |
| `https://nikcli-ai.dev/`      | Homepage      |
| `https://nikcli-ai.dev/docs/` | Documentation |

### Web App

| Endpoint                     | Description     |
| ---------------------------- | --------------- |
| `https://app.nikcli-ai.dev/` | Web Application |

---

## Troubleshooting

### Worker Not Responding

```bash
# Check health
curl https://slack.nikcli-ai.dev/health

# View logs
bunx wrangler tail --name nikcli-slack

# Check deployment
bunx wrangler deployments list --name nikcli-slack
```

### DNS Not Resolving

```bash
# Check DNS
dig app.nikcli-ai.dev +short

# Verify Cloudflare DNS settings
# Go to: https://dash.cloudflare.com > DNS > Records
```

### CORS Errors

Ensure the following origins are allowed in your CORS configuration:

- `http://localhost:*`
- `http://127.0.0.1:*`
- `https://*.nikcli-ai.dev`

---

## Updating Deployment

### Redeploy Slack Bot

```bash
cd packages/slack
bunx wrangler deploy src/worker.ts --name nikcli-slack --routes 'slack.nikcli-ai.dev/*'
```

### Redeploy Website

```bash
cd packages/web
bun run build
bunx wrangler deploy
```

### Redeploy Web App

```bash
cd packages/app
bun run build
bunx wrangler pages deploy dist --project-name=nikcli-app --branch=main
```

---

## Infrastructure as Code

The project uses SST for infrastructure management. See `infra/` directory for configuration.

```bash
# Deploy infrastructure
bun sst deploy --stage=dev      # Development
bun sst deploy --stage=frank    # Staging
bun sst deploy --stage=production  # Production
```

---

## Cost Estimation

| Resource    | Free Tier            | Paid                |
| ----------- | -------------------- | ------------------- |
| Workers     | 100,000 requests/day | $5/million requests |
| Workers CPU | 10ms/request         | $0.000000288/vcpu-s |
| KV Reads    | 1,000,000/day        | $0.40/million       |
| KV Writes   | 1,000,000/day        | $1.00/million       |
| Pages       | Unlimited bandwidth  | $0.02/GB            |

---

## Security

- All secrets are stored via Cloudflare Secrets
- Workers use HTTPS only
- Basic Auth protects nikcli server access
- CORS is configured for allowed origins only

---

## Support

- Logs: `bunx wrangler tail --name <worker>`
- Dashboard: https://dash.cloudflare.com
- DNS: https://dash.cloudflare.com > DNS
- Workers: https://dash.cloudflare.com > Workers & Pages

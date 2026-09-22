# nikcli Production Deployment

## URLs

| Service          | URL                               | Status |
| ---------------- | --------------------------------- | ------ |
| Website          | https://nikcli-ai.dev              | ✅     |
| Documentation    | https://nikcli-ai.dev/docs         | ✅     |
| Web App          | https://app.nikcli-ai.dev          | ✅     |
| Slack Bot        | https://slack.nikcli-ai.dev        | ✅     |
| Slack Bot Health | https://slack.nikcli-ai.dev/health | ✅     |

## Quick Commands

```bash
# Deploy Slack
cd packages/slack && npx wrangler deploy src/worker.ts --name nikcli-slack --routes 'slack.nikcli-ai.dev/*'

# Deploy Website
cd packages/web && npm run build && npx wrangler deploy

# Deploy Web App
cd packages/app && npm run build && npx wrangler pages deploy dist --project-name=nikcli-app --branch=main

# View Logs
npx wrangler tail --name nikcli-slack
npx wrangler tail --name nikcli-web

# Secrets
npx wrangler secret list --name nikcli-slack
npx wrangler secret put NIKCLI_URL --name nikcli-slack
```

## Configuration

See `packages/slack/DEPLOYMENT.md` for full documentation.

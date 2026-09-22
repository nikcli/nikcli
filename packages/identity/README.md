# `@nikcli-ai/identity` — nikcli Identity issuer

Cloudflare Worker at `auth.nikcli-ai.dev` (staging: `dev.auth.nikcli-ai.dev`) that
issues OAuth 2.1 authorization-code + PKCE (S256) tokens for GitHub and email-code
sign-in, plus the device flow used by the CLI.

## Layout

- `src/index.ts` — Hono app, routes, OAuth metadata, JWKS.
- `src/login.ts` — GitHub OAuth start/finish + email-code request/verify.
- `src/database.ts` — D1 account linking (`auth_methods` by `(provider, subject)`,
  then by verified email, then a new account).
- `src/tokens.ts` — ES256 access JWT, rotating refresh tokens with family
  reuse-detection.
- `src/ui.ts` — login / email-code / device / result pages (CSP `default-src 'none'`,
  inline styles only via a per-response nonce).
- `migrations/0001_identity.sql` — D1 schema (accounts, auth_methods,
  refresh_tokens, device_codes, signing_keys).
- `test/contracts.test.ts` — discovery + key validation + GitHub redirect_uri.
- `test/database.test.ts` — `linkAccount` semantics.

## Local development

```bash
bun install
bun run migrate:local      # bootstraps the local D1 schema
bun run dev                # wrangler dev on http://127.0.0.1:8787
bun test                   # unit tests
bun run typecheck          # wrangler types --check && tsc --noEmit
```

## Required secrets

Set these before deploying — GitHub OAuth and email codes both fail closed when
they are missing.

```bash
# GitHub OAuth App credentials (see "GitHub OAuth App setup" below).
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET

# Optional override for the GitHub OAuth App callback URL (see below).
wrangler secret put GITHUB_REDIRECT_URI
```

Email sending is delivered through Cloudflare Email Sending; enable it on the
zone (`wrangler email sending enable nikcli-ai.dev`) before going live.

## GitHub OAuth App setup

GitHub's OAuth App must list the issuer's `/callback/github` URL verbatim in
its **Authorization callback URL** field at
https://github.com/settings/developers. GitHub performs an exact string match,
so the registered URL must equal the `redirect_uri` sent by this worker
character-for-character — otherwise GitHub refuses with
_"The redirect_uri is not associated with this application"_ and sign-in
cannot start.

| Environment | ISSUER                           | Default `redirect_uri` sent to GitHub            |
| ----------- | -------------------------------- | ------------------------------------------------ |
| production  | `https://auth.nikcli-ai.dev`     | `https://auth.nikcli-ai.dev/callback/github`     |
| staging     | `https://dev.auth.nikcli-ai.dev` | `https://dev.auth.nikcli-ai.dev/callback/github` |

If the registered callback on the GitHub OAuth App differs (tenant-scoped
subdomain, custom path, etc.), pin it with the `GITHUB_REDIRECT_URI` Worker
secret. The worker reads it in both `startGitHub` (authorize redirect) and
`finishGitHub` (token exchange) so the two sides always agree.

Required OAuth App scopes:

- `read:user` — `/user` profile (id, login, avatar)
- `user:email` — `/user/emails` to find the verified primary email

The account is linked to the verified primary email; users without a verified
primary email are sent to a result page telling them to verify their GitHub
email first.

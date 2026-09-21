#!/bin/sh
set -e

# Working repository the bot operates on. Cloned fresh on first start and
# fast-forwarded on restarts. Public by default; set GITHUB_TOKEN to clone a
# private repo and/or to push.
WORKDIR="${NIKCLI_WORKDIR:-/workspace/nikcli}"
REPO_URL="${NIKCLI_REPO_URL:-https://github.com/nikcli/nikcli}"

# If a token is provided, embed it so git can clone/push.
if [ -n "$GITHUB_TOKEN" ]; then
  AUTH_URL=$(printf '%s' "$REPO_URL" | sed -E "s#https://#https://x-access-token:${GITHUB_TOKEN}@#")
  git config --global credential.helper store >/dev/null 2>&1 || true
  git config --global user.email "${GIT_AUTHOR_EMAIL:-bot@nikcli.local}" >/dev/null 2>&1 || true
  git config --global user.name "${GIT_AUTHOR_NAME:-nikcli bot}" >/dev/null 2>&1 || true
else
  AUTH_URL="$REPO_URL"
fi

if [ -d "$WORKDIR/.git" ]; then
  echo "Updating repo at $WORKDIR ..."
  git -C "$WORKDIR" remote set-url origin "$AUTH_URL" >/dev/null 2>&1 || true
  git -C "$WORKDIR" fetch --depth=1 origin >/dev/null 2>&1 || true
  git -C "$WORKDIR" reset --hard origin/HEAD >/dev/null 2>&1 || git -C "$WORKDIR" pull --ff-only || true
else
  echo "Cloning $REPO_URL into $WORKDIR ..."
  rm -rf "$WORKDIR"
  mkdir -p "$(dirname "$WORKDIR")"
  git clone --depth=1 "$AUTH_URL" "$WORKDIR" || echo "WARNING: clone failed; bot will run but the agent has no working repo"
fi

export NIKCLI_WORKDIR="$WORKDIR"
echo "Bot working directory: $NIKCLI_WORKDIR"

exec bun run --cwd /app/packages/slack src/index.ts

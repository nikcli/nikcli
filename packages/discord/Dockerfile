# Discord Gateway bot (discord.js websocket).
#
# The install stage mirrors Dockerfile.serve — same workspace manifest set and
# the same stubs for workspace members that are not built here — because
# packages/nikcli depends on @nikcli-ai/tui, @nikcli-ai/tui-math and friends as
# `workspace:*`, so `bun install` fails if any of them is missing.
#
# With NIKCLI_URL set the bot talks to a remote nikcli server and never spawns
# one locally; the nikcli source below is what makes the standalone mode (no
# NIKCLI_URL) work.
FROM oven/bun:1.4.2-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Root workspace manifest + lockfile
COPY package.json bun.lock ./
COPY patches patches

# Package manifests (dep cache layer)
COPY packages/nikcli/package.json packages/nikcli/
COPY packages/script/package.json packages/script/
COPY packages/util/package.json packages/util/
COPY packages/sdk/js/package.json packages/sdk/js/
COPY packages/remote/package.json packages/remote/
COPY packages/plugin/package.json packages/plugin/
COPY packages/companion/package.json packages/companion/
COPY packages/discord/package.json packages/discord/
COPY packages/auth/package.json packages/auth/
COPY packages/llm/package.json packages/llm/
COPY packages/http-recorder/package.json packages/http-recorder/
COPY packages/httpapi-codegen/package.json packages/httpapi-codegen/
COPY packages/simulation/package.json packages/simulation/
COPY packages/tui/package.json packages/tui/
COPY packages/tui-image/package.json packages/tui-image/
COPY packages/tui-math/package.json packages/tui-math/
COPY packages/browser-control/package.json packages/browser-control/
COPY packages/computer-use/package.json packages/computer-use/

# Stub package.json for workspace packages not built in this image. slack,
# identity, terminal-control and github sit outside packages/nikcli's
# workspace closure and nothing under src imports them; stubbing keeps the
# workspace members that bun.lock knows about while skipping their npm deps
# (@slack/bolt, jose, @octokit/*, @ffmpeg-installer/ffmpeg).
RUN set -e; \
    for entry in \
      "packages/app:@nikcli-ai/app" \
      "packages/bench-tui:@nikcli-ai/bench-tui" \
      "packages/cloud:@nikcli-ai/cloud" \
      "packages/companion/ui:@nikcli-ai/companion-ui" \
      "packages/console/app:@nikcli-ai/console-app" \
      "packages/console/core:@nikcli-ai/console-core" \
      "packages/console/function:@nikcli-ai/console-function" \
      "packages/console/mail:@nikcli-ai/console-mail" \
      "packages/console/resource:@nikcli-ai/console-resource" \
      "packages/desktop:@nikcli-ai/desktop" \
      "packages/enterprise:@nikcli-ai/enterprise" \
      "packages/function:@nikcli-ai/function" \
      "packages/identity:@nikcli-ai/identity" \
      "packages/inference:@nikcli-ai/inference" \
      "packages/inference-dashboard:@nikcli-ai/inference-dashboard" \
      "packages/mobile:@nikcli-ai/mobile" \
      "packages/nikcli-island:@nikcli-ai/nikcli-island" \
      "packages/plugin/plugins/agent-memory:@nikcli-ai/plugin-agent-memory" \
      "packages/plugin/plugins/background-agents:@nikcli-ai/plugin-background-agents" \
      "packages/plugin/plugins/background:@nikcli-ai/plugin-background" \
      "packages/plugin/plugins/context-analysis:@nikcli-ai/plugin-context-analysis" \
      "packages/plugin/plugins/direnv:@nikcli-ai/plugin-direnv" \
      "packages/plugin/plugins/dynamic-context-pruning:@nikcli-ai/plugin-dynamic-context-pruning" \
      "packages/plugin/plugins/envsitter-guard:@nikcli-ai/plugin-envsitter-guard" \
      "packages/plugin/plugins/handoff:@nikcli-ai/plugin-handoff" \
      "packages/plugin/plugins/safety-net:@nikcli-ai/plugin-safety-net" \
      "packages/plugin/plugins/smart-title:@nikcli-ai/plugin-smart-title" \
      "packages/remote/web-client:@nikcli-ai/remote-client" \
      "packages/sdk-next:@nikcli-ai/sdk-next" \
      "packages/slack:@nikcli-ai/slack" \
      "packages/terminal-control:@nikcli-ai/terminal-control" \
      "packages/ui:@nikcli-ai/ui" \
      "packages/web:@nikcli-ai/web" \
      "packages/webrenderer:@opentui/webrenderer" \
      "github:github" \
    ; do \
      dir="${entry%%:*}"; name="${entry##*:}"; \
      mkdir -p "/app/$dir" && \
      printf '{"name":"%s","version":"0.0.0","private":true}\n' "$name" > "/app/$dir/package.json"; \
    done

RUN bun install

# Full source
COPY packages/nikcli packages/nikcli
COPY packages/script packages/script
COPY packages/util packages/util
COPY packages/sdk/js packages/sdk/js
COPY packages/remote packages/remote
COPY packages/plugin packages/plugin
COPY packages/companion packages/companion
COPY packages/discord packages/discord
COPY packages/auth packages/auth
COPY packages/llm packages/llm
COPY packages/http-recorder packages/http-recorder
COPY packages/httpapi-codegen packages/httpapi-codegen
COPY packages/simulation packages/simulation
COPY packages/tui packages/tui
COPY packages/tui-image packages/tui-image
COPY packages/tui-math packages/tui-math
COPY packages/browser-control packages/browser-control
COPY packages/computer-use packages/computer-use

RUN mkdir -p /app/repos

# The SDK's createNikcli spawns `nikcli serve` in standalone mode. The published
# bin is a node launcher that needs a prebuilt platform binary; in-container we
# run nikcli straight from source via bun instead. Run from the nikcli package
# dir so bun picks up its tsconfig (jsxImportSource=@opentui/solid); otherwise
# bun defaults JSX to react.
RUN printf '#!/bin/sh\ncd /app/packages/nikcli && exec bun --conditions=browser ./src/index.ts "$@"\n' > /usr/local/bin/nikcli \
    && chmod +x /usr/local/bin/nikcli

ENV PATH="/app/node_modules/.bin:${PATH}"
ENV HEALTH_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
    CMD curl -sf "http://127.0.0.1:${HEALTH_PORT:-3000}/health" || exit 1

# Entrypoint clones the working repo (nikcli/nikcli) then starts the bot.
COPY packages/discord/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

CMD ["/usr/local/bin/docker-entrypoint.sh"]

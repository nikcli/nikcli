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
COPY packages/slack/package.json packages/slack/
COPY packages/discord/package.json packages/discord/
COPY packages/identity/package.json packages/identity/
COPY packages/auth/package.json packages/auth/
COPY packages/llm/package.json packages/llm/
COPY packages/tui-image/package.json packages/tui-image/
COPY packages/webrenderer/package.json packages/webrenderer/
COPY packages/http-recorder/package.json packages/http-recorder/
COPY packages/httpapi-codegen/package.json packages/httpapi-codegen/
COPY packages/simulation/package.json packages/simulation/
COPY packages/terminal-control/package.json packages/terminal-control/
COPY packages/browser-control/package.json packages/browser-control/
COPY packages/computer-use/package.json packages/computer-use/
# Explicit workspace member referenced by root package.json
COPY github/package.json github/

RUN bun install

# Full source
COPY packages/nikcli packages/nikcli
COPY packages/script packages/script
COPY packages/util packages/util
COPY packages/sdk packages/sdk
COPY packages/remote packages/remote
COPY packages/plugin packages/plugin
COPY packages/companion packages/companion
COPY packages/slack packages/slack
COPY packages/identity packages/identity
COPY packages/auth packages/auth
COPY packages/llm packages/llm
COPY packages/tui-image packages/tui-image
COPY packages/webrenderer packages/webrenderer
COPY packages/http-recorder packages/http-recorder
COPY packages/httpapi-codegen packages/httpapi-codegen
COPY packages/simulation packages/simulation
COPY packages/terminal-control packages/terminal-control
COPY packages/browser-control packages/browser-control
COPY packages/computer-use packages/computer-use

RUN mkdir -p /app/repos

# The SDK's createNikcli spawns `nikcli serve`. The published bin is a node
# launcher that needs a prebuilt platform binary; in-container we run nikcli
# straight from source via bun instead.
# Run from the nikcli package dir so bun picks up its tsconfig
# (jsxImportSource=@opentui/solid); otherwise bun defaults JSX to react.
RUN printf '#!/bin/sh\ncd /app/packages/nikcli && exec bun --conditions=browser ./src/index.ts "$@"\n' > /usr/local/bin/nikcli \
    && chmod +x /usr/local/bin/nikcli

ENV PATH="/app/node_modules/.bin:${PATH}"

# Entrypoint clones the working repo (nikcli/nikcli) then starts the bot.
COPY packages/slack/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

CMD ["/usr/local/bin/docker-entrypoint.sh"]

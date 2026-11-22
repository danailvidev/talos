FROM oven/bun:1.3.9-slim@sha256:8ca06c7812d9050ccc4b80799685f395d6a0d051d3b7207dfd120e2b437b1ec9 AS app-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.9-slim@sha256:8ca06c7812d9050ccc4b80799685f395d6a0d051d3b7207dfd120e2b437b1ec9 AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM app-dependencies AS web-build
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
COPY shared/ /app/shared/
COPY rebranding/ /app/rebranding/
RUN bun run build

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ARG BUILD_REVISION=unknown
ARG BUILD_SOURCE=https://gitlab.com/example-org/tools/talos
LABEL org.opencontainers.image.source=$BUILD_SOURCE \
    org.opencontainers.image.revision=$BUILD_REVISION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && npm install --global @anthropic-ai/claude-code@2.1.296 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /var/lib/apt/lists/*
COPY --from=app-dependencies /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
COPY --chown=10001:10001 package.json ./
COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 shared ./shared
COPY --chown=10001:10001 images ./images
COPY --chown=10001:10001 config/workflows.example.yaml /data/workflows.yaml
COPY --chown=10001:10001 --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=10001:10001 --from=web-build /app/web/dist ./web/dist

RUN groupadd --gid 10001 talos \
    && useradd --uid 10001 --gid talos --home-dir /data/home --no-create-home talos \
    && mkdir -p /data/home \
    && chown -R talos:talos /data

ENV HOST=0.0.0.0 \
    PORT=4317 \
    HOME=/data/home \
    TALOS_CONFIG=/data/workflows.yaml \
    TALOS_UI_DIR=/app/web/dist

USER talos
VOLUME ["/data"]
EXPOSE 4317
CMD ["bun", "run", "src/server.ts"]

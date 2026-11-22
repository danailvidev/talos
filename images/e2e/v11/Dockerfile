FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG BUILD_REVISION=unknown
ARG BUILD_SOURCE=https://gitlab.com/example-org/tools/talos
LABEL org.opencontainers.image.source=$BUILD_SOURCE \
    org.opencontainers.image.revision=$BUILD_REVISION
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/talos && cd /opt/talos \
    && npm init -y >/dev/null \
    && npm install @anthropic-ai/claude-code@2.1.296 @playwright/mcp@0.0.83 playwright@1.62.1 @aws-sdk/client-s3@3.1149.0 \
    && ./node_modules/.bin/playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
      /root/.npm /var/lib/apt/lists/*
RUN mkdir -p /home/talos /workspace && chmod 1777 /home/talos /workspace
COPY entrypoint.mjs /opt/talos/entrypoint.mjs
ENTRYPOINT ["node", "/opt/talos/entrypoint.mjs"]

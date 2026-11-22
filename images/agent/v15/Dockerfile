FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG BUILD_REVISION=unknown
ARG BUILD_SOURCE=https://gitlab.com/example-org/tools/talos
LABEL org.opencontainers.image.source=$BUILD_SOURCE \
    org.opencontainers.image.revision=$BUILD_REVISION
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2.1.296 \
    && npm install -g npm@12.2.0 \
    && npm install --prefix /tmp/npm-security-patches \
      brace-expansion@5.0.11 undici@6.28.1 \
    && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/undici \
    && cp -a /tmp/npm-security-patches/node_modules/brace-expansion \
      /tmp/npm-security-patches/node_modules/undici \
      /usr/local/lib/node_modules/npm/node_modules/ \
    && rm -rf /tmp/npm-security-patches \
    && npm --version
RUN mkdir -p /home/talos /workspace /cache/git /cache/packages \
    && chmod 1777 /home/talos /workspace /cache/git /cache/packages
ENV NPM_CONFIG_PREFIX=/home/talos/.npm-global
ENV PATH=/home/talos/.npm-global/bin:$PATH
COPY entrypoint.sh /entrypoint.sh
COPY refresh-git-cache.sh /refresh-git-cache.sh
RUN chmod +x /entrypoint.sh /refresh-git-cache.sh
ENTRYPOINT ["/entrypoint.sh"]

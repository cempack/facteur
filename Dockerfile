# Facteur: runs TypeScript directly (Node strips types), no build step.
# Debian slim, because Proton's pass-cli is linked against glibc.
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error

FROM node:26-slim AS passcli
# Proton Pass CLI, pinned and checked against Proton's published hashes
# (https://proton.me/download/pass-cli/versions.json)
ARG PASS_CLI_VERSION=2.7.0
ARG PASS_CLI_SHA256_ARM64=93918d5621593cac88956854d0f52cbc43851dcd9c01840ffe48a88b3be84c6b
ARG PASS_CLI_SHA256_AMD64=fd933e76179a5a33b295853e9c6696e49e584fe2141b1aafc63a3d78c0791cdb
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in \
      arm64) arch=aarch64; sum=$PASS_CLI_SHA256_ARM64 ;; \
      amd64|"") arch=x86_64; sum=$PASS_CLI_SHA256_AMD64 ;; \
      *) echo "unsupported arch $TARGETARCH" && exit 1 ;; \
    esac \
 && curl -fsSL -o /pass-cli "https://proton.me/download/pass-cli/${PASS_CLI_VERSION}/pass-cli-linux-${arch}" \
 && echo "${sum}  /pass-cli" | sha256sum -c - \
 && chmod 755 /pass-cli

FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8080 \
    FACTEUR_DATA_DIR=/data
WORKDIR /app
COPY --from=passcli /pass-cli /usr/local/bin/pass-cli
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# OAuth state and the audit log live in /data; mount a volume there
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "src/main.ts"]

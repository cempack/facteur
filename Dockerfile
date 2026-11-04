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

FROM node:26-slim AS drive
# Proton Drive CLI, pinned and checked against Proton's published SHA-512
# (https://proton.me/download/drive/cli/version.json)
ARG PROTON_DRIVE_VERSION=0.9.0
ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in \
      arm64) plat=linux-arm64; sha512=c8d5a6b174e57f06d05cb5483400b9963faf58e743b6b33706bb73ecff718047ffce6b439994255b94b5b226b90d2e91bef7418ec96c1c3f5d8bf39b6cd01321 ;; \
      amd64|"") plat=linux-x64; sha512=3533025ba69ae112b64e3e01fbcc1ad0688136a4043f6cf6a72886967d85fdcd9ec235479c2e113171614be5225bfba93427509a05ca5aa6071d924fa7e91ca8 ;; \
      *) echo "no proton-drive build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; apt-get install -y --no-install-recommends ca-certificates curl; \
    curl -fsSL -o /proton-drive "https://proton.me/download/drive/cli/${PROTON_DRIVE_VERSION}/${plat}/proton-drive"; \
    echo "${sha512}  /proton-drive" | sha512sum -c -; \
    chmod 0755 /proton-drive

FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8080 \
    FACTEUR_DATA_DIR=/data \
    PROTON_DRIVE_CACHE_DIR=/data/drive \
    PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file \
    PROTON_DRIVE_LOG_LEVEL=WARNING
WORKDIR /app
COPY --from=passcli /pass-cli /usr/local/bin/pass-cli
COPY --from=drive /proton-drive /usr/local/bin/proton-drive
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# OAuth state and the audit log live in /data; mount a volume there
RUN mkdir -p /data/drive && chown -R node:node /data && chmod 700 /data/drive
USER node
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "src/main.ts"]

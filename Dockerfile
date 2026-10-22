# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# The base images are pinned to the digest behind each tag (multi-arch manifest
# lists). Dependabot moves the pins; to do it by hand:
#   docker buildx imagetools inspect node:24-trixie-slim

# 1. Browser bundles: webpack writes them to static/js/dist.
FROM node:25-trixie-slim@sha256:aabbe39553d15ede8a97cc60c9e1a97034ff772afcf696ea42b94e7f5f2ec71b AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY webpack.config.js ./
COPY js ./js
RUN npm run build

# 2. Server. build.rs would run npm itself; the bundles from stage 1 are used
# instead (it still hashes them for cache busting).
FROM rust:1-trixie@sha256:931c2c0531a8b143e044f0f3914dfe802f15bb3d1955f0b657e9359327ac2ffc AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
# The rest of the Cargo workspace: the format crate the server uses, and the
# client, whose manifest the workspace needs.
COPY crates ./crates
COPY cli ./cli
COPY --from=web /src/static/js/dist ./static/js/dist
ENV SKIP_NPM_BUILD=1
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p e2epaste \
    && cp target/release/e2epaste /usr/local/bin/e2epaste

# 3. Runtime image.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
RUN groupadd --system --gid 10001 e2epaste \
    && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin e2epaste \
    && mkdir /data && chown e2epaste:e2epaste /data
WORKDIR /app
COPY Rocket.toml ./
COPY templates ./templates
COPY static ./static
COPY --from=web /src/static/js/dist ./static/js/dist
COPY --from=server /usr/local/bin/e2epaste /usr/local/bin/e2epaste

# Set ROCKET_SITE_URL to the site's public https:// address.
#
# ROCKET_ADDRESS=0.0.0.0 makes the server answer on every interface inside the
# container, so that the port can be published at all. Publish it only on
# 127.0.0.1 (-p 127.0.0.1:8001:8001, as docker-compose.yml does) with a reverse
# proxy in front: the rate limits trust the proxy's X-Real-IP header, and
# browsers won't run the encryption on plain HTTP.
ENV ROCKET_ADDRESS=0.0.0.0 \
    ROCKET_PORT=8001 \
    ROCKET_DATA_DIR=/data
USER e2epaste
# The only path written at run time: the paste database and attachments.
VOLUME /data
EXPOSE 8001
# The image has no curl; bash's /dev/tcp fetches /api/limits instead and
# passes when the server answers 200. docker-compose.yml runs the same check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8001 && printf 'GET /api/limits HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' >&3 && read -r status <&3 && case \"$status\" in *' 200 '*) exit 0;; esac; exit 1"]
CMD ["e2epaste"]

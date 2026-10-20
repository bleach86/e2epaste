# syntax=docker/dockerfile:1

# 1. Browser bundles: webpack writes them to static/js/dist.
FROM node:24-trixie-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY webpack.config.js ./
COPY js ./js
RUN npm run build

# 2. Server. build.rs would run npm itself; the bundles from stage 1 are used
# instead (it still hashes them for cache busting).
FROM rust:1-trixie AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY --from=web /src/static/js/dist ./static/js/dist
ENV SKIP_NPM_BUILD=1
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked \
    && cp target/release/e2epaste /usr/local/bin/e2epaste

# 3. Runtime image.
FROM debian:trixie-slim
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
ENV ROCKET_ADDRESS=0.0.0.0 \
    ROCKET_PORT=8001 \
    ROCKET_DATA_DIR=/data
USER e2epaste
VOLUME /data
EXPOSE 8001
CMD ["e2epaste"]

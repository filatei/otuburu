# ── Stage 1: build ───────────────────────────────────────────────────────────
# Rust 1.89 — bumped from 1.86 because home@0.5.12 (transitive dep,
# pulled in by sqlx-postgres → ... → home) requires >= 1.88. Picked
# 1.89 for headroom; bookworm slim still tracks 1.86 in apt so we
# rely on the published rust image rather than the distro.
FROM rust:1.89-slim-bookworm AS builder

# protoc is required by tonic-build at compile time
RUN apt-get update \
 && apt-get install -y --no-install-recommends protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Cache dependency fetch separately from source compilation
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY src/   src/
COPY build.rs ./
COPY proto/  proto/

RUN cargo build --release --bin otuburu-engine

# ── Stage 2: minimal runtime ──────────────────────────────────────────────────
# debian:12-slim provides glibc (needed by Rust binary) + nc for healthchecks.
FROM debian:12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/otuburu-engine /otuburu-engine

ENV ENGINE_GRPC_ADDR=0.0.0.0:9090 \
    RUST_LOG=otuburu_engine=info,warn

EXPOSE 9090

ENTRYPOINT ["/otuburu-engine"]

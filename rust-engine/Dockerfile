# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM rust:1.78-slim-bookworm AS builder

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
FROM gcr.io/distroless/cc-debian12

COPY --from=builder /build/target/release/otuburu-engine /otuburu-engine

ENV ENGINE_GRPC_ADDR=0.0.0.0:9090 \
    RUST_LOG=otuburu_engine=info,warn

EXPOSE 9090

ENTRYPOINT ["/otuburu-engine"]

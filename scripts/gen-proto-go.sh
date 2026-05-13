#!/usr/bin/env bash
# Generate Go protobuf + gRPC stubs from proto/engine.proto.
# Run from anywhere — uses repo-relative paths.
#
# Prerequisites (one-time):
#   go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.34.2
#   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.5.1
#   brew install protobuf   (macOS) | apt-get install protobuf-compiler (Linux)
#
# Re-run whenever proto/engine.proto changes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_SRC="$REPO_ROOT/rust-engine/proto"
OUT_DIR="$REPO_ROOT/go-services/gateway/internal/enginepb"

mkdir -p "$OUT_DIR"

echo "==> Generating Go proto stubs from $PROTO_SRC/engine.proto"

protoc \
  --proto_path="$PROTO_SRC" \
  --go_out="$OUT_DIR" \
  --go_opt=paths=source_relative \
  --go_opt=Mengine.proto=otuburu.money/gateway/internal/enginepb \
  --go-grpc_out="$OUT_DIR" \
  --go-grpc_opt=paths=source_relative \
  --go-grpc_opt=Mengine.proto=otuburu.money/gateway/internal/enginepb \
  engine.proto

echo "==> Generated:"
ls -1 "$OUT_DIR"/*.go

echo ""
echo "Next: cd go-services/gateway && go mod tidy && go build ./..."

#!/bin/bash
set -e

echo "Building test zome..."
RUSTFLAGS='--cfg getrandom_backend="custom"' cargo build --release --target wasm32-unknown-unknown

echo "Copying WASM to test directory..."
cp target/wasm32-unknown-unknown/release/test_zome.wasm ../extension/test/test-zome.wasm

echo "✓ Test zome built successfully"
echo "  WASM: ../extension/test/test-zome.wasm"

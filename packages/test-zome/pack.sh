#!/bin/bash
set -e

echo "Building test-zome WASM..."
cd "$(dirname "$0")"

# Build WASM with custom getrandom backend
RUSTFLAGS='--cfg getrandom_backend="custom"' cargo build --release --target wasm32-unknown-unknown

echo "Copying WASM to bundle directory..."
mkdir -p bundle
cp target/wasm32-unknown-unknown/release/test_zome.wasm bundle/test_zome.wasm

echo "Copying manifests..."
cp dna.yaml bundle/dna.yaml
cp happ.yaml bundle/happ.yaml

echo "Packing DNA bundle..."
cd bundle
hc dna pack .

echo "Packing hApp bundle..."
hc app pack .

echo "Copying bundles to test directory..."
cp test-dna.dna ../../extension/test/test.dna
cp test-zome-happ.happ ../../extension/test/test.happ

echo "✓ Test bundles created:"
echo "  - test-dna.dna ($(stat -f%z test-dna.dna 2>/dev/null || stat -c%s test-dna.dna) bytes)"
echo "  - test-zome-happ.happ ($(stat -f%z test-zome-happ.happ 2>/dev/null || stat -c%s test-zome-happ.happ) bytes)"

#!/bin/bash
set -e

# Build a membrane-proof-gated .happ bundle.
#
# The authorizer keypair was created from these seed words:
#   indoor clutch chicken nurse inhale close feel type school sweet
#   oyster property balcony city actual erupt before stomach ethics
#   talk pact camera lonely proud
#
# Ed25519 pubkey (base64): c41YjAiTC4HIGu85yZaCLyKDFhYArTFZmRqYSChrzHY=
#
# The progenitor is stored as an array of bytes (the 39-byte AgentPubKey)
# in the DNA properties. The test zome's genesis_self_check reads it.

echo "Building membrane-proof test hApp..."
cd "$(dirname "$0")"

# Ensure WASM is built
if [ ! -f target/wasm32-unknown-unknown/release/test_zome.wasm ]; then
  echo "WASM not found. Building..."
  RUSTFLAGS='--cfg getrandom_backend="custom"' cargo build --release --target wasm32-unknown-unknown
fi

# Create bundle directory
mkdir -p bundle-memproof
cp target/wasm32-unknown-unknown/release/test_zome.wasm bundle-memproof/test_zome.wasm

# Generate dna.yaml with progenitor property injected.
# The progenitor is the 39-byte AgentPubKey computed from the Ed25519 key.
# We use a Node.js one-liner to compute it with the correct DHT location.
PROGENITOR_ARRAY=$(node -e "
const { dhtLocationFrom32, HASH_TYPE_PREFIX, HoloHashType } = require('@holochain/client');
const ed25519 = Buffer.from('c41YjAiTC4HIGu85yZaCLyKDFhYArTFZmRqYSChrzHY=', 'base64');
const key = new Uint8Array(39);
key.set(HASH_TYPE_PREFIX[HoloHashType.Agent], 0);
key.set(ed25519, 3);
key.set(dhtLocationFrom32(ed25519), 35);
console.log(JSON.stringify(Array.from(key)));
")

cat > bundle-memproof/dna.yaml << DNAEOF
---
manifest_version: "0"
name: test-dna-memproof

integrity:
  network_seed: "00000000-0000-0000-0000-000000000001"
  properties:
    progenitor: ${PROGENITOR_ARRAY}
  zomes:
    - name: test_zome
      path: test_zome.wasm

coordinator:
  zomes: []
DNAEOF

cp happ-memproof.yaml bundle-memproof/happ.yaml

echo "Packing DNA bundle..."
cd bundle-memproof
hc dna pack .

echo "Packing hApp bundle..."
hc app pack .

echo "Copying bundles to test directory..."
cp test-dna-memproof.dna ../../extension/test/test-memproof.dna
cp test-zome-memproof-happ.happ ../../extension/test/test-memproof.happ

echo "Done. Test bundles:"
echo "  - test-memproof.dna ($(stat -c%s test-dna-memproof.dna 2>/dev/null || stat -f%z test-dna-memproof.dna) bytes)"
echo "  - test-memproof.happ ($(stat -c%s test-zome-memproof-happ.happ 2>/dev/null || stat -f%z test-zome-memproof-happ.happ) bytes)"

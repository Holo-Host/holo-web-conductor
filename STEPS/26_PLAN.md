# Step 26: Membrane Proof Support

## Goal

Add full membrane proof support to HWC: accepting proofs at install time or deferred, running `genesis_self_check` WASM validation, and exposing the flow through all layers (popup UI, page API, client library).

## Background

Holochain apps use membrane proofs to gate membership. An agent provides a proof (opaque bytes) during cell genesis, which is validated by the DNA's `genesis_self_check` callback. The proof is stored in the `AgentValidationPkg` action (sequence 1 in the genesis chain).

Before this step, HWC:
- Had `membraneProof?: Uint8Array` on `AgentValidationPkgAction` and in the SQLite schema
- Always passed `undefined` for membrane proof during genesis
- Did NOT run `genesis_self_check` at all
- Had no API for providing membrane proofs
- Had no "awaiting memproofs" app state

## Design

### Flow: Immediate Proofs
1. Page calls `installHapp({ ..., membraneProofs: { roleName: proofBytes } })`
2. Extension creates agent key, runs `genesis_self_check` with proof, writes genesis if valid
3. App becomes `enabled` immediately

### Flow: Deferred Proofs
1. DNA manifest has `allow_deferred_memproofs: true`
2. Page calls `installHapp()` without proofs
3. Extension creates agent key, sets status to `awaitingMemproofs`, skips genesis
4. Page (or popup) later calls `provideMemproofs({ memproofs: { roleName: proofBytes } })`
5. Extension runs genesis with proofs, transitions to `enabled` on success

### genesis_self_check Callback
- Instantiates integrity zome WASM, calls `genesis_self_check_2` export (HDI macro convention)
- Serializes `GenesisSelfCheckDataV2 { membrane_proof, agent_key }` via ExternIO
- WASM can call `dna_info()` to read progenitor key from DNA properties
- WASM can call `verify_signature_raw()` to validate proof signature
- If no export exists, returns Valid (open membrane)

### Test Zome Validation Logic
The test zome's `genesis_self_check` reads `progenitor` from DNA properties:
- No progenitor key = open membrane (Valid)
- Progenitor set = requires membrane proof = authorizer's Ed25519 signature of agent's 39-byte pubkey

## Changes

### Part 1: Core Types & Genesis
- `packages/core/src/index.ts` - `HappContextStatus` type (`'enabled' | 'disabled' | 'awaitingMemproofs'`), `status` field on `HappContext`, `membraneProofs` on `InstallHappRequest`
- `packages/core/src/storage/genesis.ts` - Pass through `membraneProof` to `buildAgentValidationPkgAction()`

### Part 2: genesis_self_check Callback Runner
- `packages/core/src/ribosome/genesis-self-check.ts` (new) - `runGenesisSelfCheck()` instantiates WASM, calls versioned export, parses `ValidateCallbackResult`

### Part 3: HappContextManager
- `packages/extension/src/lib/happ-context-manager.ts` - Deferred memproof flow, `provideMemproofs()` method, guard on `setContextEnabled()`
- `packages/extension/src/lib/happ-context-storage.ts` - Persist/retrieve `status` field with backward compat

### Part 4: Messaging & Background
- `packages/extension/src/lib/messaging.ts` - `PROVIDE_MEMPROOFS` message type and `ProvideMemproofsPayload`
- `packages/extension/src/background/index.ts` - Handler for provide memproofs, membraneProofs passthrough on install, status in list/appInfo responses

### Part 5: Page API & Client
- `packages/extension/src/inject/index.ts` - `provideMemproofs()` on `window.holochain`
- `packages/client/src/WebConductorAppClient.ts` - `provideMemproofs()` method
- `packages/client/src/types.ts` - Updated `HolochainAPI` interface

### Part 6: Popup UI
- `packages/extension/src/popup/happs.ts` - "Awaiting Membrane Proof" badge, `showMemproofDialog()` for manual base64/hex proof input

### Part 7: Test Zome
- `packages/test-zome/src/lib.rs` - `genesis_self_check` callback with progenitor signature validation
- `packages/test-zome/Cargo.toml` - Added `rmp-serde` and `serde_json` dependencies

### Part 8: Integration Tests
- `packages/core/src/ribosome/genesis-self-check.test.ts` (new) - 5 test cases using real WASM + libsodium
- `packages/core/vitest.integration.config.ts` (new) - Separate config for integration tests
- `packages/core/vitest.config.ts` - Excluded integration test from main suite

## Key Technical Details

- **WASM export naming**: HDI macro rewrites `genesis_self_check` to `genesis_self_check_2`. Code checks both names.
- **SerializedBytes encoding**: Membrane proof arrives as msgpack-encoded bytes (SerializedBytes content). Must NOT be double-encoded when building `GenesisSelfCheckDataV2`.
- **Rust deserialization**: `SerializedBytes` to `Vec<u8>` requires `UnsafeBytes` intermediate: `UnsafeBytes::from(sb).into()` then `rmp_serde::from_slice()`.
- **verify_signature_raw**: Used instead of `verify_signature` because the proof is a signature over raw bytes (not a serializable structure).

## Verification

- `npm run typecheck` - all packages pass
- `npm test` - unit tests pass
- Integration tests: 5/5 genesis_self_check tests pass
- `npm run build:extension` - extension builds

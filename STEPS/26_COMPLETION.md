# Step 26 Completion: Membrane Proof Support

## Summary

Added full membrane proof support to HWC across all layers: core types, genesis_self_check WASM callback, deferred memproof flow, messaging, page API, client library, and popup UI.

## Files Changed (16 modified, 3 new)

### New Files
| File | Description |
|------|-------------|
| `packages/core/src/ribosome/genesis-self-check.ts` | genesis_self_check WASM callback runner |
| `packages/core/src/ribosome/genesis-self-check.test.ts` | Integration tests (5 cases, libsodium + real WASM) |
| `packages/core/vitest.integration.config.ts` | Separate vitest config for integration tests |

### Modified Files
| File | Change |
|------|--------|
| `packages/core/src/index.ts` | `HappContextStatus` type, `status` on `HappContext`, `membraneProofs` on `InstallHappRequest` |
| `packages/core/src/storage/genesis.ts` | Accept + pass through `membraneProof` parameter |
| `packages/core/vitest.config.ts` | Exclude genesis-self-check integration test |
| `packages/extension/src/background/index.ts` | `PROVIDE_MEMPROOFS` handler, membraneProofs passthrough, status in responses |
| `packages/extension/src/inject/index.ts` | `provideMemproofs()` on `window.holochain` API |
| `packages/extension/src/lib/happ-context-manager.ts` | `provideMemproofs()`, deferred flow, enable guard |
| `packages/extension/src/lib/happ-context-storage.ts` | `status` field persistence with backward compat |
| `packages/extension/src/lib/happ-context-storage.test.ts` | Added `status` to test fixtures |
| `packages/extension/src/lib/messaging.ts` | `PROVIDE_MEMPROOFS` message type and payload |
| `packages/extension/src/popup/happs.ts` | "Awaiting Membrane Proof" UI, `showMemproofDialog()` |
| `packages/client/src/WebConductorAppClient.ts` | `provideMemproofs()` client method |
| `packages/client/src/types.ts` | Updated `HolochainAPI` interface |
| `packages/test-zome/src/lib.rs` | `genesis_self_check` callback with progenitor validation |
| `packages/test-zome/Cargo.toml` | Added `rmp-serde`, `serde_json` dependencies |
| `packages/test-zome/Cargo.lock` | Updated lockfile |
| `packages/extension/test/test-zome.wasm` | Rebuilt WASM binary |

## Test Results

### Integration Tests (genesis-self-check)
```
 ✓ should return Valid when no progenitor in DNA properties (open membrane)
 ✓ should return Invalid when progenitor set but no membrane proof provided
 ✓ should return Invalid when progenitor set but garbage proof bytes
 ✓ should return Valid when progenitor set and valid signature proof provided
 ✓ should return Invalid when proof is wrong length (not 64 bytes)

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### Typecheck
All packages pass (`shared`, `lair`, `core`, `extension` excluding pre-existing TS6305 stale dist warnings).

### Build
Extension builds successfully via `npm run build:extension`.

## Issues Found and Fixed

1. **WASM export naming**: HDI macro rewrites `genesis_self_check` to `genesis_self_check_2`. Fixed by checking both names with nullish coalescing.
2. **Double-encoding bug**: Membrane proof was being msgpack-encoded twice before passing to WASM. Fixed by passing SerializedBytes content as-is.
3. **Rust SerializedBytes deserialization**: `HashMap<String, Value>: TryFrom<SerializedBytes>` not satisfied. Fixed via `UnsafeBytes` intermediate + `rmp_serde::from_slice`.

## Lessons Learned

- HDI callback macros append version suffixes (e.g., `_2`) to export names. Always check versioned names first.
- `SerializedBytes` in Rust requires the `UnsafeBytes` intermediate for arbitrary deserialization: `UnsafeBytes::from(sb).into()` gives `Vec<u8>`, then `rmp_serde::from_slice()`.
- `verify_signature_raw` (not `verify_signature`) is needed when the signed data is raw bytes rather than a serializable structure.

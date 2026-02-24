# Step 13: Storage Backup & Recovery - Completion Notes

**Status**: Phase 1 (13.1) and Phase 2 (13.2) complete. Phase 3 (13.3) planned.

## What Was Implemented

### 13.1 Persistent Storage + Seed Phrase Export
- `navigator.storage.persist()` called on extension startup
- Lair key export/import via 24-word BIP-39 seed phrase
- Recovery flow: detect missing data, offer seed phrase import
- Key reuse on reinstall: recovered keys work with existing hApp contexts

### 13.2 DHT Chain Recovery
- Core recovery logic in `packages/core/src/recovery/chain-recovery.ts`
- Queries `getAgentActivitySync` for agent's action hashes
- Fetches full records via `getRecordSync` for each hash
- Handles both `Hashes` and `Full` activity response variants

**Signature verification** (mandatory):
- Ed25519 signature verification via libsodium for every recovered record
- Two-pass approach: verify ALL signatures before storing ANY records
- If any signature fails, entire operation aborts with zero records stored
- Injectable `verify` parameter for test isolation

**Entry type wire-format conversion**:
- `wireEntryTypeToStorage()`: converts `{ App: { entry_index, zome_index, visibility } }` to `{ zome_id, entry_index }`
- `wireEntryTypeToStoredEntryType()`: handles entry-level and action-level type mapping

**Recovery sealing** (prevents chain forks):
- State machine: `undefined` (never recovered) -> `false` (recovery run) -> `true` (sealed)
- `recoverySealed` persisted on HappContext in IndexedDB
- Sealed on first chain-writing zome call after recovery (`didWrite` flag)
- Recovery blocked when sealed; Recover button hidden in popup

**Progress UI**:
- Progress bar with percentage in popup
- Status messages: discovering, fetching, complete, error
- Verified count shown in completion message

### Type Safety
- `RecoveredRecord.signedAction` typed as `SignedActionHashed`
- `RecoveredRecord.entry` typed as `Entry | null`
- `FlatActionFields` wire-format type for cross-variant field access
- `RecoveryResult` type propagated through offscreen -> executor -> background -> popup
- No `as any` in production recovery code or test code

## Test Coverage
- 69 unit tests across 3 files:
  - `chain-recovery.test.ts` (20 tests): DHT recovery flow, progress callbacks, edge cases
  - `store-recovered.test.ts` (31 tests): storage mapping, entry type conversion, chain head updates
  - `verify-signature.test.ts` (18 tests): real Ed25519 signatures, tamper detection, abort behavior
- E2E test: 7-phase chain recovery test (create data, export keys, clear storage, import keys, recover, verify)

## Bug Fixes During Implementation
- Lair import field name: `secretKey` -> `secret_key` (matching Rust serde format)
- Exportable keys: mark Lair keys as exportable during generation
- Key reuse: use existing Lair keys on reinstall instead of generating new ones
- Wire-format `entry_type` conversion: `{ App: { entry_index, zome_index, visibility } }` -> `{ zome_id, entry_index }`

## Files Modified

| Package | File | Change |
|---------|------|--------|
| core | `src/recovery/chain-recovery.ts` | Core recovery, verification, storage, type safety |
| core | `src/recovery/chain-recovery.test.ts` | Recovery flow tests |
| core | `src/recovery/store-recovered.test.ts` | Storage mapping tests |
| core | `src/recovery/verify-signature.test.ts` | Signature verification tests |
| core | `src/index.ts` | `recoverySealed` on HappContext |
| extension | `src/background/chrome-offscreen-executor.ts` | RecoveryResult type, didWrite flag |
| extension | `src/background/index.ts` | Recovery sealing, didWrite handling |
| extension | `src/offscreen/index.ts` | Forward verified counts, remove as any |
| extension | `src/popup/happs.ts` | Recovery UI, typed payloads, seal visibility |
| extension | `src/lib/zome-executor.ts` | RecoveryResult interface, didWrite on ZomeCallResult |
| extension | `src/lib/happ-context-manager.ts` | markRecoveryRun, sealRecovery methods |
| extension | `src/lib/happ-context-storage.ts` | recoverySealed persistence |

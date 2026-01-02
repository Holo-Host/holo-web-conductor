# Step 2.5: Lair UI Integration Plan

## Goal
Add UI in extension popup for Lair key management before implementing web page authorization.

## Dependencies
- Step 2 (Lair client)

## Status: COMPLETE

## Sub-tasks

### 2.5.1 Implement lock/unlock mechanism
- Explore WebAuthn/Passkeys API for modern authentication
- Fallback to passphrase-based if WebAuthn not suitable
- Lock state persists across browser restarts

### 2.5.2 Create keypair management UI
- Create new keypairs with tag and exportable flag
- List existing keypairs with metadata
- Delete keypairs (with confirmation)

### 2.5.3 Implement sign/verify operations in UI
- Text input for data to sign
- Display signature in base64
- Verify signatures from other keypairs

### 2.5.4 Implement export/import functionality
- Export keypairs with passphrase-based encryption
- Enforce exportable flag (non-exportable keys cannot be exported)
- Import encrypted keypairs
- Follow security model from original Lair

### 2.5.5 Add Lair operations to background service worker
- Message types for all Lair operations
- Handlers that check lock state before operations
- Only accessible from extension popup (not web pages)

### 2.5.6 Write tests for UI operations
- Lock/unlock flow
- Create/list/delete keypairs
- Sign/verify operations
- Export/import with encryption

## Key Files
- `packages/extension/src/popup/lair.html` - Lair management UI
- `packages/extension/src/popup/lair.ts` - UI logic
- `packages/extension/src/lib/lair-lock.ts` - Lock/unlock mechanism
- `packages/extension/src/lib/lair-export.ts` - Export/import with encryption
- `packages/extension/src/background/index.ts` - Add Lair message handlers
- `packages/extension/src/lib/messaging.ts` - Add Lair message types

## Tests
- Lock/unlock mechanism works correctly
- Keypair operations only work when unlocked
- Export respects exportable flag
- Import/export round-trip with passphrase
- UI properly displays key information

## Design Decisions
- Lair operations NOT exposed through window.holochain API (popup only)
- Passphrase-based export/import for simplicity
- Strict enforcement of exportable flag
- Lock state persists across restarts

## Implementation Notes
- Used Web Crypto API PBKDF2 instead of libsodium crypto_pwhash (Argon2id) for broader browser compatibility
- Integrated export/import methods directly into LairClient instead of separate lair-export.ts file
- Passphrase-based lock/unlock chosen over WebAuthn/Passkeys for v1 (can add WebAuthn later)
- Chrome message passing serialization handled with toUint8Array() helper pattern
- Files created: lair.html (9.74KB), lair.ts (474 lines), lair-lock.ts (311 lines)
- Methods added to LairClient: exportSeedByTag(), importSeed(), deleteEntry()
- 13 new message types added for Lair operations
- All functionality verified working in Chrome browser

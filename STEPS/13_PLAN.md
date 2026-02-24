# Step 13: Storage Backup & Recovery

**Status**: PLANNED
**Priority**: High (data loss risk mitigation)
**Dependencies**: Step 11 (SQLite storage)

## Problem Statement

All user data (source chain, keys, hApp contexts) is stored in browser-controlled storage (OPFS, IndexedDB) that can be lost when:
- User uninstalls the extension
- User clears browsing data with "Cookies and site data" selected
- Browser evicts storage under pressure (best-effort storage, not persistent)

**Current risk**: Complete data loss with no recovery path.

---

## Goals

1. Minimize risk of permanent data loss
2. Enable identity recovery via seed phrase
3. Enable source chain recovery from DHT for published data
4. Provide clear user guidance on backup importance

---

## Phase 1: Essential Protection (Immediate)

### 1.1 Request Persistent Storage

**Goal**: Prevent browser from automatically evicting OPFS/IndexedDB data.

**Implementation**:
```typescript
// On extension startup (background/index.ts or offscreen/index.ts)
async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage?.persist) {
    const persisted = await navigator.storage.persist();
    console.log(`[Storage] Persistent storage: ${persisted ? 'granted' : 'denied'}`);
    return persisted;
  }
  return false;
}

// Check status
async function checkStorageStatus(): Promise<{persisted: boolean, usage: number, quota: number}> {
  const persisted = await navigator.storage?.persisted() ?? false;
  const estimate = await navigator.storage?.estimate() ?? {usage: 0, quota: 0};
  return { persisted, usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}
```

**UI**: Show warning in popup if storage is not persistent.

**Files to modify**:
- `packages/extension/src/offscreen/index.ts` - Request on startup
- `packages/extension/src/popup/index.html` - Warning indicator

### 1.2 Lair Seed Phrase Export

**Goal**: Allow user to backup their identity as a seed phrase they can write down.

**Implementation approach**:
- Use BIP-39 compatible word list (2048 words)
- Derive seed from Lair master entropy
- 24 words = 256 bits of entropy (matches Ed25519 seed)

**Export flow**:
```typescript
// packages/lair/src/backup.ts
import { wordlist } from '@scure/bip39/wordlists/english';

export function entropyToMnemonic(entropy: Uint8Array): string {
  // Convert 32 bytes to 24 words using BIP-39 algorithm
  // Add checksum bits from SHA-256
}

export function mnemonicToEntropy(mnemonic: string): Uint8Array {
  // Validate checksum
  // Convert 24 words back to 32 bytes
}
```

**UI flow**:
1. User clicks "Backup Identity" in Lair section of popup
2. Enter unlock passphrase to decrypt keys
3. Display 24-word seed phrase with copy button
4. Checkbox: "I have written down this phrase"
5. Verify by asking user to enter words 3, 7, 15

**Files to create**:
- `packages/lair/src/backup.ts` - Mnemonic conversion
- `packages/lair/src/backup.test.ts` - Round-trip tests

**Files to modify**:
- `packages/extension/src/popup/lair.html` - Backup button
- `packages/extension/src/popup/lair.ts` - Backup flow
- `packages/lair/src/client.ts` - Export seed method

### 1.3 Recovery Detection & Flow

**Goal**: Detect when user needs recovery and guide them through options.

**Detection triggers**:
- Extension installed but no Lair keys exist
- Lair keys exist but SQLite chain is empty
- hApp context exists but chain data missing

**Recovery options UI**:
```
┌─────────────────────────────────────────┐
│  Welcome to Fishy                       │
│                                         │
│  ○ Create new identity                  │
│    Start fresh with a new agent key     │
│                                         │
│  ○ Recover from seed phrase             │
│    Restore your identity from backup    │
│                                         │
│  [Continue]                             │
└─────────────────────────────────────────┘
```

**Files to create**:
- `packages/extension/src/popup/recovery.html` - Recovery UI
- `packages/extension/src/popup/recovery.ts` - Recovery logic

**Files to modify**:
- `packages/extension/src/popup/index.ts` - Route to recovery if needed
- `packages/extension/src/background/index.ts` - Detection logic

---

## Phase 2: Network Recovery (High Value)

### 2.1 DHT Chain Recovery

**Goal**: Rebuild source chain from published data on the DHT.

**Prerequisites**:
- User has recovered Lair keys (from seed phrase)
- Network is available
- Gateway is reachable

**Implementation**:
```typescript
// packages/core/src/recovery/chain-recovery.ts

interface RecoveryProgress {
  status: 'discovering' | 'fetching' | 'complete' | 'error';
  totalActions: number;
  recoveredActions: number;
  errors: string[];
}

async function recoverChainFromDHT(
  dnaHash: DnaHash,
  agentPubKey: AgentPubKey,
  network: NetworkService,
  storage: StorageProvider,
  onProgress: (progress: RecoveryProgress) => void
): Promise<void> {
  // 1. Query get_agent_activity for agent's action hashes
  // 2. For each action hash, cascade fetch the Record
  // 3. Validate signature matches agent pubkey
  // 4. Store in local SQLite
  // 5. Report progress
}
```

**Recovery flow**:
1. User selects "Recover from Network" for a specific hApp
2. Extension queries gateway: `GET /dht/{dna}/agent_activity/{agent}`
3. Receive list of action hashes
4. For each hash, fetch full Record via cascade
5. Verify signatures match recovered agent key
6. Insert into local SQLite
7. Show progress bar and completion status

**Limitations to communicate to user**:
- Only published data can be recovered
- Unpublished drafts/local-only data is lost
- Recovery depends on network peer availability

**Files to create**:
- `packages/core/src/recovery/chain-recovery.ts` - Recovery logic
- `packages/core/src/recovery/chain-recovery.test.ts` - Tests

**Files to modify**:
- `packages/extension/src/popup/happs.html` - "Recover" button per hApp
- `packages/extension/src/popup/happs.ts` - Recovery UI flow
- Gateway may need `agent_activity` endpoint (check if exists)

### 2.2 Progress UI for Recovery

**Goal**: Show user what's happening during recovery.

```
┌─────────────────────────────────────────┐
│  Recovering: profiles                   │
│                                         │
│  [████████████░░░░░░░░] 60%             │
│                                         │
│  Found: 45 actions                      │
│  Recovered: 27 actions                  │
│  Errors: 0                              │
│                                         │
│  [Cancel]                               │
└─────────────────────────────────────────┘
```

---

## Phase 3: Convenience Features (Future)

### 3.1 Manual Export/Import Backup

**Goal**: Let user export encrypted backup file.

**What to include** (within reasonable size):
- hApp context metadata (DNA hashes, origin URLs)
- Chain metadata (action hashes for verification)
- Publish queue status
- NOT: WASM binaries (re-download from origin)
- NOT: full entries (recover from DHT)
- NOT: private keys (use seed phrase instead)

**File format**: JSON encrypted with AES-256-GCM, key from PBKDF2(passphrase)

### 3.2 chrome.storage.sync Bootstrap

**Goal**: Remember installed hApps across devices/reinstalls.

**What fits in 512KB limit**:
- Installed hApp DNA hashes (39 bytes each)
- Origin URLs for WASM download
- Last known agent pubkey (for recovery prompt)

**Enables**: "You previously had these hApps installed. Restore?"

### 3.3 Automatic Backup Reminders

**Goal**: Prompt user to backup if they haven't recently.

- Track last backup date in chrome.storage.local
- Show reminder after 30 days or N new entries
- Non-intrusive notification in popup

---

## Data Recovery Matrix

| Scenario | Keys | Chain | Action Required |
|----------|------|-------|-----------------|
| Normal operation | Local | Local | None |
| Browser restart | Local | Local | None (persistent) |
| Clear cache (cookies only) | Lost | Lost | Seed phrase + DHT recovery |
| Extension uninstall | Lost | Lost | Seed phrase + DHT recovery |
| New device | N/A | N/A | Seed phrase + DHT recovery |
| Seed phrase lost + local OK | Local | Local | Export seed phrase NOW |
| Seed phrase lost + local lost | Lost | Lost | **Unrecoverable** - new identity |

---

## Success Criteria

### Phase 1
- [x] `navigator.storage.persist()` called on startup
- [ ] Warning shown if persistent storage denied
- [x] Seed phrase export works (24 words)
- [x] Seed phrase import recovers same keys
- [x] Recovery flow detects missing data and offers options

### Phase 2
- [x] DHT recovery fetches agent's published actions
- [x] Recovery progress shown to user
- [x] Recovered chain matches original (for published data)
- [x] Errors handled gracefully (network issues, missing data)
- [x] Signature verification blocks storage on failure
- [x] Recovery sealing prevents chain forks from re-running recovery

### Phase 3
- [ ] Export/import backup file works
- [ ] chrome.storage.sync remembers installed hApps
- [ ] Backup reminders shown appropriately

---

## Security Considerations

1. **Seed phrase display**: Only show after passphrase unlock, warn about security
2. **Seed phrase storage**: NEVER store seed phrase - user must write it down
3. **Recovery verification**: Verify signatures during DHT recovery
4. **Backup encryption**: Use strong KDF (PBKDF2 100k+ iterations)

---

## Estimated Effort

| Phase | Sub-step | Effort |
|-------|----------|--------|
| 1 | 1.1 Persistent storage | Small (1-2 hours) |
| 1 | 1.2 Seed phrase export | Medium (4-6 hours) |
| 1 | 1.3 Recovery detection | Medium (3-4 hours) |
| 2 | 2.1 DHT recovery | Large (8-12 hours) |
| 2 | 2.2 Progress UI | Small (2-3 hours) |
| 3 | 3.1 Manual backup | Medium (4-6 hours) |
| 3 | 3.2 Sync bootstrap | Small (2-3 hours) |
| 3 | 3.3 Reminders | Small (1-2 hours) |

**Total**: ~25-40 hours across all phases

---

## Dependencies

- `@scure/bip39` - BIP-39 mnemonic wordlist and utilities
- Gateway `agent_activity` endpoint (verify exists or implement)

---

## References

- [BIP-39 Specification](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)
- [Storage API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API)
- [Holochain get_agent_activity](https://docs.rs/holochain/latest/holochain/core/ribosome/host_fn/get_agent_activity/)

# @holo-host/lair

Cryptographic key management for Holochain applications. Works in browsers
(IndexedDB storage), Node.js servers (in-memory or encrypted storage),
Cloudflare Workers, and Electron apps.

## Installation

```bash
npm install @holo-host/lair
```

## Features

- Ed25519 key generation and signing
- X25519 encryption/decryption (crypto_box)
- Symmetric encryption (secret_box)
- Key derivation (hierarchical deterministic keys)
- BIP-39 seed phrase backup and recovery
- Pluggable storage backends (IndexedDB, in-memory, encrypted)
- Full libsodium compatibility

## Usage

```typescript
import { createLairClient, MemoryKeyStorage } from '@holo-host/lair';

// Create a client with in-memory storage (Node.js / testing)
const client = await createLairClient(new MemoryKeyStorage());

// Or with IndexedDB storage (browser)
import { createLairClient, createKeyStorage } from '@holo-host/lair';
const storage = await createKeyStorage(); // defaults to IndexedDB
const client = await createLairClient(storage);

// Generate a new signing key
const { tag, pubKey } = await client.newSeed('my-agent-key');

// Sign data
const signature = await client.signByPubKey(pubKey, new Uint8Array([1, 2, 3]));
```

## Storage Backends

### IndexedDB (browser default)

```typescript
import { IndexedDBKeyStorage } from '@holo-host/lair';
const storage = new IndexedDBKeyStorage('my-db-name');
```

### In-Memory (Node.js / testing)

```typescript
import { MemoryKeyStorage } from '@holo-host/lair';
const storage = new MemoryKeyStorage();
```

### Encrypted Storage (password-protected)

```typescript
import { EncryptedKeyStorage, MemoryKeyStorage } from '@holo-host/lair';
const inner = new MemoryKeyStorage();
const storage = await EncryptedKeyStorage.create(inner, 'my-passphrase');
```

## Seed Phrase Backup

```typescript
import { seedToMnemonic, mnemonicToSeed, isValidMnemonic } from '@holo-host/lair';

// Export seed as BIP-39 mnemonic
const mnemonic = seedToMnemonic(seedBytes);

// Restore from mnemonic
const seed = mnemonicToSeed(mnemonic);

// Validate
isValidMnemonic(mnemonic); // true/false
```

## License

Apache-2.0

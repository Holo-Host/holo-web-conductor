/**
 * Lair keystore lock/unlock mechanism
 *
 * Manages passphrase-based locking for the Lair keystore.
 * Lock state persists across browser restarts.
 *
 * Derives 64 bytes from PBKDF2:
 *   - First 32 bytes = master encryption key (held in memory while unlocked)
 *   - Second 32 bytes = verification hash (stored in chrome.storage.local)
 *
 * The master key is used by EncryptedKeyStorage to encrypt/decrypt seeds.
 */

import { MIN_PASSPHRASE_LENGTH } from "@hwc/shared";

const STORAGE_KEY = "hwc_lair_lock_state";

/**
 * Derive 64 bytes from a passphrase using PBKDF2 (Web Crypto API).
 * Returns [masterKey (32 bytes), verificationHash (32 bytes)].
 */
async function deriveKeyAndHash(
  passphrase: string,
  salt: Uint8Array
): Promise<{ masterKey: Uint8Array; verificationHash: Uint8Array }> {
  const encoder = new TextEncoder();
  const passphraseBytes = encoder.encode(passphrase);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passphraseBytes,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  // Derive 64 bytes (512 bits): first 32 = encryption key, second 32 = verification hash
  const derivedBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 600000,
      hash: "SHA-256",
    },
    keyMaterial,
    512 // 64 bytes = 512 bits
  );

  const derived = new Uint8Array(derivedBuffer);
  return {
    masterKey: derived.slice(0, 32),
    verificationHash: derived.slice(32, 64),
  };
}

/**
 * Generate random bytes for salt
 */
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Convert Uint8Array to base64
 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Convert base64 to Uint8Array
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Constant-time comparison of two Uint8Arrays
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Lock state stored in chrome.storage.local
 */
export interface LockState {
  isLocked: boolean;
  passphraseHash?: string; // Base64-encoded verification hash
  salt?: string; // Base64-encoded salt
  lastUnlocked?: number; // Timestamp of last unlock
}

/**
 * Serializable lock state for storage
 */
interface StoredLockState {
  isLocked: boolean;
  passphraseHash?: string;
  salt?: string;
  lastUnlocked?: number;
}

/**
 * Lair lock manager
 */
export class LairLock {
  private currentState: LockState | null = null;
  private masterKey_: Uint8Array | null = null;
  private ready: Promise<void>;
  private unlockAttempts = 0;
  private lastUnlockAttempt = 0;

  constructor() {
    this.ready = this.initialize();
  }

  /**
   * Initialize and load lock state
   */
  private async initialize(): Promise<void> {
    await this.loadState();
  }

  /**
   * Ensure initialization is complete before operations
   */
  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  /**
   * Load lock state from chrome.storage.local
   */
  private async loadState(): Promise<void> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY] as StoredLockState | undefined;

    if (stored) {
      this.currentState = {
        isLocked: stored.isLocked,
        passphraseHash: stored.passphraseHash,
        salt: stored.salt,
        lastUnlocked: stored.lastUnlocked,
      };
    } else {
      // First time - no passphrase set yet, unlocked
      this.currentState = {
        isLocked: false,
        passphraseHash: undefined,
        salt: undefined,
      };
    }
  }

  /**
   * Save lock state to chrome.storage.local
   */
  private async saveState(): Promise<void> {
    if (!this.currentState) {
      throw new Error("Lock state not initialized");
    }

    const toStore: StoredLockState = {
      isLocked: this.currentState.isLocked,
      passphraseHash: this.currentState.passphraseHash,
      salt: this.currentState.salt,
      lastUnlocked: this.currentState.lastUnlocked,
    };

    await chrome.storage.local.set({ [STORAGE_KEY]: toStore });
  }

  /**
   * Get current lock state
   */
  async getLockState(): Promise<LockState> {
    await this.ensureReady();
    if (!this.currentState) {
      throw new Error("Lock state not initialized");
    }
    return { ...this.currentState };
  }

  /**
   * Check if a passphrase has been set
   */
  async hasPassphrase(): Promise<boolean> {
    await this.ensureReady();
    return !!this.currentState?.passphraseHash;
  }

  /**
   * Get the master encryption key (only available while unlocked).
   * Returns null if locked or no passphrase set.
   */
  getMasterKey(): Uint8Array | null {
    return this.masterKey_;
  }

  /**
   * Set or change the passphrase.
   * If a passphrase is already set, oldPassphrase is required to change it.
   * Returns the old master key (if any) so the caller can re-encrypt seeds.
   */
  async setPassphrase(
    passphrase: string,
    oldPassphrase?: string
  ): Promise<{ oldMasterKey: Uint8Array | null; newMasterKey: Uint8Array }> {
    await this.ensureReady();

    if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    }

    let oldMasterKey: Uint8Array | null = null;

    // If a passphrase already exists, verify the old one first
    if (this.currentState?.passphraseHash && this.currentState?.salt) {
      if (!oldPassphrase) {
        throw new Error("Current passphrase is required to change passphrase");
      }

      const salt = fromBase64(this.currentState.salt);
      const { masterKey, verificationHash } = await deriveKeyAndHash(oldPassphrase, salt);
      const storedHash = fromBase64(this.currentState.passphraseHash);
      const isValid = constantTimeEqual(verificationHash, storedHash);
      if (isValid) {
        oldMasterKey = masterKey;
      } else {
        masterKey.fill(0);
        throw new Error("Incorrect current passphrase");
      }
    }

    // Generate new salt and derive new key + hash
    const salt = randomBytes(16);
    const { masterKey, verificationHash } = await deriveKeyAndHash(passphrase, salt);

    // Clear old master key from memory
    if (this.masterKey_) {
      this.masterKey_.fill(0);
    }
    this.masterKey_ = masterKey;

    this.currentState = {
      isLocked: false,
      passphraseHash: toBase64(verificationHash),
      salt: toBase64(salt),
      lastUnlocked: Date.now(),
    };

    await this.saveState();

    return { oldMasterKey, newMasterKey: new Uint8Array(masterKey) };
  }

  /**
   * Unlock with passphrase.
   * On success, derives and holds the master encryption key in memory.
   */
  async unlock(passphrase: string): Promise<boolean> {
    await this.ensureReady();

    if (this.unlockAttempts >= 5) {
      const elapsed = Date.now() - this.lastUnlockAttempt;
      if (elapsed < 30000) {
        throw new Error("Too many unlock attempts. Try again later.");
      }
      // Window expired — reset counter
      this.unlockAttempts = 0;
    }

    if (!this.currentState) {
      throw new Error("Lock state not initialized");
    }

    if (!this.currentState.passphraseHash || !this.currentState.salt) {
      throw new Error("No passphrase set. Use setPassphrase first.");
    }

    const salt = fromBase64(this.currentState.salt);
    const derived = await deriveKeyAndHash(passphrase, salt);
    const storedHash = fromBase64(this.currentState.passphraseHash);
    const isValid = constantTimeEqual(derived.verificationHash, storedHash);
    const masterKey = derived.masterKey;

    if (isValid) {
      if (this.masterKey_) {
        this.masterKey_.fill(0);
      }
      this.masterKey_ = masterKey;
      this.currentState.isLocked = false;
      this.currentState.lastUnlocked = Date.now();
      this.unlockAttempts = 0;
      await this.saveState();
      return true;
    }

    masterKey.fill(0);
    this.unlockAttempts++;
    this.lastUnlockAttempt = Date.now();
    return false;
  }

  /**
   * Lock the keystore. Wipes the master key from memory.
   */
  async lock(): Promise<void> {
    await this.ensureReady();

    if (!this.currentState) {
      throw new Error("Lock state not initialized");
    }

    if (!this.currentState.passphraseHash) {
      throw new Error("Cannot lock without a passphrase. Use setPassphrase first.");
    }

    // Wipe master key from memory
    if (this.masterKey_) {
      this.masterKey_.fill(0);
      this.masterKey_ = null;
    }

    this.currentState.isLocked = true;
    await this.saveState();
  }

  /**
   * Check if currently locked
   */
  async isLocked(): Promise<boolean> {
    await this.ensureReady();

    // If no passphrase set, consider unlocked
    if (!this.currentState?.passphraseHash) {
      return false;
    }

    return this.currentState.isLocked;
  }

  /**
   * Reset lock state (for testing or recovery)
   */
  async reset(): Promise<void> {
    if (this.masterKey_) {
      this.masterKey_.fill(0);
      this.masterKey_ = null;
    }
    await chrome.storage.local.remove(STORAGE_KEY);
    this.currentState = {
      isLocked: false,
      passphraseHash: undefined,
      salt: undefined,
    };
    this.unlockAttempts = 0;
    this.lastUnlockAttempt = 0;
  }
}

/**
 * Singleton instance
 */
let lairLockInstance: LairLock | null = null;

/**
 * Get the singleton Lair lock instance
 */
export function getLairLock(): LairLock {
  if (!lairLockInstance) {
    lairLockInstance = new LairLock();
  }
  return lairLockInstance;
}

/**
 * Lair keystore lock/unlock mechanism
 *
 * Manages passphrase-based locking for the Lair keystore.
 * Lock state persists across browser restarts.
 */

const STORAGE_KEY = "hwc_lair_lock_state";

/**
 * Hash a passphrase using PBKDF2 (Web Crypto API)
 * More widely supported than Argon2id (crypto_pwhash)
 */
async function hashPassphrase(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passphraseBytes = encoder.encode(passphrase);

  // Import passphrase as key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passphraseBytes,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  // Derive 32 bytes using PBKDF2
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: 100000, // OWASP recommended minimum
      hash: "SHA-256",
    },
    keyMaterial,
    256 // 32 bytes = 256 bits
  );

  return new Uint8Array(hashBuffer);
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
  passphraseHash?: string; // Base64-encoded hash
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
  private ready: Promise<void>;

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
   * Set or change the passphrase
   */
  async setPassphrase(passphrase: string): Promise<void> {
    await this.ensureReady();

    if (!passphrase || passphrase.length < 8) {
      throw new Error("Passphrase must be at least 8 characters");
    }

    // Generate new salt (16 bytes)
    const salt = randomBytes(16);

    // Hash the passphrase using PBKDF2
    const hash = await hashPassphrase(passphrase, salt);

    // Convert to base64 for storage
    const hashBase64 = toBase64(hash);
    const saltBase64 = toBase64(salt);

    this.currentState = {
      isLocked: false, // Setting passphrase unlocks
      passphraseHash: hashBase64,
      salt: saltBase64,
      lastUnlocked: Date.now(),
    };

    await this.saveState();
  }

  /**
   * Unlock with passphrase
   */
  async unlock(passphrase: string): Promise<boolean> {
    await this.ensureReady();

    if (!this.currentState) {
      throw new Error("Lock state not initialized");
    }

    if (!this.currentState.passphraseHash || !this.currentState.salt) {
      throw new Error("No passphrase set. Use setPassphrase first.");
    }

    // Decode salt from base64
    const salt = fromBase64(this.currentState.salt);

    // Hash the provided passphrase with same parameters
    const hash = await hashPassphrase(passphrase, salt);

    // Decode stored hash
    const storedHash = fromBase64(this.currentState.passphraseHash);

    // Compare hashes using constant-time comparison
    const isValid = constantTimeEqual(hash, storedHash);

    if (isValid) {
      this.currentState.isLocked = false;
      this.currentState.lastUnlocked = Date.now();
      await this.saveState();
      return true;
    }

    return false;
  }

  /**
   * Lock the keystore
   */
  async lock(): Promise<void> {
    await this.ensureReady();

    if (!this.currentState) {
      throw new Error("Lock state not initialized");
    }

    if (!this.currentState.passphraseHash) {
      throw new Error("Cannot lock without a passphrase. Use setPassphrase first.");
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
    await chrome.storage.local.remove(STORAGE_KEY);
    this.currentState = {
      isLocked: false,
      passphraseHash: undefined,
      salt: undefined,
    };
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

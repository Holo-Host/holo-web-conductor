/**
 * BIP-39 Mnemonic Seed Phrase Support
 *
 * Converts 32-byte Ed25519 seeds to/from 24-word BIP-39 mnemonic phrases.
 * Used for identity backup and recovery.
 */

import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * Convert a 32-byte seed to a 24-word BIP-39 mnemonic phrase.
 *
 * @param seed - 32-byte Ed25519 seed (256 bits → 24 words)
 * @returns Space-separated 24-word mnemonic
 * @throws If seed is not exactly 32 bytes
 */
export function seedToMnemonic(seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error(`Expected 32-byte seed, got ${seed.length} bytes`);
  }
  return entropyToMnemonic(seed, wordlist);
}

/**
 * Convert a 24-word BIP-39 mnemonic phrase back to a 32-byte seed.
 *
 * @param mnemonic - Space-separated 24-word mnemonic
 * @returns 32-byte seed
 * @throws If mnemonic is invalid (wrong words, bad checksum)
 */
export function mnemonicToSeed(mnemonic: string): Uint8Array {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic phrase');
  }
  return mnemonicToEntropy(mnemonic, wordlist);
}

/**
 * Validate a mnemonic phrase without converting.
 *
 * Checks word count, wordlist membership, and checksum.
 */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

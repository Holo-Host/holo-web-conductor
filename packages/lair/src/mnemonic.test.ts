import { describe, it, expect } from 'vitest';
import { seedToMnemonic, mnemonicToSeed, isValidMnemonic } from './mnemonic.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';

describe('mnemonic', () => {
  describe('seedToMnemonic', () => {
    it('produces 24 words from a 32-byte seed', () => {
      const seed = new Uint8Array(32);
      seed.fill(0xab);
      const mnemonic = seedToMnemonic(seed);
      const words = mnemonic.split(' ');
      expect(words.length).toBe(24);
    });

    it('all words are in the BIP-39 English wordlist', () => {
      const seed = new Uint8Array(32);
      crypto.getRandomValues(seed);
      const mnemonic = seedToMnemonic(seed);
      for (const word of mnemonic.split(' ')) {
        expect(wordlist).toContain(word);
      }
    });

    it('throws for non-32-byte input', () => {
      expect(() => seedToMnemonic(new Uint8Array(16))).toThrow('Expected 32-byte seed, got 16 bytes');
      expect(() => seedToMnemonic(new Uint8Array(64))).toThrow('Expected 32-byte seed, got 64 bytes');
      expect(() => seedToMnemonic(new Uint8Array(0))).toThrow('Expected 32-byte seed, got 0 bytes');
    });

    it('produces deterministic output for the same seed', () => {
      const seed = new Uint8Array(32);
      seed.fill(0x42);
      const m1 = seedToMnemonic(seed);
      const m2 = seedToMnemonic(seed);
      expect(m1).toBe(m2);
    });

    it('produces different output for different seeds', () => {
      const seed1 = new Uint8Array(32).fill(0x00);
      const seed2 = new Uint8Array(32).fill(0xff);
      expect(seedToMnemonic(seed1)).not.toBe(seedToMnemonic(seed2));
    });
  });

  describe('mnemonicToSeed', () => {
    it('round-trips with seedToMnemonic', () => {
      const original = new Uint8Array(32);
      crypto.getRandomValues(original);
      const mnemonic = seedToMnemonic(original);
      const recovered = mnemonicToSeed(mnemonic);
      expect(recovered).toEqual(original);
    });

    it('round-trips for multiple random seeds', () => {
      for (let i = 0; i < 10; i++) {
        const seed = new Uint8Array(32);
        crypto.getRandomValues(seed);
        const recovered = mnemonicToSeed(seedToMnemonic(seed));
        expect(recovered).toEqual(seed);
      }
    });

    it('throws for invalid mnemonic', () => {
      expect(() => mnemonicToSeed('not a valid mnemonic')).toThrow('Invalid mnemonic phrase');
    });

    it('throws for mnemonic with wrong checksum', () => {
      // Take a valid mnemonic and swap the last word
      const seed = new Uint8Array(32).fill(0x42);
      const mnemonic = seedToMnemonic(seed);
      const words = mnemonic.split(' ');
      // Replace last word with a different word
      words[23] = words[23] === 'abandon' ? 'zoo' : 'abandon';
      expect(() => mnemonicToSeed(words.join(' '))).toThrow('Invalid mnemonic phrase');
    });
  });

  describe('isValidMnemonic', () => {
    it('returns true for valid mnemonic', () => {
      const seed = new Uint8Array(32);
      crypto.getRandomValues(seed);
      const mnemonic = seedToMnemonic(seed);
      expect(isValidMnemonic(mnemonic)).toBe(true);
    });

    it('returns false for invalid mnemonic', () => {
      expect(isValidMnemonic('hello world')).toBe(false);
      expect(isValidMnemonic('')).toBe(false);
      expect(isValidMnemonic('abandon '.repeat(24).trim())).toBe(false); // bad checksum
    });
  });

  describe('known BIP-39 vector', () => {
    it('all-zero entropy produces known first word "abandon"', () => {
      // BIP-39 test vector: 32 bytes of 0x00
      // First 11 bits = 0 → "abandon" (index 0 in wordlist)
      const seed = new Uint8Array(32).fill(0x00);
      const mnemonic = seedToMnemonic(seed);
      const words = mnemonic.split(' ');
      expect(words[0]).toBe('abandon');
      // Most words should be "abandon" since most 11-bit groups are 0
      // But the last word includes checksum bits, so it may differ
      expect(words.slice(0, 23).every(w => w === 'abandon')).toBe(true);
    });
  });
});

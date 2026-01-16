/**
 * Tests for byte array conversion utilities.
 */

import { describe, it, expect } from 'vitest';
import { toUint8Array, looksLikeByteArray, deepConvertByteArrays } from './byte-arrays';

describe('toUint8Array', () => {
  it('returns empty Uint8Array for null/undefined', () => {
    expect(toUint8Array(null)).toEqual(new Uint8Array());
    expect(toUint8Array(undefined)).toEqual(new Uint8Array());
  });

  it('returns same instance if already Uint8Array', () => {
    const original = new Uint8Array([1, 2, 3]);
    const result = toUint8Array(original);
    expect(result).toBe(original);
  });

  it('converts plain array to Uint8Array', () => {
    const result = toUint8Array([1, 2, 3, 4, 5]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('converts Chrome object-with-numeric-keys to Uint8Array', () => {
    // Chrome messaging converts Uint8Array to { "0": 1, "1": 2, ... }
    const chromeConverted = { 0: 132, 1: 32, 2: 36, 3: 1, 4: 2 };
    const result = toUint8Array(chromeConverted);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([132, 32, 36, 1, 2]);
  });

  it('handles empty object', () => {
    const result = toUint8Array({});
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });
});

describe('looksLikeByteArray', () => {
  it('returns false for empty array', () => {
    expect(looksLikeByteArray([])).toBe(false);
  });

  it('returns false for array with non-byte values', () => {
    expect(looksLikeByteArray([1, 2, 300])).toBe(false); // 300 > 255
    expect(looksLikeByteArray([1, -1, 3])).toBe(false); // negative
    expect(looksLikeByteArray([1, 2.5, 3])).toBe(false); // not integer
    expect(looksLikeByteArray(['a', 'b', 'c'])).toBe(false); // strings
  });

  it('recognizes AgentPubKey hash (39 bytes, prefix 132,32,36)', () => {
    // AgentPubKey: [132, 32, 36, ...36 bytes of data...]
    const agentPubKey = [132, 32, 36, ...Array(36).fill(1)];
    expect(looksLikeByteArray(agentPubKey)).toBe(true);
  });

  it('recognizes EntryHash (39 bytes, prefix 132,33,36)', () => {
    // EntryHash: [132, 33, 36, ...36 bytes of data...]
    const entryHash = [132, 33, 36, ...Array(36).fill(2)];
    expect(looksLikeByteArray(entryHash)).toBe(true);
  });

  it('recognizes ActionHash (39 bytes, prefix 132,41,36)', () => {
    // ActionHash: [132, 41, 36, ...36 bytes of data...]
    const actionHash = [132, 41, 36, ...Array(36).fill(3)];
    expect(looksLikeByteArray(actionHash)).toBe(true);
  });

  it('recognizes DnaHash (39 bytes, prefix 132,36,36)', () => {
    // DnaHash: [132, 36, 36, ...36 bytes of data...]
    const dnaHash = [132, 36, 36, ...Array(36).fill(4)];
    expect(looksLikeByteArray(dnaHash)).toBe(true);
  });

  it('recognizes long byte arrays (likely msgpack content)', () => {
    // Entry content is typically longer than 39 bytes
    const longBytes = Array(100).fill(42);
    expect(looksLikeByteArray(longBytes)).toBe(true);
  });

  it('returns false for short arrays without hash prefix', () => {
    // Small number arrays that could be coordinates or other data
    expect(looksLikeByteArray([1, 2, 3])).toBe(false);
    expect(looksLikeByteArray([100, 200, 50])).toBe(false);
  });

  it('returns false for 39-byte array with wrong prefix', () => {
    // 39 bytes but not a valid hash prefix
    const invalidPrefix = [100, 100, 100, ...Array(36).fill(1)];
    expect(looksLikeByteArray(invalidPrefix)).toBe(false);
  });
});

describe('deepConvertByteArrays', () => {
  it('returns null/undefined as-is', () => {
    expect(deepConvertByteArrays(null)).toBe(null);
    expect(deepConvertByteArrays(undefined)).toBe(undefined);
  });

  it('returns Uint8Array as-is', () => {
    const original = new Uint8Array([1, 2, 3]);
    expect(deepConvertByteArrays(original)).toBe(original);
  });

  it('returns primitives as-is', () => {
    expect(deepConvertByteArrays(42)).toBe(42);
    expect(deepConvertByteArrays('hello')).toBe('hello');
    expect(deepConvertByteArrays(true)).toBe(true);
  });

  it('converts Chrome object-with-numeric-keys that looks like hash', () => {
    // Chrome converts Uint8Array to { "0": n, "1": n, ... }
    const agentPubKey = Object.fromEntries(
      [132, 32, 36, ...Array(36).fill(1)].map((v, i) => [i.toString(), v])
    );
    const result = deepConvertByteArrays(agentPubKey);
    expect(result).toBeInstanceOf(Uint8Array);
    expect((result as Uint8Array).length).toBe(39);
  });

  it('converts array that looks like hash to Uint8Array', () => {
    const entryHash = [132, 33, 36, ...Array(36).fill(5)];
    const result = deepConvertByteArrays(entryHash);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result as Uint8Array)).toEqual(entryHash);
  });

  it('does not convert small arrays that could be regular data', () => {
    const coordinates = [10, 20, 30];
    const result = deepConvertByteArrays(coordinates);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(coordinates);
  });

  it('recursively converts nested objects', () => {
    const nested = {
      name: 'test',
      agent: [132, 32, 36, ...Array(36).fill(1)],
      metadata: {
        entry: [132, 33, 36, ...Array(36).fill(2)],
      },
    };

    const result = deepConvertByteArrays(nested) as Record<string, unknown>;

    expect(result.name).toBe('test');
    expect(result.agent).toBeInstanceOf(Uint8Array);
    expect((result.metadata as Record<string, unknown>).entry).toBeInstanceOf(Uint8Array);
  });

  it('recursively converts arrays of objects', () => {
    const records = [
      { hash: [132, 41, 36, ...Array(36).fill(1)] },
      { hash: [132, 41, 36, ...Array(36).fill(2)] },
    ];

    const result = deepConvertByteArrays(records) as Array<{ hash: unknown }>;

    expect(result[0].hash).toBeInstanceOf(Uint8Array);
    expect(result[1].hash).toBeInstanceOf(Uint8Array);
  });

  it('handles CellId tuple [DnaHash, AgentPubKey]', () => {
    const cellId = [
      [132, 36, 36, ...Array(36).fill(1)], // DnaHash
      [132, 32, 36, ...Array(36).fill(2)], // AgentPubKey
    ];

    const result = deepConvertByteArrays(cellId) as [Uint8Array, Uint8Array];

    expect(result[0]).toBeInstanceOf(Uint8Array);
    expect(result[1]).toBeInstanceOf(Uint8Array);
    expect(result[0][1]).toBe(36); // DNA type byte
    expect(result[1][1]).toBe(32); // Agent type byte
  });

  it('handles deeply nested mixed structures', () => {
    const complex = {
      records: [
        {
          signed_action: {
            hashed: {
              hash: [132, 41, 36, ...Array(36).fill(1)],
              content: {
                author: [132, 32, 36, ...Array(36).fill(2)],
              },
            },
          },
          entry: {
            Present: {
              entry_type: 'App',
              entry: [147, 164, 116, 101, 115, 116], // short msgpack - won't convert
            },
          },
        },
      ],
    };

    const result = deepConvertByteArrays(complex) as any;

    expect(result.records[0].signed_action.hashed.hash).toBeInstanceOf(Uint8Array);
    expect(result.records[0].signed_action.hashed.content.author).toBeInstanceOf(Uint8Array);
    // Short array without hash prefix stays as array
    expect(Array.isArray(result.records[0].entry.Present.entry)).toBe(true);
  });
});

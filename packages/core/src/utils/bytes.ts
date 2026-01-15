/**
 * Byte Array Utilities
 *
 * Shared utilities for working with Uint8Arrays across Chrome message boundaries.
 *
 * ## Chrome Message Passing Problem
 * Chrome's structured cloning algorithm converts Uint8Array to plain objects
 * with numeric keys: `{0: 1, 1: 2, ...}`. This happens with chrome.runtime.sendMessage
 * and window.postMessage.
 *
 * ## Two Encoding Patterns
 *
 * The codebase uses two patterns depending on the boundary:
 *
 * 1. **Post-normalization** (Page ↔ Content ↔ Background):
 *    - Let Chrome convert Uint8Array to `{0:x, 1:y}` objects
 *    - Call `normalizeUint8Arrays()` after receiving to restore
 *
 * 2. **Pre-conversion** (Background ↔ Offscreen ↔ Worker, remote signals):
 *    - Call `serializeForTransport()` before sending to convert to number[]
 *    - Call `toUint8Array()` after receiving to restore
 *
 * Both patterns work. Pre-conversion produces cleaner number[] arrays,
 * while post-normalization handles Chrome's `{0:x}` format.
 */

/**
 * Convert various array-like formats to Uint8Array
 *
 * Use at the receiving end of a Chrome message boundary to restore
 * Uint8Arrays from either pre-converted number[] or Chrome's {0:x,1:y} format.
 *
 * Handles:
 * - Uint8Array (passthrough)
 * - ArrayBuffer (wrap in Uint8Array)
 * - Other TypedArray views (convert to Uint8Array)
 * - number[] (from pre-conversion pattern)
 * - Object with numeric keys (Chrome's {0: 1, 1: 2, ...} format)
 *
 * @param data - Data to convert
 * @returns Uint8Array
 * @throws Error if data cannot be converted
 */
export function toUint8Array(data: unknown): Uint8Array {
  // Already a Uint8Array
  if (data instanceof Uint8Array) return data;

  // ArrayBuffer
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  // Other TypedArray views (Int8Array, Uint16Array, etc.)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  // Plain array of numbers
  if (Array.isArray(data)) return new Uint8Array(data);

  // Object with numeric keys (Chrome message passing format)
  if (typeof data === 'object' && data !== null) {
    const keys = Object.keys(data);
    // Check if all keys are numeric indices
    const isNumericKeys = keys.every((k) => /^\d+$/.test(k));
    if (isNumericKeys) {
      const values = Object.values(data as Record<string, number>);
      if (values.every((v) => typeof v === 'number')) {
        return new Uint8Array(values);
      }
    }
  }

  // Return empty array for null/undefined
  if (data === null || data === undefined) {
    return new Uint8Array(0);
  }

  throw new Error(`Cannot convert ${typeof data} to Uint8Array`);
}

/**
 * Safely convert to Uint8Array, returning null if not possible
 *
 * @param data - Data to convert
 * @returns Uint8Array or null if conversion fails
 */
export function toUint8ArrayOrNull(data: unknown): Uint8Array | null {
  if (data === null || data === undefined) return null;
  try {
    return toUint8Array(data);
  } catch {
    return null;
  }
}

/**
 * Check if a value looks like a serialized Uint8Array from Chrome message passing
 * (object with consecutive numeric keys starting from 0, all number values)
 */
function looksLikeSerializedUint8Array(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data) || data instanceof Uint8Array) {
    return false;
  }
  const keys = Object.keys(data);
  if (keys.length === 0) return false;

  // Check if all keys are consecutive numbers starting from 0
  // and all values are numbers in byte range
  const record = data as Record<string, unknown>;
  return keys.every((k, i) => k === String(i)) &&
    keys.every(k => {
      const v = record[k];
      return typeof v === 'number' && v >= 0 && v <= 255;
    });
}

/**
 * Recursively normalize Uint8Arrays in nested data structures
 *
 * **Post-normalization pattern**: Call this after receiving data from
 * chrome.runtime.sendMessage or window.postMessage to restore Uint8Arrays.
 *
 * Chrome's message passing converts Uint8Arrays to objects with numeric keys
 * like {0: 1, 1: 2, ...}. This function recursively finds and converts them
 * back to Uint8Arrays.
 *
 * Used for: Page ↔ Content ↔ Background message paths
 *
 * @param data - Data structure to normalize
 * @returns Normalized data with Uint8Arrays restored
 */
export function normalizeUint8Arrays<T = unknown>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  // Already a Uint8Array
  if (data instanceof Uint8Array) {
    return data;
  }

  // Check if this looks like a serialized Uint8Array
  if (looksLikeSerializedUint8Array(data)) {
    return new Uint8Array(Object.values(data as Record<string, number>)) as T;
  }

  // Recurse into arrays
  if (Array.isArray(data)) {
    return data.map(item => normalizeUint8Arrays(item)) as T;
  }

  // Recurse into objects
  if (typeof data === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      normalized[key] = normalizeUint8Arrays(value);
    }
    return normalized as T;
  }

  // Primitives pass through
  return data;
}

/**
 * Recursively normalize byte arrays from JSON format to Uint8Array
 *
 * This is specifically for gateway responses where byte arrays come as
 * JSON arrays of numbers (e.g., [132, 41, 36, ...]).
 *
 * Unlike normalizeUint8Arrays, this converts ALL number arrays to Uint8Array,
 * which is appropriate for gateway responses where we know the structure.
 *
 * @param data - Data structure from JSON parsing
 * @returns Normalized data with byte arrays as Uint8Array
 */
export function normalizeByteArraysFromJson<T = unknown>(data: T): T {
  if (data === null || data === undefined) return data;
  if (data instanceof Uint8Array) return data;

  // Check if this is an array of numbers (likely bytes)
  if (Array.isArray(data)) {
    // If all elements are numbers 0-255, treat as byte array
    if (data.length > 0 && data.every(v => typeof v === 'number' && v >= 0 && v <= 255)) {
      return new Uint8Array(data) as T;
    }
    // Otherwise recurse into array elements
    return data.map(item => normalizeByteArraysFromJson(item)) as T;
  }

  // Recurse into objects
  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      result[key] = normalizeByteArraysFromJson(value);
    }
    return result as T;
  }

  return data;
}

/**
 * Convert Uint8Arrays to regular Arrays for Chrome message passing
 *
 * **Pre-conversion pattern**: Call this before sending data across Chrome
 * message boundaries to avoid Chrome's lossy Uint8Array serialization.
 *
 * By explicitly converting to number[] arrays, we preserve the data in a
 * cleaner format that can easily be converted back with `toUint8Array()`.
 *
 * Used for: Background ↔ Offscreen ↔ Worker paths, remote signals
 *
 * @param data - Data structure to serialize
 * @returns Data with Uint8Arrays converted to number[]
 */
export function serializeForTransport<T = unknown>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  // Convert Uint8Array to regular Array
  if (data instanceof Uint8Array) {
    return Array.from(data) as T;
  }

  // Recurse into arrays
  if (Array.isArray(data)) {
    return data.map(item => serializeForTransport(item)) as T;
  }

  // Recurse into objects
  if (typeof data === 'object') {
    const serialized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      serialized[key] = serializeForTransport(value);
    }
    return serialized as T;
  }

  // Primitives pass through
  return data;
}

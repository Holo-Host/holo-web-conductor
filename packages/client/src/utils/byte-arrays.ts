/**
 * Utilities for converting byte arrays across Chrome message passing boundaries.
 *
 * Chrome's message passing converts Uint8Array to plain objects with numeric keys
 * like { 0: 1, 1: 2, ... } or plain arrays [1, 2, ...]. These utilities convert
 * them back to proper Uint8Array instances.
 */

/**
 * Convert Chrome message object or array back to Uint8Array.
 *
 * Chrome's message passing converts Uint8Array to objects with numeric keys.
 *
 * @param data - Data that may be a converted Uint8Array
 * @returns Proper Uint8Array instance
 */
export function toUint8Array(data: unknown): Uint8Array {
  if (!data) return new Uint8Array();
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  if (typeof data === 'object') {
    // Chrome converts Uint8Array to { 0: x, 1: y, ... }
    const values = Object.values(data as Record<string, number>) as number[];
    return new Uint8Array(values);
  }
  return new Uint8Array();
}

/**
 * Check if an array looks like byte data (Uint8Array that was converted to plain array).
 *
 * Returns true if:
 * - Array has 39 elements with Holochain hash prefix (definitely a hash)
 * - Array has >0 elements, all are integers 0-255, and has known hash prefix
 *
 * @param arr - Array to check
 * @returns true if array looks like byte data
 */
export function looksLikeByteArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;

  // Check all elements are bytes (integers 0-255)
  const allBytes = arr.every(
    (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
  );
  if (!allBytes) return false;

  // Check for Holochain hash prefix: [132, type_byte, 36, ...]
  // type_byte: 32=Agent, 33=Entry, 41=Action, 36=DNA
  if (arr.length === 39 && arr[0] === 132 && arr[2] === 36) {
    const typeByte = arr[1] as number;
    if (typeByte === 32 || typeByte === 33 || typeByte === 41 || typeByte === 36) {
      return true;
    }
  }

  // For non-hash byte arrays (like entry content), be more conservative:
  // Only convert if it's clearly binary data (length suggests it's not a small number array)
  // Entry content is typically msgpack-encoded and longer than 39 bytes
  if (arr.length > 39) {
    return true;
  }

  // For shorter arrays without hash prefix, don't convert
  // (could be legitimate array of small numbers like coordinates)
  return false;
}

/**
 * Recursively convert byte arrays from Chrome messaging back to Uint8Array.
 *
 * Chrome messaging converts Uint8Array to plain arrays [n, n, n, ...].
 * This function walks the result tree and converts arrays that look like
 * byte data (all integers 0-255) back to Uint8Array.
 *
 * @param value - Value to recursively convert
 * @returns Value with byte arrays converted to Uint8Array
 */
export function deepConvertByteArrays(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Already a Uint8Array
  if (value instanceof Uint8Array) {
    return value;
  }

  // Check for Chrome's object-with-numeric-keys conversion of Uint8Array
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    // Check if this looks like a converted Uint8Array: {"0": n, "1": n, ...}
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const nums = keys.map((k) => parseInt(k, 10)).sort((a, b) => a - b);
      // Check if keys are consecutive starting from 0
      if (nums[0] === 0 && nums[nums.length - 1] === nums.length - 1) {
        const values = nums.map((i) => obj[i.toString()]);
        if (looksLikeByteArray(values)) {
          return new Uint8Array(values as number[]);
        }
      }
    }

    // Regular object - recurse into properties
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      result[key] = deepConvertByteArrays(obj[key]);
    }
    return result;
  }

  // Array - check if it's byte data or recurse
  if (Array.isArray(value)) {
    if (looksLikeByteArray(value)) {
      return new Uint8Array(value as number[]);
    }
    // Not byte data - recurse into elements
    return value.map((item) => deepConvertByteArrays(item));
  }

  // Primitive value
  return value;
}

/**
 * WASM Memory Serialization
 *
 * Handles MessagePack serialization to/from WASM memory.
 */

import { encode, decode } from "@msgpack/msgpack";
import {
  serializationError,
  deserializationError,
  memoryAllocationError,
} from "./error";

/**
 * Read bytes from WASM memory
 *
 * @param instance - WebAssembly instance
 * @param ptr - Pointer to start of data
 * @param len - Length of data in bytes
 * @returns Uint8Array containing the data
 */
export function readFromWasmMemory(
  instance: WebAssembly.Instance,
  ptr: number,
  len: number
): Uint8Array {
  const memory = instance.exports.memory as WebAssembly.Memory;
  if (!memory) {
    throw serializationError("WASM instance does not export memory");
  }

  const buffer = new Uint8Array(memory.buffer);
  return buffer.slice(ptr, ptr + len);
}

/**
 * Write bytes to WASM memory
 *
 * @param instance - WebAssembly instance
 * @param ptr - Pointer to write location
 * @param data - Data to write
 */
export function writeToWasmMemory(
  instance: WebAssembly.Instance,
  ptr: number,
  data: Uint8Array
): void {
  const memory = instance.exports.memory as WebAssembly.Memory;
  if (!memory) {
    throw serializationError("WASM instance does not export memory");
  }

  const buffer = new Uint8Array(memory.buffer);
  buffer.set(data, ptr);
}

/**
 * Allocate memory in WASM module
 *
 * @param instance - WebAssembly instance
 * @param len - Number of bytes to allocate
 * @returns Pointer to allocated memory
 * @throws {RibosomeError} If allocation fails
 */
export function wasmAllocate(
  instance: WebAssembly.Instance,
  len: number
): number {
  const allocate = instance.exports.__hc__allocate_1 as (len: number) => number;
  if (!allocate) {
    throw serializationError(
      "WASM instance does not export __hc__allocate_1"
    );
  }

  const ptr = allocate(len);
  if (ptr === 0) {
    throw memoryAllocationError();
  }

  return ptr;
}

/**
 * Deallocate memory in WASM module
 *
 * @param instance - WebAssembly instance
 * @param ptr - Pointer to memory to deallocate
 */
export function wasmDeallocate(
  instance: WebAssembly.Instance,
  ptr: number
): void {
  const deallocate = instance.exports.__hc__deallocate_1 as (
    ptr: number
  ) => void;
  if (!deallocate) {
    // Deallocate is optional - some modules don't implement it
    return;
  }

  deallocate(ptr);
}

/**
 * Serialize data to WASM memory
 *
 * Encodes data as MessagePack, allocates memory in WASM, and writes the bytes.
 *
 * @param instance - WebAssembly instance
 * @param data - Data to serialize
 * @returns Object with pointer and length
 * @throws {RibosomeError} If serialization or allocation fails
 */
export function serializeToWasm(
  instance: WebAssembly.Instance,
  data: unknown
): { ptr: number; len: number } {
  try {
    // Encode as MessagePack
    const bytes = encode(data);
    const len = bytes.length;

    // Allocate memory in WASM
    const ptr = wasmAllocate(instance, len);

    // Write bytes to WASM memory
    writeToWasmMemory(instance, ptr, new Uint8Array(bytes));

    return { ptr, len };
  } catch (error) {
    if (error instanceof Error && error.name === "RibosomeError") {
      throw error;
    }
    throw serializationError("Failed to serialize data to WASM", error);
  }
}

/**
 * Deserialize data from WASM memory
 *
 * Reads bytes from WASM memory and decodes from MessagePack.
 *
 * @param instance - WebAssembly instance
 * @param ptr - Pointer to data
 * @param len - Length of data
 * @returns Deserialized data
 * @throws {RibosomeError} If deserialization fails
 */
export function deserializeFromWasm(
  instance: WebAssembly.Instance,
  ptr: number,
  len: number
): unknown {
  try {
    // Read bytes from WASM memory
    const bytes = readFromWasmMemory(instance, ptr, len);

    // Decode from MessagePack
    return decode(bytes);
  } catch (error) {
    if (error instanceof Error && error.name === "RibosomeError") {
      throw error;
    }
    throw deserializationError("Failed to deserialize data from WASM", error);
  }
}

/**
 * Create i64 result from pointer and length
 *
 * Host functions return i64 where:
 * - High 32 bits: pointer to result data
 * - Low 32 bits: length of result data
 *
 * @param ptr - Pointer (high 32 bits)
 * @param len - Length (low 32 bits)
 * @returns Combined i64 as bigint
 */
export function createI64Result(ptr: number, len: number): bigint {
  return (BigInt(ptr) << 32n) | BigInt(len);
}

/**
 * Serialize result and return as i64
 *
 * Convenience function that combines serialization and i64 creation.
 *
 * @param instance - WebAssembly instance
 * @param data - Data to serialize
 * @returns i64 result (ptr in high 32 bits, len in low 32 bits)
 */
export function serializeResult(
  instance: WebAssembly.Instance,
  data: unknown
): bigint {
  const { ptr, len } = serializeToWasm(instance, data);
  return createI64Result(ptr, len);
}

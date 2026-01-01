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
import { WASM_INPUT_VALIDATION_ENABLED, type TypeValidator } from "./wasm-io-types";

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
    // Debug: log what we're encoding
    if (data && typeof data === 'object' && 'Ok' in data) {
      const okValue = (data as any).Ok;
      console.log(`[serializeToWasm] Encoding Ok value:`,
        okValue instanceof Uint8Array ? `Uint8Array(${okValue.length})` : typeof okValue,
        `first bytes:`, okValue instanceof Uint8Array ? Array.from(okValue.slice(0, 10)) : 'N/A');
    }

    // Encode as MessagePack
    const bytes = encode(data);
    const len = bytes.length;

    console.log(`[serializeToWasm] Encoded to ${len} bytes, first 20:`, Array.from(bytes.slice(0, 20)));

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

    // Debug: log first 20 bytes
    console.log(`[deserializeFromWasm] Bytes (first 20):`, Array.from(bytes.slice(0, 20)));

    // Decode from MessagePack
    const decoded = decode(bytes);

    // Debug: log what we decoded
    if (decoded && typeof decoded === 'object' && 'Ok' in decoded) {
      const okValue = (decoded as any).Ok;
      console.log(`[deserializeFromWasm] Ok value type:`,
        okValue instanceof Uint8Array ? `Uint8Array(${okValue.length})` : typeof okValue,
        `first bytes:`, okValue instanceof Uint8Array ? Array.from(okValue.slice(0, 10)) : 'N/A');
    }

    return decoded;
  } catch (error) {
    if (error instanceof Error && error.name === "RibosomeError") {
      throw error;
    }
    throw deserializationError("Failed to deserialize data from WASM", error);
  }
}

/**
 * Deserialize typed data from WASM memory with optional runtime validation
 *
 * When WASM_INPUT_VALIDATION_ENABLED is true (development mode), the validator
 * function is called to verify the deserialized data matches the expected type.
 * This helps catch format mismatches early with clear error messages.
 *
 * @param instance - WebAssembly instance
 * @param ptr - Pointer to data
 * @param len - Length of data
 * @param validator - Type guard function that validates the expected structure
 * @param typeName - Name of expected type (for error messages)
 * @returns Deserialized and typed data
 * @throws {RibosomeError} If deserialization or validation fails
 */
export function deserializeTypedFromWasm<T>(
  instance: WebAssembly.Instance,
  ptr: number,
  len: number,
  validator: TypeValidator<T>,
  typeName: string
): T {
  const decoded = deserializeFromWasm(instance, ptr, len);

  if (WASM_INPUT_VALIDATION_ENABLED) {
    if (!validator(decoded)) {
      console.error(`[deserializeTypedFromWasm] Validation failed for ${typeName}:`, decoded);
      throw deserializationError(`Invalid WASM input structure - expected ${typeName}`);
    }
  }

  return decoded as T;
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
 * Host functions must return Result<T, WasmError> wrapped in Ok.
 *
 * NOTE: In the real Holochain conductor, the ribosome infrastructure wraps
 * results. But since we're implementing host functions directly in TypeScript
 * (not going through that infrastructure), we must provide the wrapper ourselves.
 * The HDK expects to deserialize Result<T, WasmError> from host function calls.
 *
 * @param instance - WebAssembly instance
 * @param data - Data to serialize (will be wrapped in Ok)
 * @returns i64 result (ptr in high 32 bits, len in low 32 bits)
 */
export function serializeResult(
  instance: WebAssembly.Instance,
  data: unknown
): bigint {
  // Wrap in Result::Ok - HDK expects Result<T, WasmError>
  const result = { Ok: data };
  const { ptr, len } = serializeToWasm(instance, result);

  return createI64Result(ptr, len);
}

/**
 * Write a GuestPtr struct to WASM memory
 *
 * GuestPtr is an 8-byte structure with WASM-specific layout:
 * - length (u32, 4 bytes) - length of data (LOW 32 bits when cast to i64)
 * - offset (u32, 4 bytes) - pointer to data (HIGH 32 bits when cast to i64)
 *
 * This is used when calling zome functions, which expect a pointer to a GuestPtr.
 *
 * @param instance - WebAssembly instance
 * @param dataPtr - Pointer to the actual data
 * @param dataLen - Length of the data
 * @returns Pointer to the GuestPtr struct
 */
export function writeGuestPtr(
  instance: WebAssembly.Instance,
  dataPtr: number,
  dataLen: number
): number {
  // Allocate 8 bytes for GuestPtr struct
  const guestPtrPtr = wasmAllocate(instance, 8);

  // Write length and offset with WASM layout (length first, then offset)
  const memory = instance.exports.memory as WebAssembly.Memory;
  const view = new DataView(memory.buffer);
  view.setUint32(guestPtrPtr, dataLen, true); // length at offset 0
  view.setUint32(guestPtrPtr + 4, dataPtr, true); // offset at offset 4

  // Verify the GuestPtr was written correctly
  const readLength = view.getUint32(guestPtrPtr, true);
  const readOffset = view.getUint32(guestPtrPtr + 4, true);
  console.log(
    `[writeGuestPtr] Wrote GuestPtr@${guestPtrPtr}: length=${readLength}, offset=${readOffset}`
  );

  // Also log the actual data at that location
  const dataBytes = new Uint8Array(memory.buffer, dataPtr, Math.min(dataLen, 20));
  console.log(`[writeGuestPtr] Data at ${dataPtr}:`, Array.from(dataBytes));

  return guestPtrPtr;
}

/**
 * __hc__allocate host function
 *
 * Allocates memory in the WASM linear memory.
 * This is called by other host functions to allocate space for return values.
 */

import { HostFunctionImpl } from "./base";

/**
 * Allocate memory in WASM
 *
 * @param context - Host function context
 * @param inputPtr - Pointer to u32 containing the number of bytes to allocate
 * @returns i64 with allocated pointer in high 32 bits, 0 in low 32 bits
 */
export const allocate: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;
  const memory = instance.exports.memory as WebAssembly.Memory;
  const view = new DataView(memory.buffer);

  // Read the allocation size from WASM memory (u32)
  const len = view.getUint32(inputPtr, true);

  console.log(`[HostFn] allocate called: ${len} bytes`);

  // Call the WASM's own allocator if it exists
  const wasmAllocate = instance.exports.__hc__allocate_1 as
    | ((len: number) => number)
    | undefined;

  if (wasmAllocate) {
    const ptr = wasmAllocate(len);
    // Return i64: high 32 bits = ptr, low 32 bits = 0
    return (BigInt(ptr) << 32n) | 0n;
  }

  // Fallback: allocate at the end of memory
  // This is a simple bump allocator
  const currentSize = memory.buffer.byteLength;
  const ptr = currentSize;

  // Grow memory if needed (memory grows in 64KB pages)
  const neededPages = Math.ceil((ptr + len) / 65536) - memory.buffer.byteLength / 65536;
  if (neededPages > 0) {
    memory.grow(neededPages);
  }

  // Return i64: high 32 bits = ptr, low 32 bits = 0
  return (BigInt(ptr) << 32n) | 0n;
};

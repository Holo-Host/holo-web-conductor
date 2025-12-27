/**
 * __hc__deallocate host function
 *
 * Deallocates memory in the WASM linear memory.
 * Called to free memory that was previously allocated.
 */

import { HostFunctionImpl } from "./base";

/**
 * Deallocate memory in WASM
 *
 * @param context - Host function context
 * @param inputPtr - Pointer to GuestPtr (i64: high 32 bits = ptr, low 32 bits = len)
 * @returns i64 with 0 (success)
 */
export const deallocate: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;
  const memory = instance.exports.memory as WebAssembly.Memory;
  const view = new DataView(memory.buffer);

  // Read the GuestPtr from WASM memory (i64)
  const guestPtrLow = view.getUint32(inputPtr, true);
  const guestPtrHigh = view.getUint32(inputPtr + 4, true);
  const ptr = guestPtrHigh;
  const len = guestPtrLow;

  console.log(`[HostFn] deallocate called: ptr=${ptr}, len=${len}`);

  // Call the WASM's own deallocator if it exists
  const wasmDeallocate = instance.exports.__hc__deallocate_1 as
    | ((ptr: number) => void)
    | undefined;

  if (wasmDeallocate) {
    wasmDeallocate(ptr);
  }

  // Note: We don't actually free memory here since we don't have
  // a real allocator. The WASM module handles its own memory management.
  // This is just a stub to satisfy the import requirement.

  // Return 0 (success)
  return 0n;
};

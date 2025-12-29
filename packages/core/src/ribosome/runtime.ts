/**
 * WASM Runtime
 *
 * Manages compilation and instantiation of WASM modules.
 */

import {
  wasmCompilationError,
  wasmInstantiationError,
  zomeFunctionNotFoundError,
} from "./error";

/**
 * Convert Uint8Array to base64 string for cache keys
 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Cached zome metadata (entry_defs, link_types)
 */
export interface ZomeMetadata {
  entryDefs: unknown[];
  linkTypeCount: number;
}

/**
 * WASM runtime for Holochain ribosome
 *
 * Handles compilation and caching of WASM modules.
 */
export class RibosomeRuntime {
  /** Cache of compiled modules by DNA hash */
  private moduleCache = new Map<string, WebAssembly.Module>();

  /** Cache of zome metadata by "dnaHash:zomeName" */
  private metadataCache = new Map<string, ZomeMetadata>();

  /**
   * Compile WASM bytes into a module
   *
   * @param wasm - WASM bytes to compile
   * @returns Compiled WebAssembly module
   * @throws {RibosomeError} If compilation fails
   */
  async compileModule(wasm: Uint8Array): Promise<WebAssembly.Module> {
    try {
      return await WebAssembly.compile(wasm as BufferSource);
    } catch (error) {
      throw wasmCompilationError(error);
    }
  }

  /**
   * Instantiate a compiled module with imports
   *
   * @param module - Compiled WebAssembly module
   * @param imports - Import object with host functions
   * @returns WebAssembly instance
   * @throws {RibosomeError} If instantiation fails
   */
  async instantiateModule(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports
  ): Promise<WebAssembly.Instance> {
    try {
      return await WebAssembly.instantiate(module, imports);
    } catch (error) {
      throw wasmInstantiationError(error);
    }
  }

  /**
   * Get or compile a module, using cache if available
   *
   * @param dnaHash - DNA hash to use as cache key
   * @param wasm - WASM bytes to compile if not cached
   * @returns Compiled WebAssembly module
   */
  async getOrCompileModule(
    dnaHash: Uint8Array,
    wasm: Uint8Array
  ): Promise<WebAssembly.Module> {
    const key = toBase64(dnaHash);

    // Check cache first
    const cached = this.moduleCache.get(key);
    if (cached) {
      console.log(`[Ribosome] Using cached module for DNA ${key.substring(0, 8)}...`);
      return cached;
    }

    // Compile and cache
    console.log(`[Ribosome] Compiling WASM for DNA ${key.substring(0, 8)}...`);
    const module = await this.compileModule(wasm);
    this.moduleCache.set(key, module);

    return module;
  }

  /**
   * Get cached zome metadata
   *
   * @param dnaHash - DNA hash
   * @param zomeName - Zome name
   * @returns Cached metadata or undefined if not cached
   */
  getZomeMetadata(dnaHash: Uint8Array, zomeName: string): ZomeMetadata | undefined {
    const key = `${toBase64(dnaHash)}:${zomeName}`;
    return this.metadataCache.get(key);
  }

  /**
   * Cache zome metadata
   *
   * @param dnaHash - DNA hash
   * @param zomeName - Zome name
   * @param metadata - Metadata to cache
   */
  setZomeMetadata(dnaHash: Uint8Array, zomeName: string, metadata: ZomeMetadata): void {
    const key = `${toBase64(dnaHash)}:${zomeName}`;
    this.metadataCache.set(key, metadata);
    console.log(`[Ribosome] Cached metadata for ${zomeName}: ${metadata.entryDefs.length} entry_defs, ${metadata.linkTypeCount} link_types`);
  }

  /**
   * Clear the module cache
   */
  clearCache(): void {
    this.moduleCache.clear();
    this.metadataCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { moduleCount: number; metadataCount: number } {
    return {
      moduleCount: this.moduleCache.size,
      metadataCount: this.metadataCache.size,
    };
  }
}

/**
 * Call a zome function in a WASM instance
 *
 * @param instance - WebAssembly instance
 * @param zome - Zome name
 * @param fn - Function name
 * @param ptr - Pointer to serialized input
 * @returns Result as i64 (ptr in high 32 bits, len in low 32 bits)
 * @throws {RibosomeError} If function not found
 */
export function callZomeFunction(
  instance: WebAssembly.Instance,
  zome: string,
  fn: string,
  ptr: number
): bigint {
  const exports = instance.exports as Record<string, unknown>;

  // Look for the exported function
  // Holochain exports zome functions with their names directly
  const wasmFn = exports[fn];

  if (typeof wasmFn !== "function") {
    throw zomeFunctionNotFoundError(zome, fn);
  }

  // Call the function with the pointer to serialized input
  const result = wasmFn(ptr);

  // Result should be i64 (returned as bigint in JS)
  if (typeof result === "bigint") {
    return result;
  }

  // For simple test functions that return i32
  if (typeof result === "number") {
    return BigInt(result);
  }

  throw new Error(`Unexpected return type from ${fn}: ${typeof result}`);
}

/**
 * Extract pointer and length from i64 result
 *
 * @param result - i64 result from WASM function
 * @returns Pointer (high 32 bits) and length (low 32 bits)
 */
export function extractPtrAndLen(result: bigint): { ptr: number; len: number } {
  // High 32 bits: pointer
  const ptr = Number(result >> 32n);

  // Low 32 bits: length
  const len = Number(result & 0xffffffffn);

  return { ptr, len };
}

/**
 * Singleton runtime instance
 */
let runtimeInstance: RibosomeRuntime | null = null;

/**
 * Get the singleton runtime instance
 */
export function getRibosomeRuntime(): RibosomeRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new RibosomeRuntime();
  }
  return runtimeInstance;
}

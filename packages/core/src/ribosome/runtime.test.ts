/**
 * Runtime tests
 *
 * Tests for WASM compilation, instantiation, and function calls
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  RibosomeRuntime,
  getRibosomeRuntime,
  callZomeFunction,
  extractPtrAndLen,
} from "./runtime";
import { RibosomeError, RibosomeErrorType } from "./error";
import { minimalWasmBytes } from "./test/minimal-wasm-bytes";

describe("RibosomeRuntime", () => {
  let runtime: RibosomeRuntime;

  beforeEach(() => {
    runtime = new RibosomeRuntime();
  });

  describe("compileModule", () => {
    it("should compile valid WASM bytes", async () => {
      const module = await runtime.compileModule(minimalWasmBytes);
      expect(module).toBeInstanceOf(WebAssembly.Module);
    });

    it("should throw RibosomeError for invalid WASM", async () => {
      const invalidWasm = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

      await expect(runtime.compileModule(invalidWasm)).rejects.toThrow(
        RibosomeError
      );

      try {
        await runtime.compileModule(invalidWasm);
      } catch (error) {
        expect(error).toBeInstanceOf(RibosomeError);
        expect((error as RibosomeError).type).toBe(
          RibosomeErrorType.WasmCompilationFailed
        );
      }
    });
  });

  describe("instantiateModule", () => {
    it("should instantiate a compiled module", async () => {
      const module = await runtime.compileModule(minimalWasmBytes);
      const instance = await runtime.instantiateModule(module, {});

      expect(instance).toBeInstanceOf(WebAssembly.Instance);
      expect(instance.exports).toHaveProperty("add");
    });

    it("should accept import object", async () => {
      const module = await runtime.compileModule(minimalWasmBytes);
      const imports = {
        env: {
          test_import: () => 42,
        },
      };

      const instance = await runtime.instantiateModule(module, imports);
      expect(instance).toBeInstanceOf(WebAssembly.Instance);
    });
  });

  describe("getOrCompileModule", () => {
    it("should compile and cache module", async () => {
      const dnaHash = new Uint8Array(32).fill(1);

      const module1 = await runtime.getOrCompileModule(dnaHash, minimalWasmBytes);
      const module2 = await runtime.getOrCompileModule(dnaHash, minimalWasmBytes);

      // Should return same cached module
      expect(module1).toBe(module2);

      const stats = runtime.getCacheStats();
      expect(stats.moduleCount).toBe(1);
    });

    it("should cache different modules separately", async () => {
      const dnaHash1 = new Uint8Array(32).fill(1);
      const dnaHash2 = new Uint8Array(32).fill(2);

      const module1 = await runtime.getOrCompileModule(dnaHash1, minimalWasmBytes);
      const module2 = await runtime.getOrCompileModule(dnaHash2, minimalWasmBytes);

      // Should be different module instances (different DNA hashes)
      expect(module1).not.toBe(module2);

      const stats = runtime.getCacheStats();
      expect(stats.moduleCount).toBe(2);
    });
  });

  describe("clearCache", () => {
    it("should clear the module cache", async () => {
      const dnaHash = new Uint8Array(32).fill(1);
      await runtime.getOrCompileModule(dnaHash, minimalWasmBytes);

      expect(runtime.getCacheStats().moduleCount).toBe(1);

      runtime.clearCache();

      expect(runtime.getCacheStats().moduleCount).toBe(0);
    });
  });
});

describe("callZomeFunction", () => {
  let instance: WebAssembly.Instance;

  beforeEach(async () => {
    const runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(minimalWasmBytes);
    instance = await runtime.instantiateModule(module, {});
  });

  it("should call exported add function", () => {
    // Call add(5, 7) - function takes two i32 params directly
    const add = instance.exports.add as (a: number, b: number) => number;
    const result = add(5, 7);

    expect(result).toBe(12);
  });

  it("should throw error for non-existent function", () => {
    expect(() => {
      callZomeFunction(instance, "test_zome", "non_existent", 0);
    }).toThrow(RibosomeError);

    try {
      callZomeFunction(instance, "test_zome", "non_existent", 0);
    } catch (error) {
      expect(error).toBeInstanceOf(RibosomeError);
      expect((error as RibosomeError).type).toBe(
        RibosomeErrorType.ZomeFunctionNotFound
      );
    }
  });
});

describe("extractPtrAndLen", () => {
  it("should extract pointer and length from i64", () => {
    // Example: ptr=100, len=50
    // i64 = (100 << 32) | 50
    const result = (BigInt(100) << 32n) | BigInt(50);

    const { ptr, len } = extractPtrAndLen(result);

    expect(ptr).toBe(100);
    expect(len).toBe(50);
  });

  it("should handle zero pointer", () => {
    const result = (BigInt(0) << 32n) | BigInt(100);

    const { ptr, len } = extractPtrAndLen(result);

    expect(ptr).toBe(0);
    expect(len).toBe(100);
  });

  it("should handle maximum values", () => {
    const maxU32 = 0xffffffffn;
    const result = (maxU32 << 32n) | maxU32;

    const { ptr, len } = extractPtrAndLen(result);

    expect(ptr).toBe(0xffffffff);
    expect(len).toBe(0xffffffff);
  });
});

describe("getRibosomeRuntime", () => {
  it("should return singleton instance", () => {
    const runtime1 = getRibosomeRuntime();
    const runtime2 = getRibosomeRuntime();

    expect(runtime1).toBe(runtime2);
  });
});

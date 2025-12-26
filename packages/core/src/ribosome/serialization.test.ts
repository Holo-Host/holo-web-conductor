/**
 * Serialization tests
 *
 * Tests for MessagePack serialization to/from WASM memory
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  readFromWasmMemory,
  writeToWasmMemory,
  wasmAllocate,
  wasmDeallocate,
  serializeToWasm,
  deserializeFromWasm,
  createI64Result,
  serializeResult,
} from "./serialization";
import { RibosomeRuntime } from "./runtime";
import { allocatorWasmBytes } from "./test/allocator-wasm-bytes";
import { RibosomeError } from "./error";

describe("WASM Memory Operations", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;

  beforeEach(async () => {
    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});
  });

  describe("readFromWasmMemory", () => {
    it("should read bytes from WASM memory", () => {
      // Write some test data first
      const memory = instance.exports.memory as WebAssembly.Memory;
      const buffer = new Uint8Array(memory.buffer);
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      buffer.set(testData, 0);

      // Read it back
      const result = readFromWasmMemory(instance, 0, 5);

      expect(result).toEqual(testData);
    });

    it("should read from different offsets", () => {
      const memory = instance.exports.memory as WebAssembly.Memory;
      const buffer = new Uint8Array(memory.buffer);
      buffer.set(new Uint8Array([10, 20, 30, 40, 50]), 100);

      const result = readFromWasmMemory(instance, 100, 5);

      expect(result).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
    });
  });

  describe("writeToWasmMemory", () => {
    it("should write bytes to WASM memory", () => {
      const testData = new Uint8Array([6, 7, 8, 9, 10]);

      writeToWasmMemory(instance, 0, testData);

      // Verify by reading back
      const memory = instance.exports.memory as WebAssembly.Memory;
      const buffer = new Uint8Array(memory.buffer);
      const result = buffer.slice(0, 5);

      expect(result).toEqual(testData);
    });

    it("should write to different offsets", () => {
      const testData = new Uint8Array([11, 12, 13]);

      writeToWasmMemory(instance, 200, testData);

      const memory = instance.exports.memory as WebAssembly.Memory;
      const buffer = new Uint8Array(memory.buffer);
      const result = buffer.slice(200, 203);

      expect(result).toEqual(testData);
    });
  });

  describe("wasmAllocate", () => {
    it("should allocate memory in WASM", () => {
      const ptr1 = wasmAllocate(instance, 10);
      const ptr2 = wasmAllocate(instance, 20);

      // First allocation starts at 8 (bump pointer initial value)
      expect(ptr1).toBe(8);
      // Second allocation should be after first
      expect(ptr2).toBe(ptr1 + 10);
    });

    it("should return sequential pointers", () => {
      const ptr1 = wasmAllocate(instance, 5);
      const ptr2 = wasmAllocate(instance, 5);
      const ptr3 = wasmAllocate(instance, 5);

      expect(ptr1).toBeGreaterThan(0);
      expect(ptr2).toBe(ptr1 + 5);
      expect(ptr3).toBe(ptr2 + 5);
    });
  });

  describe("wasmDeallocate", () => {
    it("should not throw when deallocating", () => {
      const ptr = wasmAllocate(instance, 10);

      expect(() => {
        wasmDeallocate(instance, ptr);
      }).not.toThrow();
    });
  });
});

describe("MessagePack Serialization", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;

  beforeEach(async () => {
    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});
  });

  describe("serializeToWasm", () => {
    it("should serialize simple values", () => {
      const { ptr, len } = serializeToWasm(instance, 42);

      expect(ptr).toBeGreaterThanOrEqual(0);
      expect(len).toBeGreaterThan(0);

      // Verify we can read it back
      const result = deserializeFromWasm(instance, ptr, len);
      expect(result).toBe(42);
    });

    it("should serialize strings", () => {
      const { ptr, len } = serializeToWasm(instance, "hello");

      const result = deserializeFromWasm(instance, ptr, len);
      expect(result).toBe("hello");
    });

    it("should serialize objects", () => {
      const obj = { foo: "bar", num: 123 };
      const { ptr, len } = serializeToWasm(instance, obj);

      const result = deserializeFromWasm(instance, ptr, len);
      expect(result).toEqual(obj);
    });

    it("should serialize arrays", () => {
      const arr = [1, 2, 3, "four", { five: 5 }];
      const { ptr, len } = serializeToWasm(instance, arr);

      const result = deserializeFromWasm(instance, ptr, len);
      expect(result).toEqual(arr);
    });

    it("should serialize Uint8Array", () => {
      const data = new Uint8Array([10, 20, 30, 40]);
      const { ptr, len } = serializeToWasm(instance, data);

      const result = deserializeFromWasm(instance, ptr, len) as Uint8Array;
      expect(result).toEqual(data);
    });
  });

  describe("deserializeFromWasm", () => {
    it("should deserialize numbers", () => {
      const { ptr, len } = serializeToWasm(instance, 999);
      const result = deserializeFromWasm(instance, ptr, len);

      expect(result).toBe(999);
    });

    it("should deserialize booleans", () => {
      const { ptr: ptr1, len: len1 } = serializeToWasm(instance, true);
      const { ptr: ptr2, len: len2 } = serializeToWasm(instance, false);

      expect(deserializeFromWasm(instance, ptr1, len1)).toBe(true);
      expect(deserializeFromWasm(instance, ptr2, len2)).toBe(false);
    });

    it("should deserialize null", () => {
      const { ptr, len } = serializeToWasm(instance, null);
      const result = deserializeFromWasm(instance, ptr, len);

      expect(result).toBe(null);
    });

    it("should deserialize nested objects", () => {
      const nested = {
        level1: {
          level2: {
            level3: "deep",
          },
        },
      };

      const { ptr, len } = serializeToWasm(instance, nested);
      const result = deserializeFromWasm(instance, ptr, len);

      expect(result).toEqual(nested);
    });
  });

  describe("Round-trip serialization", () => {
    it("should preserve data through round-trip", () => {
      const testCases = [
        42,
        "test string",
        true,
        false,
        null,
        [1, 2, 3],
        { a: 1, b: "two" },
        new Uint8Array([1, 2, 3, 4]),
      ];

      testCases.forEach((testCase) => {
        const { ptr, len } = serializeToWasm(instance, testCase);
        const result = deserializeFromWasm(instance, ptr, len);
        expect(result).toEqual(testCase);
      });
    });
  });
});

describe("I64 Result Handling", () => {
  describe("createI64Result", () => {
    it("should create i64 from ptr and len", () => {
      const result = createI64Result(100, 50);

      // Extract back
      const ptr = Number(result >> 32n);
      const len = Number(result & 0xffffffffn);

      expect(ptr).toBe(100);
      expect(len).toBe(50);
    });

    it("should handle zero pointer", () => {
      const result = createI64Result(0, 100);

      const ptr = Number(result >> 32n);
      const len = Number(result & 0xffffffffn);

      expect(ptr).toBe(0);
      expect(len).toBe(100);
    });

    it("should handle maximum values", () => {
      const maxU32 = 0xffffffff;
      const result = createI64Result(maxU32, maxU32);

      const ptr = Number(result >> 32n);
      const len = Number(result & 0xffffffffn);

      expect(ptr).toBe(maxU32);
      expect(len).toBe(maxU32);
    });
  });

  describe("serializeResult", () => {
    let runtime: RibosomeRuntime;
    let instance: WebAssembly.Instance;

    beforeEach(async () => {
      runtime = new RibosomeRuntime();
      const module = await runtime.compileModule(allocatorWasmBytes);
      instance = await runtime.instantiateModule(module, {});
    });

    it("should serialize and return i64", () => {
      const data = { test: "data" };
      const result = serializeResult(instance, data);

      // Extract ptr and len
      const ptr = Number(result >> 32n);
      const len = Number(result & 0xffffffffn);

      expect(ptr).toBeGreaterThanOrEqual(0);
      expect(len).toBeGreaterThan(0);

      // Verify data
      const deserialized = deserializeFromWasm(instance, ptr, len);
      expect(deserialized).toEqual(data);
    });
  });
});

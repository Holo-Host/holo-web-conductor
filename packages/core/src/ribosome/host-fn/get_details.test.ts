/**
 * Tests for get_details host function
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDetails } from "./get_details";
import { CallContext } from "../call-context";
import { RibosomeRuntime } from "../runtime";
import { allocatorWasmBytes } from "../test/allocator-wasm-bytes";
import { serializeToWasm, deserializeFromWasm } from "../serialization";
import { HostFunctionContext } from "./base";
import { setStorageProvider, type StorageProvider } from "../../storage/storage-provider";
import type { CreateAction, UpdateAction, StoredEntry, RecordDetails } from "../../storage/types";

describe("get_details", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;

  // Mock storage
  const mockGetAction = vi.fn();
  const mockGetDetails = vi.fn();

  const mockStorage: Partial<StorageProvider> = {
    getAction: mockGetAction,
    getDetails: mockGetDetails,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setStorageProvider(mockStorage as StorageProvider);

    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});

    callContext = {
      cellId: [
        new Uint8Array(39).fill(100), // DNA hash
        new Uint8Array(39).fill(101), // Agent pub key
      ],
      zome: "test_zome",
      fn: "get_details_test",
      payload: null,
      provenance: new Uint8Array(39).fill(101),
    };

    hostContext = {
      instance,
      callContext,
    };
  });

  it("should return null when action not found", () => {
    mockGetAction.mockReturnValue(null);

    // Input is Vec<GetInput>
    const input = [{
      any_dht_hash: new Uint8Array(39).fill(1),
      get_options: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);

    const resultI64 = getDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    // Result is wrapped in Ok by serializeResult
    expect(result.Ok).toEqual([null]);
  });

  it("should return null when action has no entry hash", () => {
    // An action without entryHash (e.g., Dna, AgentValidationPkg)
    mockGetAction.mockReturnValue({
      actionHash: new Uint8Array(39).fill(1),
      actionType: "Dna",
      signature: new Uint8Array(64).fill(2),
    });

    const input = [{
      any_dht_hash: new Uint8Array(39).fill(1),
      get_options: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);

    const resultI64 = getDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toEqual([null]);
  });

  it("should return null when storage.getDetails returns null", () => {
    const actionHash = new Uint8Array(39).fill(1);
    const entryHash = new Uint8Array(39).fill(2);

    mockGetAction.mockReturnValue({
      actionHash,
      actionType: "Create",
      entryHash,
      signature: new Uint8Array(64).fill(3),
    });
    mockGetDetails.mockReturnValue(null);

    const input = [{
      any_dht_hash: actionHash,
      get_options: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);

    const resultI64 = getDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toEqual([null]);
  });

  it("should return RecordDetails for a Create action", () => {
    const actionHash = new Uint8Array(39).fill(1);
    const entryHash = new Uint8Array(39).fill(2);
    const signature = new Uint8Array(64).fill(3);
    const entryContent = new Uint8Array([1, 2, 3, 4]);

    const action: CreateAction = {
      actionHash,
      actionSeq: 1,
      author: new Uint8Array(39).fill(10),
      timestamp: 1000n,
      prevActionHash: null,
      actionType: "Create",
      signature,
      entryHash,
      entryType: { zome_id: 0, entry_index: 0 },
    };

    const entry: StoredEntry = {
      entryHash,
      entryContent,
      entryType: { zome_id: 0, entry_index: 0 },
    };

    const details: RecordDetails = {
      record: {
        actionHash,
        action,
        entry,
      },
      validationStatus: "Valid",
      updates: [],
      deletes: [],
    };

    mockGetAction.mockReturnValue(action);
    mockGetDetails.mockReturnValue(details);

    const input = [{
      any_dht_hash: actionHash,
      get_options: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);

    const resultI64 = getDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);
    const data = result.Ok;

    expect(data).toHaveLength(1);
    expect(data[0]).not.toBeNull();
    expect(data[0].type).toBe("Record");
    expect(data[0].content.record).toBeDefined();
    expect(data[0].content.updates).toEqual([]);
    expect(data[0].content.deletes).toEqual([]);
  });

  it("should include updates in RecordDetails", () => {
    const actionHash = new Uint8Array(39).fill(1);
    const entryHash = new Uint8Array(39).fill(2);
    const updateActionHash = new Uint8Array(39).fill(5);
    const updateEntryHash = new Uint8Array(39).fill(6);

    const action: CreateAction = {
      actionHash,
      actionSeq: 1,
      author: new Uint8Array(39).fill(10),
      timestamp: 1000n,
      prevActionHash: null,
      actionType: "Create",
      signature: new Uint8Array(64).fill(3),
      entryHash,
      entryType: { zome_id: 0, entry_index: 0 },
    };

    const updateAction: UpdateAction = {
      actionHash: updateActionHash,
      actionSeq: 2,
      author: new Uint8Array(39).fill(10),
      timestamp: 2000n,
      prevActionHash: actionHash,
      actionType: "Update",
      signature: new Uint8Array(64).fill(7),
      entryHash: updateEntryHash,
      entryType: { zome_id: 0, entry_index: 0 },
      originalActionHash: actionHash,
      originalEntryHash: entryHash,
    };

    const entry: StoredEntry = {
      entryHash,
      entryContent: new Uint8Array([1, 2, 3]),
      entryType: { zome_id: 0, entry_index: 0 },
    };

    const details: RecordDetails = {
      record: {
        actionHash,
        action,
        entry,
      },
      validationStatus: "Valid",
      updates: [{ updateHash: updateActionHash, updateAction }],
      deletes: [],
    };

    mockGetAction.mockReturnValue(action);
    mockGetDetails.mockReturnValue(details);

    const input = [{
      any_dht_hash: actionHash,
      get_options: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);

    const resultI64 = getDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toHaveLength(1);
    expect(result.Ok[0].type).toBe("Record");
    expect(result.Ok[0].content.updates).toHaveLength(1);
    // The update action hash should be in the hashed.hash field
    expect(result.Ok[0].content.updates[0].hashed).toBeDefined();
    expect(result.Ok[0].content.updates[0].hashed.hash).toEqual(updateActionHash);
  });

  it("should handle details.record being undefined gracefully", () => {
    const actionHash = new Uint8Array(39).fill(1);
    const entryHash = new Uint8Array(39).fill(2);

    const action: CreateAction = {
      actionHash,
      actionSeq: 1,
      author: new Uint8Array(39).fill(10),
      timestamp: 1000n,
      prevActionHash: null,
      actionType: "Create",
      signature: new Uint8Array(64).fill(3),
      entryHash,
      entryType: { zome_id: 0, entry_index: 0 },
    };

    // Simulate a broken storage response with no record
    const brokenDetails = {
      validationStatus: "Valid",
      updates: [],
      deletes: [],
      // record is missing!
    };

    mockGetAction.mockReturnValue(action);
    mockGetDetails.mockReturnValue(brokenDetails);

    const input = [{
      any_dht_hash: actionHash,
      get_options: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);

    const resultI64 = getDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    // Should return null gracefully when record is missing
    expect(result.Ok).toEqual([null]);
  });
});

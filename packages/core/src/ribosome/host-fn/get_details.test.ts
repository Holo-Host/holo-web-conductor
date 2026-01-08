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
import type { CreateAction, UpdateAction, StoredEntry, RecordDetails, EntryDetails } from "../../storage/types";
import { fakeEntryHash, fakeActionHash, fakeAgentPubKey, fakeDnaHash } from "@holochain/client";
import { HoloHashType } from "@holochain/client";
import { hashFrom32AndType } from "@holochain/client";

describe("get_details", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;

  // Mock storage
  const mockGetAction = vi.fn();
  const mockGetDetails = vi.fn();
  const mockGetEntryDetails = vi.fn();
  const mockGetEntry = vi.fn();

  const mockStorage: Partial<StorageProvider> = {
    getAction: mockGetAction,
    getDetails: mockGetDetails,
    getEntryDetails: mockGetEntryDetails,
    getEntry: mockGetEntry,
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

  it("should return null when action not found", async () => {
    mockGetAction.mockReturnValue(null);
    mockGetEntryDetails.mockReturnValue(null);

    // Use a proper action hash (will be treated as action hash query)
    const actionHash = await fakeActionHash();
    const input = [{
      any_dht_hash: actionHash,
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

  it("should return null when action has no entry hash", async () => {
    const actionHash = await fakeActionHash();

    // An action without entryHash (e.g., Dna, AgentValidationPkg)
    mockGetAction.mockReturnValue({
      actionHash,
      actionType: "Dna",
      signature: new Uint8Array(64).fill(2),
    });

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

  it("should return null when storage.getDetails returns null", async () => {
    const actionHash = await fakeActionHash();
    const entryHash = await fakeEntryHash();

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

  it("should return RecordDetails for a Create action", async () => {
    const actionHash = await fakeActionHash();
    const entryHash = await fakeEntryHash();
    const author = await fakeAgentPubKey();
    const signature = new Uint8Array(64).fill(3);
    const entryContent = new Uint8Array([1, 2, 3, 4]);

    const action: CreateAction = {
      actionHash,
      actionSeq: 1,
      author,
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

  it("should include updates in RecordDetails", async () => {
    const actionHash = await fakeActionHash();
    const entryHash = await fakeEntryHash();
    const updateActionHash = await fakeActionHash();
    const updateEntryHash = await fakeEntryHash();
    const author = await fakeAgentPubKey();

    const action: CreateAction = {
      actionHash,
      actionSeq: 1,
      author,
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
      author,
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

  it("should handle details.record being undefined gracefully", async () => {
    const actionHash = await fakeActionHash();
    const entryHash = await fakeEntryHash();
    const author = await fakeAgentPubKey();

    const action: CreateAction = {
      actionHash,
      actionSeq: 1,
      author,
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

  describe("entry hash queries", () => {
    it("should return EntryDetails when queried with an entry hash", async () => {
      // Create a proper entry hash (prefix [132, 33, 36] for Entry type)
      const entryHash = await fakeEntryHash();
      const actionHash = await fakeActionHash();
      const author = await fakeAgentPubKey();

      const action: CreateAction = {
        actionHash,
        actionSeq: 1,
        author,
        timestamp: 1000n,
        prevActionHash: null,
        actionType: "Create",
        signature: new Uint8Array(64).fill(3),
        entryHash,
        entryType: { zome_id: 0, entry_index: 0 },
      };

      const entry: StoredEntry = {
        entryHash,
        entryContent: new Uint8Array([1, 2, 3, 4]),
        entryType: { zome_id: 0, entry_index: 0 },
      };

      const entryDetails: EntryDetails = {
        entry,
        actions: [{ actionHash, action }],
        rejectedActions: [],
        deletes: [],
        updates: [],
        entryDhtStatus: "Live",
      };

      // When queried with entry hash, getAction returns null (not an action hash)
      mockGetAction.mockReturnValue(null);
      // But getEntryDetails returns the entry details
      mockGetEntryDetails.mockReturnValue(entryDetails);
      mockGetEntry.mockReturnValue(entry);

      const input = [{
        any_dht_hash: entryHash,
        get_options: null,
      }];
      const { ptr, len } = serializeToWasm(instance, input);

      const resultI64 = getDetails(hostContext, ptr, len);
      const resultPtr = Number(resultI64 >> 32n);
      const resultLen = Number(resultI64 & 0xffffffffn);
      const result = deserializeFromWasm(instance, resultPtr, resultLen);

      // Should return Details::Entry, not Details::Record
      expect(result.Ok).toHaveLength(1);
      expect(result.Ok[0]).not.toBeNull();
      expect(result.Ok[0].type).toBe("Entry");
      expect(result.Ok[0].content.entry).toBeDefined();
      expect(result.Ok[0].content.actions).toHaveLength(1);
      expect(result.Ok[0].content.entry_dht_status).toBe("Live");
    });

    it("should return null when entry hash not found", async () => {
      const entryHash = await fakeEntryHash();

      mockGetAction.mockReturnValue(null);
      mockGetEntryDetails.mockReturnValue(null);
      mockGetEntry.mockReturnValue(null);

      const input = [{
        any_dht_hash: entryHash,
        get_options: null,
      }];
      const { ptr, len } = serializeToWasm(instance, input);

      const resultI64 = getDetails(hostContext, ptr, len);
      const resultPtr = Number(resultI64 >> 32n);
      const resultLen = Number(resultI64 & 0xffffffffn);
      const result = deserializeFromWasm(instance, resultPtr, resultLen);

      expect(result.Ok).toEqual([null]);
    });
  });

});

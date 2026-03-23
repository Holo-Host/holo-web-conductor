/**
 * Tests for must_get_* host functions
 *
 * Tests must_get_entry, must_get_action, must_get_valid_record behavior
 * in both normal and validation contexts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mustGetEntry } from "./must_get_entry";
import { mustGetAction } from "./must_get_action";
import { mustGetValidRecord } from "./must_get_valid_record";
import { mustGetAgentActivity } from "./must_get_agent_activity";
import { getAgentActivity } from "./get_agent_activity";
import { CallContext } from "../call-context";
import { RibosomeRuntime } from "../runtime";
import { allocatorWasmBytes } from "../test/allocator-wasm-bytes";
import { serializeToWasm, deserializeFromWasm } from "../serialization";
import { HostFunctionContext } from "./base";
import {
  setStorageProvider,
  type StorageProvider,
} from "../../storage/storage-provider";
import {
  setNetworkService,
  resetNetworkCache,
} from "../../network";
import { fakeEntryHash, fakeActionHash, fakeAgentPubKey } from "@holochain/client";

describe("must_get_entry", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;

  const mockGetAction = vi.fn();
  const mockGetActionByEntryHash = vi.fn();
  const mockGetEntry = vi.fn();

  const mockStorage: Partial<StorageProvider> = {
    getAction: mockGetAction,
    getActionByEntryHash: mockGetActionByEntryHash,
    getEntry: mockGetEntry,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setStorageProvider(mockStorage as StorageProvider);
    setNetworkService(null);
    resetNetworkCache();

    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});

    callContext = {
      cellId: [
        new Uint8Array(39).fill(100),
        new Uint8Array(39).fill(101),
      ],
      zome: "test_zome",
      fn: "test_fn",
      payload: null,
      provenance: new Uint8Array(39).fill(101),
    };

    hostContext = { instance, callContext };
  });

  it("should return EntryHashed when entry is found", async () => {
    const entryHash = await fakeEntryHash();
    const actionHash = await fakeActionHash();
    const entryContent = new Uint8Array([1, 2, 3, 4]);

    // Cascade fetches by entry hash - needs getActionByEntryHash and getEntry
    mockGetActionByEntryHash.mockReturnValue({
      actionHash,
      actionType: "Create",
      entryHash,
      signature: new Uint8Array(64).fill(1),
      author: new Uint8Array(39).fill(101),
      actionSeq: 1,
      timestamp: 1000n,
      prevActionHash: null,
      entryType: { zome_id: 0, entry_index: 0 },
    });
    mockGetEntry.mockReturnValue({
      entryHash,
      entryContent,
      entryType: { zome_id: 0, entry_index: 0 },
    });

    const { ptr, len } = serializeToWasm(instance, entryHash);
    const resultI64 = mustGetEntry(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toBeDefined();
    expect(result.Ok.hash).toEqual(entryHash);
    expect(result.Ok.content).toBeDefined();
  });

  it("should throw Error in normal context when not found", async () => {
    const entryHash = await fakeEntryHash();

    mockGetActionByEntryHash.mockReturnValue(null);
    mockGetEntry.mockReturnValue(null);
    mockGetAction.mockReturnValue(null);

    const { ptr, len } = serializeToWasm(instance, entryHash);

    expect(() => {
      mustGetEntry(hostContext, ptr, len);
    }).toThrow("must_get_entry: Entry not found");
  });

  it("should throw UnresolvedDependenciesError in validation context when not found", async () => {
    const entryHash = await fakeEntryHash();

    mockGetActionByEntryHash.mockReturnValue(null);
    mockGetEntry.mockReturnValue(null);
    mockGetAction.mockReturnValue(null);

    const validationContext: CallContext = {
      ...callContext,
      isValidationContext: true,
    };
    const validationHostContext: HostFunctionContext = {
      instance,
      callContext: validationContext,
    };

    const { ptr, len } = serializeToWasm(instance, entryHash);

    try {
      mustGetEntry(validationHostContext, ptr, len);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.name).toBe("UnresolvedDependenciesError");
      expect(error.dependencies).toBeDefined();
      expect(error.dependencies.Hashes).toHaveLength(1);
    }
  });
});

describe("must_get_action", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;

  const mockGetAction = vi.fn();
  const mockGetEntry = vi.fn();

  const mockStorage: Partial<StorageProvider> = {
    getAction: mockGetAction,
    getEntry: mockGetEntry,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setStorageProvider(mockStorage as StorageProvider);
    setNetworkService(null);
    resetNetworkCache();

    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});

    callContext = {
      cellId: [
        new Uint8Array(39).fill(100),
        new Uint8Array(39).fill(101),
      ],
      zome: "test_zome",
      fn: "test_fn",
      payload: null,
      provenance: new Uint8Array(39).fill(101),
    };

    hostContext = { instance, callContext };
  });

  it("should return SignedActionHashed when action is found", async () => {
    const actionHash = await fakeActionHash();
    const entryHash = await fakeEntryHash();

    mockGetAction.mockReturnValue({
      actionHash,
      actionType: "Create",
      actionSeq: 1,
      author: new Uint8Array(39).fill(101),
      timestamp: 1000n,
      prevActionHash: null,
      signature: new Uint8Array(64).fill(2),
      entryHash,
      entryType: { zome_id: 0, entry_index: 0 },
    });
    mockGetEntry.mockReturnValue({
      entryHash,
      entryContent: new Uint8Array([1, 2, 3]),
      entryType: { zome_id: 0, entry_index: 0 },
    });

    const { ptr, len } = serializeToWasm(instance, actionHash);
    const resultI64 = mustGetAction(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toBeDefined();
    expect(result.Ok.hashed).toBeDefined();
    expect(result.Ok.hashed.hash).toEqual(actionHash);
    expect(result.Ok.signature).toBeDefined();
  });

  it("should throw Error in normal context when not found", async () => {
    const actionHash = await fakeActionHash();

    mockGetAction.mockReturnValue(null);

    const { ptr, len } = serializeToWasm(instance, actionHash);

    expect(() => {
      mustGetAction(hostContext, ptr, len);
    }).toThrow("must_get_action: Action not found");
  });

  it("should throw UnresolvedDependenciesError in validation context when not found", async () => {
    const actionHash = await fakeActionHash();

    mockGetAction.mockReturnValue(null);

    const validationContext: CallContext = {
      ...callContext,
      isValidationContext: true,
    };
    const validationHostContext: HostFunctionContext = {
      instance,
      callContext: validationContext,
    };

    const { ptr, len } = serializeToWasm(instance, actionHash);

    try {
      mustGetAction(validationHostContext, ptr, len);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.name).toBe("UnresolvedDependenciesError");
      expect(error.dependencies.Hashes).toHaveLength(1);
    }
  });
});

describe("must_get_valid_record", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;

  const mockGetAction = vi.fn();
  const mockGetEntry = vi.fn();

  const mockStorage: Partial<StorageProvider> = {
    getAction: mockGetAction,
    getEntry: mockGetEntry,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setStorageProvider(mockStorage as StorageProvider);
    setNetworkService(null);
    resetNetworkCache();

    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});

    callContext = {
      cellId: [
        new Uint8Array(39).fill(100),
        new Uint8Array(39).fill(101),
      ],
      zome: "test_zome",
      fn: "test_fn",
      payload: null,
      provenance: new Uint8Array(39).fill(101),
    };

    hostContext = { instance, callContext };
  });

  it("should return Record when found", async () => {
    const actionHash = await fakeActionHash();
    const entryHash = await fakeEntryHash();
    const entryContent = new Uint8Array([5, 6, 7, 8]);

    mockGetAction.mockReturnValue({
      actionHash,
      actionType: "Create",
      actionSeq: 1,
      author: new Uint8Array(39).fill(101),
      timestamp: 1000n,
      prevActionHash: null,
      signature: new Uint8Array(64).fill(3),
      entryHash,
      entryType: { zome_id: 0, entry_index: 0 },
    });
    mockGetEntry.mockReturnValue({
      entryHash,
      entryContent,
      entryType: { zome_id: 0, entry_index: 0 },
    });

    const { ptr, len } = serializeToWasm(instance, actionHash);
    const resultI64 = mustGetValidRecord(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toBeDefined();
    expect(result.Ok.signed_action).toBeDefined();
    expect(result.Ok.signed_action.hashed.hash).toEqual(actionHash);
  });

  it("should throw Error in normal context when not found", async () => {
    const actionHash = await fakeActionHash();

    mockGetAction.mockReturnValue(null);

    const { ptr, len } = serializeToWasm(instance, actionHash);

    expect(() => {
      mustGetValidRecord(hostContext, ptr, len);
    }).toThrow("must_get_valid_record: Record not found");
  });

  it("should throw UnresolvedDependenciesError in validation context when not found", async () => {
    const actionHash = await fakeActionHash();

    mockGetAction.mockReturnValue(null);

    const validationContext: CallContext = {
      ...callContext,
      isValidationContext: true,
    };
    const validationHostContext: HostFunctionContext = {
      instance,
      callContext: validationContext,
    };

    const { ptr, len } = serializeToWasm(instance, actionHash);

    try {
      mustGetValidRecord(validationHostContext, ptr, len);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.name).toBe("UnresolvedDependenciesError");
      expect(error.dependencies.Hashes).toHaveLength(1);
    }
  });
});

describe("must_get_agent_activity", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;

  const mockQueryActions = vi.fn();

  const mockStorage: Partial<StorageProvider> = {
    queryActions: mockQueryActions,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setStorageProvider(mockStorage as StorageProvider);
    setNetworkService(null);
    resetNetworkCache();

    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});

    callContext = {
      cellId: [
        new Uint8Array(39).fill(100),
        new Uint8Array(39).fill(101),
      ],
      zome: "test_zome",
      fn: "test_fn",
      payload: null,
      provenance: new Uint8Array(39).fill(101),
    };

    hostContext = { instance, callContext };
  });

  it("should return self agent activity from local storage", async () => {
    const selfAgent = callContext.cellId[1];
    const actionHash = await fakeActionHash();

    mockQueryActions.mockReturnValue([
      {
        actionHash,
        actionType: "Create",
        actionSeq: 1,
        author: selfAgent,
        timestamp: 1000n,
        prevActionHash: null,
        signature: new Uint8Array(64).fill(4),
        entryHash: await fakeEntryHash(),
        entryType: { zome_id: 0, entry_index: 0 },
      },
    ]);

    const input = {
      author: selfAgent,
      chain_filter: {
        chain_top: actionHash,
        filters: { Take: 50 },
      },
    };

    const { ptr, len } = serializeToWasm(instance, input);
    const resultI64 = mustGetAgentActivity(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toBeDefined();
    expect(Array.isArray(result.Ok)).toBe(true);
    expect(result.Ok).toHaveLength(1);
    expect(result.Ok[0].action).toBeDefined();
    expect(result.Ok[0].cached_entry).toBeNull();
  });

  it("should return empty array for self with no chain data in coordinator context", async () => {
    const selfAgent = callContext.cellId[1];

    mockQueryActions.mockReturnValue([]);

    const input = {
      author: selfAgent,
      chain_filter: {
        chain_top: await fakeActionHash(),
        filters: { Take: 50 },
      },
    };

    const { ptr, len } = serializeToWasm(instance, input);
    const resultI64 = mustGetAgentActivity(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toEqual([]);
  });

  it("should throw UnresolvedDependenciesError for self with no data in validation context", async () => {
    const selfAgent = callContext.cellId[1];

    mockQueryActions.mockReturnValue([]);

    const validationContext: CallContext = {
      ...callContext,
      isValidationContext: true,
    };
    const validationHostContext: HostFunctionContext = {
      instance,
      callContext: validationContext,
    };

    const input = {
      author: selfAgent,
      chain_filter: {
        chain_top: await fakeActionHash(),
        filters: { Take: 50 },
      },
    };

    const { ptr, len } = serializeToWasm(instance, input);

    try {
      mustGetAgentActivity(validationHostContext, ptr, len);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.name).toBe("UnresolvedDependenciesError");
      expect(error.dependencies.Hashes).toHaveLength(1);
    }
  });

  it("should throw HostFnError when network service is null for non-self agent", async () => {
    const otherAgent = await fakeAgentPubKey();
    setNetworkService(null);

    const input = {
      author: otherAgent,
      chain_filter: {
        chain_top: await fakeActionHash(),
        filters: { Take: 50 },
      },
    };

    const { ptr, len } = serializeToWasm(instance, input);
    expect(() => mustGetAgentActivity(hostContext, ptr, len)).toThrow(
      "Network service not available for must_get_agent_activity"
    );
  });

  it("should throw HostFnError when network returns null for non-self agent", async () => {
    const otherAgent = await fakeAgentPubKey();
    const mockNetworkService = {
      mustGetAgentActivitySync: vi.fn().mockReturnValue(null),
    };
    setNetworkService(mockNetworkService as any);

    const input = {
      author: otherAgent,
      chain_filter: {
        chain_top: await fakeActionHash(),
        filters: { Take: 50 },
      },
    };

    const { ptr, len } = serializeToWasm(instance, input);
    expect(() => mustGetAgentActivity(hostContext, ptr, len)).toThrow(
      "Network request for must_get_agent_activity failed"
    );
  });

  it("should throw HostFnError for IncompleteChain in coordinator context", async () => {
    const otherAgent = await fakeAgentPubKey();
    const mockNetworkService = {
      mustGetAgentActivitySync: vi.fn().mockReturnValue("IncompleteChain"),
    };
    setNetworkService(mockNetworkService as any);

    const input = {
      author: otherAgent,
      chain_filter: {
        chain_top: await fakeActionHash(),
        filters: { Take: 50 },
      },
    };

    const { ptr, len } = serializeToWasm(instance, input);
    expect(() => mustGetAgentActivity(hostContext, ptr, len)).toThrow(
      "must_get_agent_activity chain is incomplete for author"
    );
  });

  it("should throw UnresolvedDependenciesError for IncompleteChain in validation context", async () => {
    const otherAgent = await fakeAgentPubKey();
    const mockNetworkService = {
      mustGetAgentActivitySync: vi.fn().mockReturnValue("IncompleteChain"),
    };
    setNetworkService(mockNetworkService as any);

    const validationContext: CallContext = {
      ...callContext,
      isValidationContext: true,
    };
    const validationHostContext: HostFunctionContext = {
      instance,
      callContext: validationContext,
    };

    const input = {
      author: otherAgent,
      chain_filter: {
        chain_top: await fakeActionHash(),
        filters: { Take: 50 },
      },
    };

    const { ptr, len } = serializeToWasm(instance, input);
    try {
      mustGetAgentActivity(validationHostContext, ptr, len);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.name).toBe("UnresolvedDependenciesError");
    }
  });

  it("should use local storage (not network) when author is self", async () => {
    // Use the same agent as cellId[1] (self)
    const selfAgent = callContext.cellId[1];
    const actionHash = await fakeActionHash();

    const mockNetworkService = {
      mustGetAgentActivitySync: vi.fn(),
    };
    setNetworkService(mockNetworkService as any);

    mockQueryActions.mockReturnValue([
      {
        actionHash,
        actionType: "Create",
        actionSeq: 1,
        author: selfAgent,
        timestamp: 1000n,
        prevActionHash: null,
        signature: new Uint8Array(64).fill(4),
        entryHash: await fakeEntryHash(),
        entryType: { zome_id: 0, entry_index: 0 },
      },
    ]);

    const input = {
      author: selfAgent,
      chain_filter: {
        chain_top: actionHash,
        filters: { Take: 50 },
      },
    };

    const { ptr, len } = serializeToWasm(instance, input);
    const resultI64 = mustGetAgentActivity(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toBeDefined();
    expect(result.Ok).toHaveLength(1);
    // Network should NOT have been called
    expect(mockNetworkService.mustGetAgentActivitySync).not.toHaveBeenCalled();
  });
});

describe("get_agent_activity", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;

  const mockQueryActions = vi.fn();

  const mockStorage: Partial<StorageProvider> = {
    queryActions: mockQueryActions,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setStorageProvider(mockStorage as StorageProvider);
    setNetworkService(null);

    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});

    callContext = {
      cellId: [
        new Uint8Array(39).fill(100),
        new Uint8Array(39).fill(101),
      ],
      zome: "test_zome",
      fn: "test_fn",
      payload: null,
      provenance: new Uint8Array(39).fill(101),
    };

    hostContext = { instance, callContext };
  });

  it("should use local storage when agent is self", async () => {
    const selfAgent = callContext.cellId[1];
    const actionHash = await fakeActionHash();

    const mockNetworkService = {
      getAgentActivitySync: vi.fn(),
    };
    setNetworkService(mockNetworkService as any);

    mockQueryActions.mockReturnValue([
      {
        actionHash,
        actionType: "Create",
        actionSeq: 1,
        author: selfAgent,
        timestamp: 1000n,
        prevActionHash: null,
        signature: new Uint8Array(64).fill(1),
        entryHash: await fakeEntryHash(),
        entryType: { zome_id: 0, entry_index: 0 },
      },
    ]);

    const input = {
      agent_pubkey: selfAgent,
      chain_query_filter: {},
      activity_request: "Full",
      get_options: {},
    };

    const { ptr, len } = serializeToWasm(instance, input);
    const resultI64 = getAgentActivity(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toBeDefined();
    expect(result.Ok.valid_activity).toHaveLength(1);
    // ChainStatus::Valid wraps ChainHead
    expect(result.Ok.status).toEqual({ Valid: { action_seq: 1, hash: actionHash } });
    // HighestObserved.hash is Vec<ActionHash>
    expect(result.Ok.highest_observed).toEqual({ action_seq: 1, hash: [actionHash] });
    // Network should NOT have been called
    expect(mockNetworkService.getAgentActivitySync).not.toHaveBeenCalled();
  });

  it("should return empty activity for self with no chain data", async () => {
    const selfAgent = callContext.cellId[1];

    mockQueryActions.mockReturnValue([]);

    const input = {
      agent_pubkey: selfAgent,
      chain_query_filter: {},
      activity_request: "Full",
      get_options: {},
    };

    const { ptr, len } = serializeToWasm(instance, input);
    const resultI64 = getAgentActivity(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toBeDefined();
    expect(result.Ok.valid_activity).toEqual([]);
    expect(result.Ok.status).toBe("Empty");
  });

  it("should use network for non-self agent", async () => {
    const otherAgent = await fakeAgentPubKey();

    const mockNetworkService = {
      getAgentActivitySync: vi.fn().mockReturnValue({
        valid_activity: "NotRequested",
        rejected_activity: "NotRequested",
        status: "Valid",
        highest_observed: null,
        warrants: [],
      }),
    };
    setNetworkService(mockNetworkService as any);

    const input = {
      agent_pubkey: otherAgent,
      chain_query_filter: {},
      activity_request: "Status",
      get_options: {},
    };

    const { ptr, len } = serializeToWasm(instance, input);
    getAgentActivity(hostContext, ptr, len);

    // Network SHOULD have been called for non-self agent
    expect(mockNetworkService.getAgentActivitySync).toHaveBeenCalled();
    // Local storage should NOT have been queried
    expect(mockQueryActions).not.toHaveBeenCalled();
  });

  it("should throw HostFnError when network service is null for non-self agent", async () => {
    const otherAgent = await fakeAgentPubKey();
    setNetworkService(null);

    const input = {
      agent_pubkey: otherAgent,
      chain_query_filter: {},
      activity_request: "Full",
      get_options: {},
    };

    const { ptr, len } = serializeToWasm(instance, input);
    expect(() => getAgentActivity(hostContext, ptr, len)).toThrow(
      "Network service not available for get_agent_activity"
    );
  });

  it("should throw HostFnError when network returns null for non-self agent", async () => {
    const otherAgent = await fakeAgentPubKey();

    const mockNetworkService = {
      getAgentActivitySync: vi.fn().mockReturnValue(null),
    };
    setNetworkService(mockNetworkService as any);

    const input = {
      agent_pubkey: otherAgent,
      chain_query_filter: {},
      activity_request: "Full",
      get_options: {},
    };

    const { ptr, len } = serializeToWasm(instance, input);
    expect(() => getAgentActivity(hostContext, ptr, len)).toThrow(
      "Network request for agent activity failed"
    );
  });
});

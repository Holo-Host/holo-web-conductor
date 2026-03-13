/**
 * Tests for get_links_details host function
 *
 * Verifies that the returned SignedActionHashed includes all required fields
 * (especially prev_action) so that Rust deserialization succeeds.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getLinksDetails } from "./get_links_details";
import { CallContext } from "../call-context";
import { RibosomeRuntime } from "../runtime";
import { allocatorWasmBytes } from "../test/allocator-wasm-bytes";
import { serializeToWasm, deserializeFromWasm } from "../serialization";
import { HostFunctionContext } from "./base";
import { setStorageProvider, type StorageProvider } from "../../storage/storage-provider";
import { fakeActionHash, fakeAgentPubKey, fakeDnaHash, fakeEntryHash } from "@holochain/client";
import type { NetworkLink } from "../../network/types";

import type { CachedLinkDetail } from "../../network/types";

// vi.hoisted runs before vi.mock factory, so these are available inside it
const { mockCacheFns, mockCascadeObj } = vi.hoisted(() => ({
  mockCacheFns: {
    getLinkDetailsSync: vi.fn().mockReturnValue(null) as ReturnType<typeof vi.fn>,
    cacheLinkDetailsSync: vi.fn() as ReturnType<typeof vi.fn>,
  },
  mockCascadeObj: {
    fetchLinks: vi.fn().mockReturnValue([]) as ReturnType<typeof vi.fn>,
  },
}));

vi.mock("../../network", () => {
  return {
    Cascade: vi.fn().mockImplementation(() => mockCascadeObj),
    getNetworkCache: vi.fn().mockReturnValue(mockCacheFns),
    getNetworkService: vi.fn().mockReturnValue({}),
    __mockCascade: mockCascadeObj,
  };
});

// Access the mock cascade for test setup
async function getMockCascade() {
  const mod = await import("../../network");
  return (mod as any).__mockCascade;
}

describe("get_links_details", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;
  let dnaHash: Uint8Array;
  let agentPubKey: Uint8Array;

  const mockGetLinks = vi.fn().mockReturnValue([]);

  const mockStorage: Partial<StorageProvider> = {
    getLinks: mockGetLinks,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setStorageProvider(mockStorage as StorageProvider);

    dnaHash = await fakeDnaHash();
    agentPubKey = await fakeAgentPubKey();

    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});

    callContext = {
      cellId: [dnaHash, agentPubKey],
      zome: "test_zome",
      fn: "get_links_details_test",
      payload: null,
      provenance: agentPubKey,
    };

    hostContext = { instance, callContext };
  });

  it("should return empty results when no links found", async () => {
    const baseAddress = await fakeEntryHash();

    const input = [{
      base_address: baseAddress,
      link_type: 0,
      tag_prefix: null,
      after: null,
      before: null,
      author: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);

    const resultI64 = getLinksDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toHaveLength(1);
    expect(result.Ok[0]).toEqual([]);
  });

  it("should include prev_action in CreateLink action", async () => {
    const baseAddress = await fakeEntryHash();
    const targetAddress = await fakeEntryHash();
    const createLinkHash = await fakeActionHash();
    const prevAction = await fakeActionHash();
    const author = await fakeAgentPubKey();
    const signature = new Uint8Array(64).fill(42);

    const networkLink: NetworkLink = {
      create_link_hash: createLinkHash,
      base: baseAddress,
      target: targetAddress,
      zome_index: 0,
      link_type: 3,
      tag: new Uint8Array([1, 2, 3]),
      timestamp: 1000000,
      author,
      prev_action: prevAction,
      signature,
      action_seq: 5,
      weight: { bucket_id: 0, units: 0 },
    };

    const mockCascade = await getMockCascade();
    mockCascade.fetchLinks.mockReturnValue([networkLink]);

    const input = [{
      base_address: baseAddress,
      link_type: 3,
      tag_prefix: null,
      after: null,
      before: null,
      author: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);

    const resultI64 = getLinksDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    expect(result.Ok).toHaveLength(1);
    const linkDetails = result.Ok[0];
    expect(linkDetails).toHaveLength(1);

    // LinkDetails tuple: [SignedActionHashed, Vec<SignedActionHashed>]
    const [createAction, deletes] = linkDetails[0];
    expect(deletes).toEqual([]);

    // Verify the action structure
    const action = createAction.hashed.content;
    expect(action.type).toBe("CreateLink");
    expect(action.prev_action).toEqual(prevAction);
    expect(action.action_seq).toBe(5);
    expect(action.base_address).toEqual(baseAddress);
    expect(action.target_address).toEqual(targetAddress);
    expect(action.link_type).toBe(3);
    expect(action.tag).toEqual(new Uint8Array([1, 2, 3]));

    // Verify hash and signature
    expect(createAction.hashed.hash).toEqual(createLinkHash);
    expect(createAction.signature).toEqual(signature);
  });

  it("should use zero fallbacks when prev_action/signature are missing", async () => {
    const baseAddress = await fakeEntryHash();
    const targetAddress = await fakeEntryHash();
    const createLinkHash = await fakeActionHash();
    const author = await fakeAgentPubKey();

    // NetworkLink without prev_action/signature (locally-stored link)
    const networkLink: NetworkLink = {
      create_link_hash: createLinkHash,
      base: baseAddress,
      target: targetAddress,
      zome_index: 0,
      link_type: 1,
      tag: new Uint8Array([]),
      timestamp: 2000000,
      author,
    };

    const mockCascade = await getMockCascade();
    mockCascade.fetchLinks.mockReturnValue([networkLink]);

    const input = [{
      base_address: baseAddress,
      link_type: 1,
      tag_prefix: null,
      after: null,
      before: null,
      author: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);

    const resultI64 = getLinksDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    const [createAction] = result.Ok[0][0];
    const action = createAction.hashed.content;

    // prev_action should exist (zero-filled fallback) — this is what was missing before
    expect(action.prev_action).toBeDefined();
    expect(action.prev_action.length).toBe(39);

    // signature should be zero-filled fallback
    expect(createAction.signature).toBeDefined();
    expect(createAction.signature.length).toBe(64);

    // All 11 required CreateLink fields must be present
    expect(action.type).toBe("CreateLink");
    expect(action.author).toBeDefined();
    expect(action.timestamp).toBeDefined();
    expect(action.action_seq).toBeDefined();
    expect(action.prev_action).toBeDefined();
    expect(action.base_address).toBeDefined();
    expect(action.target_address).toBeDefined();
    expect(action.zome_index).toBeDefined();
    expect(action.link_type).toBeDefined();
    expect(action.tag).toBeDefined();
    expect(action.weight).toBeDefined();
  });
});

describe("get_links_details - cache interaction", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;
  let dnaHash: Uint8Array;
  let agentPubKey: Uint8Array;

  const mockGetLinks = vi.fn().mockReturnValue([]);

  const mockStorage: Partial<StorageProvider> = {
    getLinks: mockGetLinks,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setStorageProvider(mockStorage as StorageProvider);

    dnaHash = await fakeDnaHash();
    agentPubKey = await fakeAgentPubKey();

    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});

    callContext = {
      cellId: [dnaHash, agentPubKey],
      zome: "test_zome",
      fn: "get_links_details_test",
      payload: null,
      provenance: agentPubKey,
    };

    hostContext = { instance, callContext };
  });

  /** Helper: invoke getLinksDetails through WASM and return decoded result */
  async function callGetLinksDetails(baseAddress: Uint8Array, linkType: number) {
    const input = [{
      base_address: baseAddress,
      link_type: linkType,
      tag_prefix: null,
      after: null,
      before: null,
      author: null,
    }];
    const { ptr, len } = serializeToWasm(instance, input);
    const resultI64 = getLinksDetails(hostContext, ptr, len);
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);
    return deserializeFromWasm(instance, resultPtr, resultLen);
  }

  it("merges cached delete info into live network results", async () => {
    const baseAddress = await fakeEntryHash();
    const createLinkHash = await fakeActionHash();
    const deleteHash = await fakeActionHash();
    const author = await fakeAgentPubKey();

    const liveLink: NetworkLink = {
      create_link_hash: createLinkHash,
      base: baseAddress,
      target: await fakeEntryHash(),
      zome_index: 0,
      link_type: 5,
      tag: new Uint8Array([10]),
      timestamp: 1000000,
      author,
      prev_action: await fakeActionHash(),
      signature: new Uint8Array(64).fill(1),
      action_seq: 3,
      weight: { bucket_id: 0, units: 0 },
    };

    // Cascade returns this link as live (from network)
    const mockCascade = await getMockCascade();
    mockCascade.fetchLinks.mockReturnValue([liveLink]);

    // Cache says this link was previously seen with a delete
    mockCacheFns.getLinkDetailsSync.mockReturnValue([
      { create: liveLink, deleteHashes: [deleteHash] },
    ] as CachedLinkDetail[]);

    const result = await callGetLinksDetails(baseAddress, 5);

    // The output should include the CreateLink with 1 DeleteLink action
    expect(result.Ok).toHaveLength(1);
    const linkDetails = result.Ok[0];
    expect(linkDetails).toHaveLength(1);

    const [createAction, deletes] = linkDetails[0];
    expect(createAction.hashed.hash).toEqual(createLinkHash);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].hashed.content.type).toBe("DeleteLink");
    expect(deletes[0].hashed.hash).toEqual(deleteHash);
  });

  it("includes cached creates no longer returned by network", async () => {
    const baseAddress = await fakeEntryHash();
    const author = await fakeAgentPubKey();

    // linkA: still live on network
    const linkA: NetworkLink = {
      create_link_hash: await fakeActionHash(),
      base: baseAddress,
      target: await fakeEntryHash(),
      zome_index: 0,
      link_type: 2,
      tag: new Uint8Array([1]),
      timestamp: 1000000,
      author,
      prev_action: await fakeActionHash(),
      signature: new Uint8Array(64).fill(1),
      action_seq: 1,
      weight: { bucket_id: 0, units: 0 },
    };

    // linkB: deleted network-wide (no longer returned by cascade),
    // but was previously cached with its delete info
    const linkBCreateHash = await fakeActionHash();
    const linkBDeleteHash = await fakeActionHash();
    const linkB: NetworkLink = {
      create_link_hash: linkBCreateHash,
      base: baseAddress,
      target: await fakeEntryHash(),
      zome_index: 0,
      link_type: 2,
      tag: new Uint8Array([2]),
      timestamp: 900000,
      author,
      prev_action: await fakeActionHash(),
      signature: new Uint8Array(64).fill(2),
      action_seq: 0,
      weight: { bucket_id: 0, units: 0 },
    };

    // Cascade returns only linkA (linkB was deleted remotely)
    const mockCascade = await getMockCascade();
    mockCascade.fetchLinks.mockReturnValue([linkA]);

    // Cache has both linkA and linkB (linkB with its delete)
    mockCacheFns.getLinkDetailsSync.mockReturnValue([
      { create: linkA, deleteHashes: [] },
      { create: linkB, deleteHashes: [linkBDeleteHash] },
    ] as CachedLinkDetail[]);

    const result = await callGetLinksDetails(baseAddress, 2);

    // Output should have both: linkA (live) and linkB (with delete)
    expect(result.Ok).toHaveLength(1);
    const linkDetails = result.Ok[0];
    expect(linkDetails).toHaveLength(2);

    // Find linkA and linkB in results (order not guaranteed after merge)
    const resultA = linkDetails.find(
      ([create]: any) => create.hashed.hash.every((b: number, i: number) => b === linkA.create_link_hash[i])
    );
    const resultB = linkDetails.find(
      ([create]: any) => create.hashed.hash.every((b: number, i: number) => b === linkBCreateHash[i])
    );

    expect(resultA).toBeDefined();
    expect(resultA![1]).toHaveLength(0); // linkA has no deletes

    expect(resultB).toBeDefined();
    expect(resultB![1]).toHaveLength(1); // linkB has 1 delete
    expect(resultB![1][0].hashed.hash).toEqual(linkBDeleteHash);
  });

  it("writes merged results to cache after processing", async () => {
    const baseAddress = await fakeEntryHash();
    const author = await fakeAgentPubKey();

    // linkA: from network (new)
    const linkA: NetworkLink = {
      create_link_hash: await fakeActionHash(),
      base: baseAddress,
      target: await fakeEntryHash(),
      zome_index: 0,
      link_type: 7,
      tag: new Uint8Array([1]),
      timestamp: 1000000,
      author,
      prev_action: await fakeActionHash(),
      signature: new Uint8Array(64).fill(1),
      action_seq: 1,
      weight: { bucket_id: 0, units: 0 },
    };

    // linkB: only in cache (deleted from network)
    const linkBDeleteHash = await fakeActionHash();
    const linkB: NetworkLink = {
      create_link_hash: await fakeActionHash(),
      base: baseAddress,
      target: await fakeEntryHash(),
      zome_index: 0,
      link_type: 7,
      tag: new Uint8Array([2]),
      timestamp: 800000,
      author,
      prev_action: await fakeActionHash(),
      signature: new Uint8Array(64).fill(2),
      action_seq: 0,
      weight: { bucket_id: 0, units: 0 },
    };

    const mockCascade = await getMockCascade();
    mockCascade.fetchLinks.mockReturnValue([linkA]);

    mockCacheFns.getLinkDetailsSync.mockReturnValue([
      { create: linkB, deleteHashes: [linkBDeleteHash] },
    ] as CachedLinkDetail[]);

    await callGetLinksDetails(baseAddress, 7);

    // Verify cacheLinkDetailsSync was called with merged data
    expect(mockCacheFns.cacheLinkDetailsSync).toHaveBeenCalledTimes(1);
    const [cachedBase, cachedDetails, cachedLinkType] = mockCacheFns.cacheLinkDetailsSync.mock.calls[0];

    expect(cachedBase).toEqual(baseAddress);
    expect(cachedLinkType).toBe(7);

    // Should contain both linkA (from network) and linkB (from cache)
    expect(cachedDetails).toHaveLength(2);

    const cachedA = cachedDetails.find(
      (d: CachedLinkDetail) => d.create.create_link_hash.every((b: number, i: number) => b === linkA.create_link_hash[i])
    );
    const cachedB = cachedDetails.find(
      (d: CachedLinkDetail) => d.create.create_link_hash.every((b: number, i: number) => b === linkB.create_link_hash[i])
    );

    expect(cachedA).toBeDefined();
    expect(cachedA!.deleteHashes).toHaveLength(0);

    expect(cachedB).toBeDefined();
    expect(cachedB!.deleteHashes).toHaveLength(1);
    expect(cachedB!.deleteHashes[0]).toEqual(linkBDeleteHash);
  });
});

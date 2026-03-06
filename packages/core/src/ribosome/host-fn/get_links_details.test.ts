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

// Mock network modules
vi.mock("../../network", async () => {
  const mockCascade = {
    fetchLinks: vi.fn().mockReturnValue([]),
  };
  return {
    Cascade: vi.fn().mockImplementation(() => mockCascade),
    getNetworkCache: vi.fn().mockReturnValue({}),
    getNetworkService: vi.fn().mockReturnValue({}),
    __mockCascade: mockCascade,
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

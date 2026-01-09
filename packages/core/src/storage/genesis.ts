/**
 * Genesis Chain Initialization
 *
 * Initializes a new source chain with the 4 genesis actions:
 * 1. Dna (seq: 0)
 * 2. AgentValidationPkg (seq: 1)
 * 3. Create (Agent entry) (seq: 2)
 * 4. InitZomesComplete (seq: 3)
 */

import type { SourceChainStorage } from './source-chain-storage';
import type {
  DnaAction,
  AgentValidationPkgAction,
  CreateAction,
  InitZomesCompleteAction,
  StoredEntry,
  StoredAction,
} from './types';
import { computeActionHashV2, computeAgentEntryHash, serializeAction, dhtLocationFrom32, AGENT_PUBKEY_PREFIX } from '../hash';
import {
  buildDnaAction,
  buildAgentValidationPkgAction,
  buildCreateAction,
  buildInitZomesCompleteAction,
  type SerializableAction,
} from '../types/holochain-serialization';
import { signAction } from '../signing';
import type { PendingRecord } from '../ribosome/call-context';

/**
 * Result of genesis initialization
 */
export interface GenesisResult {
  /** Whether genesis was performed (false if chain already exists) */
  initialized: boolean;
  /** Records created during genesis (empty if not initialized) */
  pendingRecords: PendingRecord[];
}

/**
 * Initialize genesis actions for a new cell
 *
 * Creates the initial 4 actions that every Holochain source chain starts with.
 * Only runs if the chain is empty (no chain head exists).
 *
 * @param storage - Source chain storage instance
 * @param dnaHash - DNA hash for this cell
 * @param agentPubKey - Agent public key for this cell
 * @returns GenesisResult with initialized flag and pending records for publishing
 */
export async function initializeGenesis(
  storage: SourceChainStorage,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array
): Promise<GenesisResult> {
  console.log('[Genesis] Checking if chain needs initialization...');

  // Check if chain already has genesis actions
  const chainHead = await storage.getChainHead(dnaHash, agentPubKey);

  console.log('[Genesis] Chain head check result:', chainHead ? `seq=${chainHead.actionSeq}` : 'null');

  if (chainHead !== null) {
    // Chain already initialized
    console.log('[Genesis] Chain already initialized, skipping genesis');
    return { initialized: false, pendingRecords: [] };
  }

  // Collect pending records for publishing
  const pendingRecords: PendingRecord[] = [];

  console.log('[Genesis] Initializing genesis actions for new cell');

  const timestampMicros = Date.now() * 1000; // Microseconds as number for serialization
  const timestampBigInt = BigInt(timestampMicros); // BigInt for storage

  // Helper to sign serialized action bytes (NOT the hash - Holochain signs the Action struct)
  const signSerializedAction = (action: SerializableAction): Uint8Array => {
    const serialized = serializeAction(action);
    return signAction(agentPubKey, serialized);
  };

  // === 1. Dna Action (seq: 0) ===
  // Build action using type-safe builder (ensures correct field ordering for serialization)
  const dnaSerializableAction = buildDnaAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    hash: dnaHash,
  });
  const dnaActionHash = computeActionHashV2(dnaSerializableAction);

  const dnaAction: DnaAction = {
    actionHash: dnaActionHash,
    actionSeq: 0,
    author: agentPubKey,
    timestamp: timestampBigInt,
    prevActionHash: null, // First action has no previous
    actionType: 'Dna',
    signature: signSerializedAction(dnaSerializableAction),
    dnaHash,
  };

  await storage.putAction(dnaAction, dnaHash, agentPubKey);
  pendingRecords.push({ action: dnaAction as StoredAction });

  // === 2. AgentValidationPkg Action (seq: 1) ===
  const agentValidationSerializableAction = buildAgentValidationPkgAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    action_seq: 1,
    prev_action: dnaActionHash,
    // membrane_proof is optional
  });
  const agentValidationActionHash = computeActionHashV2(agentValidationSerializableAction);

  const agentValidationAction: AgentValidationPkgAction = {
    actionHash: agentValidationActionHash,
    actionSeq: 1,
    author: agentPubKey,
    timestamp: timestampBigInt,
    prevActionHash: dnaActionHash,
    actionType: 'AgentValidationPkg',
    signature: signSerializedAction(agentValidationSerializableAction),
    // membraneProof is optional
  };

  await storage.putAction(agentValidationAction, dnaHash, agentPubKey);
  pendingRecords.push({ action: agentValidationAction as StoredAction });

  // === 3. Create (Agent Entry) Action (seq: 2) ===
  // Extract core 32-byte Ed25519 key from agentPubKey (handles both 32 and 39 byte formats)
  // If 39 bytes: skip 3-byte prefix, take 32 bytes (bytes 3-34)
  // If 32 bytes: use directly
  const agentCore = agentPubKey.length === 39
    ? agentPubKey.slice(3, 35)
    : agentPubKey.slice(0, 32);

  // Create agent pubkey with proper prefix if needed
  let agentPubKeyPrefixed: Uint8Array;
  if (agentPubKey.length === 39) {
    agentPubKeyPrefixed = agentPubKey;
  } else {
    // Manually construct prefixed pubkey
    agentPubKeyPrefixed = new Uint8Array(39);
    agentPubKeyPrefixed.set(AGENT_PUBKEY_PREFIX, 0);
    agentPubKeyPrefixed.set(agentCore, 3);
    // DHT location for last 4 bytes (computed from core hash)
    agentPubKeyPrefixed.set(dhtLocationFrom32(agentCore), 35);
  }

  // For Agent entries, the entry hash is the AgentPubKey retyped with Entry prefix
  // (same 32-byte core, different prefix). This matches Holochain's HashableContent impl.
  const agentEntryHash = computeAgentEntryHash(agentPubKeyPrefixed);

  // Build Create action for Agent entry (uses "AgentPubKey" entry type)
  const agentCreateSerializableAction = buildCreateAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    action_seq: 2,
    prev_action: agentValidationActionHash,
    // Agent entry uses "AgentPubKey" entry type (matches Rust EntryType::AgentPubKey)
    entry_type: "AgentPubKey",
    entry_hash: agentEntryHash,
    weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
  });
  const agentCreateActionHash = computeActionHashV2(agentCreateSerializableAction);

  const agentCreateAction: CreateAction = {
    actionHash: agentCreateActionHash,
    actionSeq: 2,
    author: agentPubKey,
    timestamp: timestampBigInt,
    prevActionHash: agentValidationActionHash,
    actionType: 'Create',
    signature: signSerializedAction(agentCreateSerializableAction),
    entryHash: agentEntryHash,
    entryType: null, // Agent entry has null entryType in storage format
  };

  await storage.putAction(agentCreateAction, dnaHash, agentPubKey);

  // Store the agent entry
  const agentEntry: StoredEntry = {
    entryHash: agentEntryHash,
    entryContent: agentPubKeyPrefixed, // Agent entry content is the 39-byte prefixed pubkey
    entryType: 'Agent',
  };

  await storage.putEntry(agentEntry, dnaHash, agentPubKey);
  pendingRecords.push({ action: agentCreateAction as StoredAction, entry: agentEntry });

  // === 4. InitZomesComplete Action (seq: 3) ===
  const initZomesCompleteSerializableAction = buildInitZomesCompleteAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    action_seq: 3,
    prev_action: agentCreateActionHash,
  });
  const initZomesCompleteActionHash = computeActionHashV2(initZomesCompleteSerializableAction);

  const initZomesCompleteAction: InitZomesCompleteAction = {
    actionHash: initZomesCompleteActionHash,
    actionSeq: 3,
    author: agentPubKey,
    timestamp: timestampBigInt,
    prevActionHash: agentCreateActionHash,
    actionType: 'InitZomesComplete',
    signature: signSerializedAction(initZomesCompleteSerializableAction),
  };

  await storage.putAction(initZomesCompleteAction, dnaHash, agentPubKey);
  pendingRecords.push({ action: initZomesCompleteAction as StoredAction });

  // Update chain head to InitZomesComplete (seq: 3)
  await storage.updateChainHead(
    dnaHash,
    agentPubKey,
    3,
    initZomesCompleteActionHash,
    timestampBigInt
  );

  console.log('[Genesis] Genesis complete - chain initialized at seq: 3', {
    dnaActionHash: Array.from(dnaActionHash.slice(0, 8)),
    agentValidationActionHash: Array.from(agentValidationActionHash.slice(0, 8)),
    agentCreateActionHash: Array.from(agentCreateActionHash.slice(0, 8)),
    initZomesCompleteActionHash: Array.from(initZomesCompleteActionHash.slice(0, 8)),
    pendingRecordsCount: pendingRecords.length,
  });

  return { initialized: true, pendingRecords };
}

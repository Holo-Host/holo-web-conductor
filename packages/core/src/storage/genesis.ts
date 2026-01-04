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
} from './types';
import { hashFrom32AndType, HoloHashType } from '@holochain/client';

/**
 * Initialize genesis actions for a new cell
 *
 * Creates the initial 4 actions that every Holochain source chain starts with.
 * Only runs if the chain is empty (no chain head exists).
 *
 * @param storage - Source chain storage instance
 * @param dnaHash - DNA hash for this cell
 * @param agentPubKey - Agent public key for this cell
 */
export async function initializeGenesis(
  storage: SourceChainStorage,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array
): Promise<void> {
  console.log('[Genesis] Checking if chain needs initialization...');

  // Check if chain already has genesis actions
  const chainHead = await storage.getChainHead(dnaHash, agentPubKey);

  console.log('[Genesis] Chain head check result:', chainHead ? `seq=${chainHead.actionSeq}` : 'null');

  if (chainHead !== null) {
    // Chain already initialized
    console.log('[Genesis] Chain already initialized, skipping genesis');
    return;
  }

  console.log('[Genesis] Initializing genesis actions for new cell');

  const timestamp = BigInt(Date.now()) * 1000n; // Microseconds

  // Mock signature (64 bytes) - in production, would use Lair
  const mockSignature = new Uint8Array(64);
  crypto.getRandomValues(mockSignature);

  // === 1. Dna Action (seq: 0) ===
  const dnaActionHash = hashFrom32AndType(
    crypto.getRandomValues(new Uint8Array(32)),
    HoloHashType.Action
  );

  const dnaAction: DnaAction = {
    actionHash: dnaActionHash,
    actionSeq: 0,
    author: agentPubKey,
    timestamp,
    prevActionHash: null, // First action has no previous
    actionType: 'Dna',
    signature: mockSignature,
    dnaHash,
  };

  await storage.putAction(dnaAction, dnaHash, agentPubKey);

  // === 2. AgentValidationPkg Action (seq: 1) ===
  const agentValidationActionHash = hashFrom32AndType(
    crypto.getRandomValues(new Uint8Array(32)),
    HoloHashType.Action
  );

  const agentValidationAction: AgentValidationPkgAction = {
    actionHash: agentValidationActionHash,
    actionSeq: 1,
    author: agentPubKey,
    timestamp,
    prevActionHash: dnaActionHash,
    actionType: 'AgentValidationPkg',
    signature: mockSignature,
    // membraneProof is optional
  };

  await storage.putAction(agentValidationAction, dnaHash, agentPubKey);

  // === 3. Create (Agent Entry) Action (seq: 2) ===
  // Extract core 32-byte Ed25519 key from agentPubKey (handles both 32 and 39 byte formats)
  // If 39 bytes: skip 3-byte prefix, take 32 bytes (bytes 3-34)
  // If 32 bytes: use directly
  const agentCore = agentPubKey.length === 39
    ? agentPubKey.slice(3, 35)
    : agentPubKey.slice(0, 32);

  // Create EntryHash for the agent entry using @holochain/client utility
  const agentEntryHash = hashFrom32AndType(agentCore, HoloHashType.Entry);

  // Create ActionHash for the Create action
  const agentCreateActionHash = hashFrom32AndType(
    crypto.getRandomValues(new Uint8Array(32)),
    HoloHashType.Action
  );

  const agentCreateAction: CreateAction = {
    actionHash: agentCreateActionHash,
    actionSeq: 2,
    author: agentPubKey,
    timestamp,
    prevActionHash: agentValidationActionHash,
    actionType: 'Create',
    signature: mockSignature,
    entryHash: agentEntryHash,
    entryType: null, // Agent entry has null entryType
  };

  await storage.putAction(agentCreateAction, dnaHash, agentPubKey);

  // Store the agent entry
  // Agent entry content is the 39-byte prefixed AgentPubKey
  // If already prefixed, use as-is; otherwise wrap with @holochain/client utility
  const agentPubKeyPrefixed = agentPubKey.length === 39
    ? agentPubKey
    : hashFrom32AndType(agentCore, HoloHashType.Agent);

  const agentEntry: StoredEntry = {
    entryHash: agentEntryHash,
    entryContent: agentPubKeyPrefixed, // Agent entry content is the 39-byte prefixed pubkey
    entryType: 'Agent',
  };

  await storage.putEntry(agentEntry, dnaHash, agentPubKey);

  // === 4. InitZomesComplete Action (seq: 3) ===
  const initZomesCompleteActionHash = hashFrom32AndType(
    crypto.getRandomValues(new Uint8Array(32)),
    HoloHashType.Action
  );

  const initZomesCompleteAction: InitZomesCompleteAction = {
    actionHash: initZomesCompleteActionHash,
    actionSeq: 3,
    author: agentPubKey,
    timestamp,
    prevActionHash: agentCreateActionHash,
    actionType: 'InitZomesComplete',
    signature: mockSignature,
  };

  await storage.putAction(initZomesCompleteAction, dnaHash, agentPubKey);

  // Update chain head to InitZomesComplete (seq: 3)
  await storage.updateChainHead(
    dnaHash,
    agentPubKey,
    3,
    initZomesCompleteActionHash,
    timestamp
  );

  console.log('[Genesis] Genesis complete - chain initialized at seq: 3', {
    dnaActionHash: Array.from(dnaActionHash.slice(0, 8)),
    agentValidationActionHash: Array.from(agentValidationActionHash.slice(0, 8)),
    agentCreateActionHash: Array.from(agentCreateActionHash.slice(0, 8)),
    initZomesCompleteActionHash: Array.from(initZomesCompleteActionHash.slice(0, 8)),
  });
}

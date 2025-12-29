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
  const dnaActionHash = new Uint8Array(39);
  crypto.getRandomValues(dnaActionHash);
  dnaActionHash[0] = 0x84;
  dnaActionHash[1] = 0x29;
  dnaActionHash[2] = 0x24;

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
  const agentValidationActionHash = new Uint8Array(39);
  crypto.getRandomValues(agentValidationActionHash);
  agentValidationActionHash[0] = 0x84;
  agentValidationActionHash[1] = 0x29;
  agentValidationActionHash[2] = 0x24;

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
  // EntryHash for agent entry uses ENTRY_PREFIX (0x84, 0x21, 0x24)
  // NOT AGENT_PREFIX - the entry content is an AgentPubKey, but the hash is an EntryHash
  const agentEntryHash = new Uint8Array(39);
  agentEntryHash.set([0x84, 0x21, 0x24], 0); // ENTRY_PREFIX for EntryHash
  agentEntryHash.set(agentPubKey.slice(0, 32), 3);
  agentEntryHash.set([0, 0, 0, 0], 35);

  const agentCreateActionHash = new Uint8Array(39);
  crypto.getRandomValues(agentCreateActionHash);
  agentCreateActionHash[0] = 0x84;
  agentCreateActionHash[1] = 0x29;
  agentCreateActionHash[2] = 0x24;

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
  // Agent entry content needs to be 39-byte prefixed AgentPubKey
  const agentPubKeyPrefixed = new Uint8Array(39);
  agentPubKeyPrefixed.set([0x84, 0x20, 0x24], 0); // AGENT_PREFIX
  agentPubKeyPrefixed.set(agentPubKey, 3);
  agentPubKeyPrefixed.set([0, 0, 0, 0], 35);

  const agentEntry: StoredEntry = {
    entryHash: agentEntryHash,
    entryContent: agentPubKeyPrefixed, // Agent entry content is the 39-byte prefixed pubkey
    entryType: 'Agent',
  };

  await storage.putEntry(agentEntry, dnaHash, agentPubKey);

  // === 4. InitZomesComplete Action (seq: 3) ===
  const initZomesCompleteActionHash = new Uint8Array(39);
  crypto.getRandomValues(initZomesCompleteActionHash);
  initZomesCompleteActionHash[0] = 0x84;
  initZomesCompleteActionHash[1] = 0x29;
  initZomesCompleteActionHash[2] = 0x24;

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

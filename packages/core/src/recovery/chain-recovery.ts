/**
 * DHT Chain Recovery
 *
 * Recovers source chain data from the DHT for a given agent.
 * Uses the existing NetworkService interface (getAgentActivitySync, getRecordSync).
 */

import type { NetworkService, NetworkRecord, NetworkEntry } from '../network/types';
import type { StorageProvider } from '../storage/storage-provider';
import type { StoredAction, StoredEntry } from '../storage/types';
import { createLogger } from '@hwc/shared';

const log = createLogger('ChainRecovery');

// ============================================================================
// Public types
// ============================================================================

export interface RecoveryProgress {
  status: 'discovering' | 'fetching' | 'complete' | 'error';
  totalActions: number;
  recoveredActions: number;
  failedActions: number;
  errors: string[];
}

export type ProgressCallback = (progress: RecoveryProgress) => void;

/**
 * A chain record recovered from the DHT.
 *
 * signedAction and entry mirror the shape of NetworkRecord so callers can
 * directly write them into storage without additional conversion.
 */
export interface RecoveredRecord {
  actionHash: Uint8Array;
  /** The signed_action from the NetworkRecord */
  signedAction: any;
  /** Entry data when NetworkEntry is { Present: ... }, otherwise null */
  entry: any | null;
  actionSeq: number;
  timestamp: bigint;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Extract the seq number from a signedAction.
 * Holochain's SignedActionHashed places the action content in
 * signed_action.hashed.content, which is an internally-tagged enum
 * { type: "Create", action_seq: N, ... }.
 */
function seqFromSignedAction(signedAction: any): number {
  const content = signedAction?.hashed?.content;
  if (content === null || content === undefined) {
    return 0;
  }
  // The action_seq field is present on all non-Dna actions; Dna is always seq 0.
  return typeof content.action_seq === 'number' ? content.action_seq : 0;
}

/**
 * Extract the timestamp from a signedAction.
 * Timestamp is in microseconds since epoch, stored as a number or bigint.
 */
function timestampFromSignedAction(signedAction: any): bigint {
  const content = signedAction?.hashed?.content;
  if (content === null || content === undefined) {
    return BigInt(0);
  }
  const ts = content.timestamp;
  if (typeof ts === 'bigint') return ts;
  if (typeof ts === 'number') return BigInt(ts);
  return BigInt(0);
}

/**
 * Extract the action hash from a signedAction.
 * It lives in signed_action.hashed.hash.
 */
function hashFromSignedAction(signedAction: any): Uint8Array {
  const hash = signedAction?.hashed?.hash;
  if (hash instanceof Uint8Array) return hash;
  // If converted from JSON it may be an Array
  if (Array.isArray(hash)) return new Uint8Array(hash);
  return new Uint8Array(39);
}

/**
 * Unwrap a NetworkEntry to its payload, or return null.
 */
function entryPayload(entry: NetworkEntry): any | null {
  if (typeof entry === 'object' && entry !== null && 'Present' in entry) {
    return (entry as { Present: any }).Present;
  }
  return null;
}

/**
 * Build a RecoveredRecord from a NetworkRecord plus the seq/timestamp we
 * already know (from the Hashes variant). Seq/timestamp for the Full variant
 * are derived from the signed_action itself.
 */
function networkRecordToRecovered(networkRecord: NetworkRecord): RecoveredRecord {
  const signedAction = networkRecord.signed_action;
  return {
    actionHash: hashFromSignedAction(signedAction),
    signedAction,
    entry: entryPayload(networkRecord.entry),
    actionSeq: seqFromSignedAction(signedAction),
    timestamp: timestampFromSignedAction(signedAction),
  };
}

// ============================================================================
// Main export
// ============================================================================

/**
 * Recover chain data from the DHT for the given agent.
 *
 * Steps:
 * 1. Query agent activity to get action hashes (or full records).
 * 2. For each hash (Hashes variant), fetch the full record via getRecordSync.
 * 3. Return records in chain order (sorted by action_seq ascending).
 *
 * This function does NOT write to storage; the caller (worker) handles that.
 *
 * This function is synchronous because it runs in the worker context where
 * all network calls are sync via the Atomics bridge.
 */
export function recoverChainFromDHT(
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  networkService: NetworkService,
  onProgress: ProgressCallback
): { records: RecoveredRecord[]; errors: string[] } {
  const errors: string[] = [];

  // ── 1. Discover activity ──────────────────────────────────────────────────

  onProgress({
    status: 'discovering',
    totalActions: 0,
    recoveredActions: 0,
    failedActions: 0,
    errors: [],
  });

  log.info('Querying agent activity from DHT');
  const activity = networkService.getAgentActivitySync(dnaHash, agentPubKey, 'full');

  if (activity === null) {
    throw new Error('Agent not found on DHT');
  }

  const validActivity = activity.valid_activity;

  // ── 2. Handle NotRequested ────────────────────────────────────────────────

  if (validActivity === 'NotRequested') {
    log.warn('valid_activity is NotRequested - no chain data available');
    onProgress({
      status: 'complete',
      totalActions: 0,
      recoveredActions: 0,
      failedActions: 0,
      errors: [],
    });
    return { records: [], errors: [] };
  }

  // ── 3. Hashes variant: fetch each record individually ────────────────────

  if ('Hashes' in validActivity) {
    const hashPairs: Array<[number, Uint8Array]> = validActivity.Hashes.map(
      ([seq, hash]: [number, any]) => [seq, hash instanceof Uint8Array ? hash : new Uint8Array(hash)]
    );

    // Sort by sequence number ascending
    hashPairs.sort(([a], [b]) => a - b);

    const total = hashPairs.length;
    let recovered = 0;
    let failed = 0;

    onProgress({
      status: 'fetching',
      totalActions: total,
      recoveredActions: 0,
      failedActions: 0,
      errors: [],
    });

    const records: RecoveredRecord[] = [];

    for (const [seq, hash] of hashPairs) {
      log.debug(`Fetching record seq=${seq}`);
      try {
        const networkRecord = networkService.getRecordSync(dnaHash, hash);
        if (networkRecord === null) {
          const msg = `Record not found for action seq=${seq}`;
          log.warn(msg);
          errors.push(msg);
          failed++;
        } else {
          records.push(networkRecordToRecovered(networkRecord));
          recovered++;
        }
      } catch (err) {
        const msg = `Error fetching record seq=${seq}: ${err instanceof Error ? err.message : String(err)}`;
        log.error(msg);
        errors.push(msg);
        failed++;
      }

      onProgress({
        status: 'fetching',
        totalActions: total,
        recoveredActions: recovered,
        failedActions: failed,
        errors: [...errors],
      });
    }

    // Final sort by actionSeq to guarantee order even if network returned
    // records out of order (shouldn't happen, but be defensive).
    records.sort((a, b) => a.actionSeq - b.actionSeq);

    onProgress({
      status: errors.length > 0 && records.length === 0 ? 'error' : 'complete',
      totalActions: total,
      recoveredActions: recovered,
      failedActions: failed,
      errors: [...errors],
    });

    log.info(`Recovery complete: ${recovered} records, ${failed} failures`);
    return { records, errors };
  }

  // ── 4. Full variant: records embedded in the response ────────────────────

  if ('Full' in validActivity) {
    const fullItems: any[] = validActivity.Full;

    // Sort by action_seq derived from each item's signedAction
    const sorted = [...fullItems].sort((a, b) => {
      // Items in the Full variant are NetworkRecord-like objects
      const seqA = seqFromSignedAction(a?.signed_action ?? a);
      const seqB = seqFromSignedAction(b?.signed_action ?? b);
      return seqA - seqB;
    });

    const records: RecoveredRecord[] = sorted.map((item: any) => {
      // The Full variant items should already be NetworkRecord shaped, but
      // the API types them as `any[]`, so be defensive.
      const networkRecord: NetworkRecord = item;
      return networkRecordToRecovered(networkRecord);
    });

    onProgress({
      status: 'complete',
      totalActions: records.length,
      recoveredActions: records.length,
      failedActions: 0,
      errors: [],
    });

    log.info(`Recovery complete (Full variant): ${records.length} records`);
    return { records, errors: [] };
  }

  // Should not be reached given the ChainItems union, but satisfy TypeScript.
  throw new Error(`Unexpected valid_activity variant: ${JSON.stringify(validActivity)}`);
}

// ============================================================================
// Storage write helpers
// ============================================================================

/**
 * Ensure a value is a Uint8Array. If it's already one, return it; if it's an
 * Array (from JSON round-trip), wrap it.
 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  return new Uint8Array(0);
}

/**
 * Build a StoredAction from a RecoveredRecord's signed_action content.
 *
 * This maps the Holochain wire format (snake_case, content-embedded fields)
 * to the StoredAction format used by the storage layer.
 */
export function buildStorageAction(
  record: RecoveredRecord,
  fallbackAgent: Uint8Array
): StoredAction {
  const signedAction = record.signedAction;
  const content = signedAction?.hashed?.content;
  if (!content) {
    throw new Error(`Missing action content for seq=${record.actionSeq}`);
  }

  const signature = signedAction?.signature
    ? toBytes(signedAction.signature)
    : new Uint8Array(64);

  const author = content.author ? toBytes(content.author) : fallbackAgent;

  const prevActionHash = content.prev_action
    ? toBytes(content.prev_action)
    : null;

  const entryHash = content.entry_hash
    ? toBytes(content.entry_hash)
    : undefined;

  return {
    actionHash: record.actionHash,
    actionSeq: record.actionSeq,
    author,
    timestamp: record.timestamp,
    prevActionHash,
    actionType: content.type,
    signature,
    entryHash,
    entryType: content.entry_type,
    originalActionHash: content.original_action_address
      ? toBytes(content.original_action_address) : undefined,
    originalEntryHash: content.original_entry_address
      ? toBytes(content.original_entry_address) : undefined,
    deletesActionHash: content.deletes_address
      ? toBytes(content.deletes_address) : undefined,
    deletesEntryHash: content.deletes_entry_address
      ? toBytes(content.deletes_entry_address) : undefined,
    baseAddress: content.base_address
      ? toBytes(content.base_address) : undefined,
    targetAddress: content.target_address
      ? toBytes(content.target_address) : undefined,
    zomeIndex: content.zome_index ?? content.zome_id,
    linkType: content.link_type,
    tag: content.tag ? toBytes(content.tag) : undefined,
    linkAddAddress: undefined,
    dnaHash: content.type === 'Dna' && content.hash
      ? toBytes(content.hash) : undefined,
    membraneProof: undefined,
  } as StoredAction;
}

/**
 * Build a StoredEntry from a RecoveredRecord's entry data.
 * Returns null if the record has no entry or no entryHash.
 */
export function buildStorageEntry(
  record: RecoveredRecord,
  entryHash: Uint8Array | undefined
): StoredEntry | null {
  if (!record.entry || !entryHash) return null;

  const entryContent = record.entry.entry
    ? toBytes(record.entry.entry)
    : toBytes(record.entry);

  const content = record.signedAction?.hashed?.content;

  return {
    entryHash,
    entryContent,
    entryType: record.entry.entry_type || content?.entry_type,
  };
}

/**
 * Store recovered records into the storage layer.
 *
 * This is the logic previously inlined in ribosome-worker.ts RECOVER_CHAIN
 * handler, extracted so it can be tested without a web worker.
 *
 * @returns counts of recovered/failed records and any error messages
 */
export function storeRecoveredRecords(
  records: RecoveredRecord[],
  storage: StorageProvider,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array
): { recoveredCount: number; failedCount: number; errors: string[] } {
  let recoveredCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const record of records) {
    try {
      const storageAction = buildStorageAction(record, agentPubKey);

      storage.putAction(storageAction, dnaHash, agentPubKey);

      // entryHash lives on EntryAction variants (Create/Update), not the base union
      const entryHash = record.signedAction?.hashed?.content?.entry_hash
        ? toBytes(record.signedAction.hashed.content.entry_hash)
        : undefined;
      const entry = buildStorageEntry(record, entryHash);
      if (entry) {
        storage.putEntry(entry, dnaHash, agentPubKey);
      }

      storage.updateChainHead(
        dnaHash,
        agentPubKey,
        record.actionSeq,
        record.actionHash,
        record.timestamp
      );

      recoveredCount++;
    } catch (err) {
      const msg = `Failed to store record seq=${record.actionSeq}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      failedCount++;
    }
  }

  return { recoveredCount, failedCount, errors };
}

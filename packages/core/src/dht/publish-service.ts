/**
 * Publish Service
 *
 * Handles publishing DhtOps to the linker and managing the publish lifecycle.
 * Works with PublishTracker for persistence and retry logic.
 */

import { encodeHashToBase64, type DnaHash, type Record as HolochainRecord } from "@holochain/client";
import type { ChainOp } from "./dht-op-types";
import { PublishStatus } from "./dht-op-types";
import { PublishTracker } from "./publish-tracker";
import { serializeOpForLinker } from "./op-serialization";

/**
 * Options for the publish service
 */
export interface PublishServiceOptions {
  /** Linker base URL (e.g., "http://localhost:8090") */
  linkerUrl: string;
  /** Session token for authentication */
  sessionToken?: string;
  /** Maximum number of retries for failed publishes */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms) */
  baseDelayMs?: number;
  /** Maximum delay between retries (ms) */
  maxDelayMs?: number;
}

/**
 * Response from linker publish endpoint
 */
interface LinkerPublishResponse {
  /** Overall success (true if ops stored AND published to at least one peer) */
  success: boolean;
  /** Number of ops stored in TempOpStore */
  queued: number;
  /** Number of ops that failed to store */
  failed: number;
  /** Number of ops actually published to DHT peers (0 means retry needed) */
  published: number;
  /** Per-op storage results */
  results: Array<{
    success: boolean;
    error?: string;
  }>;
}

/**
 * Signed DhtOp for linker transmission
 */
interface SignedDhtOpPayload {
  op_data: string; // base64 msgpack encoded
  signature: string; // base64 signature
}

/**
 * Publish Service - manages publishing DhtOps to linker
 */
export class PublishService {
  private tracker: PublishTracker;
  private options: Required<PublishServiceOptions>;
  private processingQueue = false;

  constructor(options: PublishServiceOptions) {
    this.tracker = PublishTracker.getInstance();
    this.options = {
      linkerUrl: options.linkerUrl,
      sessionToken: options.sessionToken ?? "",
      maxRetries: options.maxRetries ?? 5,
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxDelayMs: options.maxDelayMs ?? 60000,
    };
  }

  /**
   * Initialize the service
   */
  async init(): Promise<void> {
    await this.tracker.init();
  }

  /**
   * Update linker URL (e.g., when connection changes)
   */
  setLinkerUrl(url: string): void {
    this.options.linkerUrl = url;
  }

  /**
   * Update session token
   */
  setSessionToken(token: string): void {
    this.options.sessionToken = token;
  }

  /**
   * Queue a record for publishing and immediately attempt to publish
   *
   * @param record - The Record to publish
   * @param dnaHash - DNA hash for routing
   * @returns Promise that resolves when ops are queued (not necessarily published)
   */
  async publishRecord(record: HolochainRecord, dnaHash: DnaHash): Promise<string[]> {
    // Queue the record's ops
    const publishIds = await this.tracker.queueRecordForPublish(record, dnaHash);

    // Trigger async processing (don't await - let it run in background)
    this.processQueue(dnaHash).catch((err) => {
      console.error("[PublishService] Background queue processing error:", err);
    });

    return publishIds;
  }

  /**
   * Process the publish queue for a DNA
   *
   * @param dnaHash - DNA hash to process
   */
  async processQueue(dnaHash: DnaHash): Promise<void> {
    if (this.processingQueue) {
      console.log("[PublishService] Queue already being processed, skipping");
      return;
    }

    this.processingQueue = true;

    try {
      // Loop to re-check for new ops that may have been added during processing
      let hasMoreOps = true;
      while (hasMoreOps) {
        // Get pending ops for this DNA
        const pendingOps = await this.tracker.getPendingForDna(
          dnaHash,
          PublishStatus.Pending
        );

        // Also get failed ops that are ready for retry
        const failedOps = await this.tracker.getPendingForDna(
          dnaHash,
          PublishStatus.Failed
        );
        const retryableOps = failedOps.filter(
          (op) =>
            op.retryCount < this.options.maxRetries &&
            this.isReadyForRetry(op.lastAttempt, op.retryCount)
        );

        const opsToPublish = [...pendingOps, ...retryableOps];

        if (opsToPublish.length === 0) {
          console.log("[PublishService] No more ops to publish");
          hasMoreOps = false;
          break;
        }

        console.log(
          `[PublishService] Processing ${opsToPublish.length} ops for publish`
        );

        // Group ops by batch for efficiency (max 50 per request)
        const batches = this.batchOps(opsToPublish, 50);

        for (const batch of batches) {
          await this.publishBatch(batch, dnaHash);
        }

        // After processing, loop back to check for new ops that arrived during processing
      }
    } finally {
      this.processingQueue = false;
    }
  }

  /**
   * Check if an op is ready for retry based on exponential backoff
   */
  private isReadyForRetry(lastAttempt: number, retryCount: number): boolean {
    if (lastAttempt === 0) return true;

    const delay = Math.min(
      this.options.baseDelayMs * Math.pow(2, retryCount),
      this.options.maxDelayMs
    );

    return Date.now() - lastAttempt >= delay;
  }

  /**
   * Split ops into batches
   */
  private batchOps<T>(ops: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < ops.length; i += batchSize) {
      batches.push(ops.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Publish a batch of ops to the linker
   */
  private async publishBatch(
    batch: Array<{
      id: string;
      op: ChainOp;
      retryCount: number;
    }>,
    dnaHash: DnaHash
  ): Promise<void> {
    // Mark all as in-flight
    for (const item of batch) {
      await this.tracker.updateStatus(item.id, PublishStatus.InFlight);
    }

    try {
      // Serialize ops for linker
      const signedOps = await Promise.all(
        batch.map((item) => this.serializeOpForLinkerPayload(item.op))
      );

      // Send to linker
      const response = await this.sendToLinker(dnaHash, signedOps);

      // Check if ops were stored but not published to any peers
      // This happens when no DHT peers are available
      const noPeersAvailable = response.queued > 0 && response.published === 0;

      if (noPeersAvailable) {
        console.warn(
          `[PublishService] Ops stored but no DHT peers available - ${response.queued} ops need retry`
        );
      }

      // Update status based on response
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const result = response.results[i];

        if (result?.success) {
          if (noPeersAvailable) {
            // Op was stored but not published to network - keep for retry
            await this.tracker.updateStatus(
              item.id,
              PublishStatus.Failed,
              "No DHT peers available - stored but not published"
            );
            console.log(`[PublishService] Op ${item.id} stored but needs retry (no peers)`);
          } else {
            // Op was stored AND published to at least one peer
            await this.tracker.updateStatus(item.id, PublishStatus.Published);
            await this.tracker.removePendingPublish(item.id);
            console.log(`[PublishService] Op ${item.id} published successfully`);
          }
        } else {
          await this.tracker.updateStatus(
            item.id,
            PublishStatus.Failed,
            result?.error ?? "Unknown error"
          );
          console.warn(
            `[PublishService] Op ${item.id} failed: ${result?.error}`
          );
        }
      }
    } catch (err) {
      // Network or other error - mark all as failed
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      for (const item of batch) {
        await this.tracker.updateStatus(item.id, PublishStatus.Failed, errorMsg);
      }
      console.error("[PublishService] Batch publish failed:", errorMsg);
    }
  }

  /**
   * Serialize a ChainOp for linker transmission
   *
   * The linker expects:
   * - op_data: base64 encoded msgpack serialized DhtOp
   * - signature: base64 encoded 64-byte Ed25519 signature
   */
  private async serializeOpForLinkerPayload(op: ChainOp): Promise<SignedDhtOpPayload> {
    // Use the extracted serialization function
    const opBytes = serializeOpForLinker(op);

    // Convert to base64
    const opBase64 = this.uint8ArrayToBase64(opBytes);

    // Get signature from the op (already signed by action)
    const signatureBase64 = this.uint8ArrayToBase64(op.signature);

    return {
      op_data: opBase64,
      signature: signatureBase64,
    };
  }

  /**
   * Send ops to the linker publish endpoint
   */
  private async sendToLinker(
    dnaHash: DnaHash,
    ops: SignedDhtOpPayload[]
  ): Promise<LinkerPublishResponse> {
    // Use @holochain/client's encodeHashToBase64 for proper HoloHash format (u prefix)
    const dnaHashB64 = encodeHashToBase64(dnaHash);
    const url = `${this.options.linkerUrl}/dht/${dnaHashB64}/publish`;
    console.log(`[PublishService] Publishing to: ${url}`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.options.sessionToken) {
      headers["Authorization"] = `Bearer ${this.options.sessionToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ops }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Linker publish failed: ${response.status} - ${text}`);
    }

    return (await response.json()) as LinkerPublishResponse;
  }

  /**
   * Convert Uint8Array to standard base64
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert Uint8Array to URL-safe base64 (for path parameters)
   */
  private uint8ArrayToBase64Url(bytes: Uint8Array): string {
    const base64 = this.uint8ArrayToBase64(bytes);
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  /**
   * Get current publish status counts
   */
  async getStatusCounts(): Promise<Record<PublishStatus, number>> {
    return this.tracker.getStatusCounts();
  }

  /**
   * Retry all failed publishes for a DNA
   */
  async retryFailed(dnaHash: DnaHash): Promise<void> {
    const failed = await this.tracker.getPendingForDna(
      dnaHash,
      PublishStatus.Failed
    );

    // Reset retry count for manual retry
    for (const op of failed) {
      await this.tracker.updateStatus(op.id, PublishStatus.Pending);
    }

    // Process the queue
    await this.processQueue(dnaHash);
  }

  /**
   * Clear all publish tracking (for testing)
   */
  async clear(): Promise<void> {
    await this.tracker.clear();
  }
}

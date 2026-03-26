/**
 * Publish retry on reconnect.
 *
 * Shared logic used by both the Chrome offscreen document and the Firefox
 * base-executor to retry failed publishes when the WebSocket reconnects.
 * Pings the linker for peer count, resets exhausted-retry ops back to
 * pending, then processes the queue.
 */

import { decodeHashFromBase64 } from "@holochain/client";
import type { WebSocketNetworkService } from "../network/websocket-service";
import type { PublishService } from "./publish-service";
import { PublishTracker } from "./publish-tracker";
import type { Logger } from "@hwc/shared";

/**
 * Ping the linker for peer availability, reset failed ops, then process
 * the publish queue for all registered DNAs.
 *
 * On reconnect the previous failure reasons (e.g. "no peers") are likely
 * stale, so all failed ops — including those that exhausted their retry
 * limit — are reset to Pending before queue processing.
 *
 * @param wsService - WebSocket service (for peer count and registrations)
 * @param publishService - Publish service (for queue processing)
 * @param log - Logger instance
 * @param timeoutMs - Max time to wait for pong (default 5000)
 */
export async function retryPublishesAfterReconnect(
  wsService: WebSocketNetworkService,
  publishService: PublishService,
  log: Logger,
  timeoutMs = 5000,
): Promise<void> {
  const peerCount = await wsService.pingForPeerCount(timeoutMs);
  log.info(`Connection established, peer count: ${peerCount ?? 'unknown'} - auto-retrying publishes`);

  const registrations = wsService.getRegistrations();
  if (registrations.length === 0) return;

  const uniqueDnas = new Set(registrations.map(r => r.dna_hash));
  const dnaHashes = [...uniqueDnas].map(b64 => decodeHashFromBase64(b64));

  // Reset all failed ops back to Pending so they get retried,
  // including ops that exhausted their retry count.
  const tracker = PublishTracker.getInstance();
  const resetCount = await tracker.resetFailedForDnas(dnaHashes);
  if (resetCount > 0) {
    log.info(`Reset ${resetCount} failed ops to pending for retry`);
  }

  for (const dnaHash of dnaHashes) {
    publishService.processQueue(dnaHash).catch(err => {
      log.warn(`Auto-retry failed for DNA ${encodeB64Short(dnaHash)}:`, err);
    });
  }
}

function encodeB64Short(hash: Uint8Array): string {
  // Quick prefix for logging — avoid importing encodeHashToBase64 just for this
  return `${hash[0]}..${hash[hash.length - 1]}(${hash.length}b)`;
}

/**
 * Publish retry on reconnect.
 *
 * Shared logic used by both the Chrome offscreen document and the Firefox
 * base-executor to retry failed publishes when the WebSocket reconnects.
 * Pings the linker for peer count before processing the queue.
 */

import { decodeHashFromBase64 } from "@holochain/client";
import type { WebSocketNetworkService } from "../network/websocket-service";
import type { PublishService } from "./publish-service";
import type { Logger } from "@hwc/shared";

/**
 * Ping the linker for peer availability, then process the publish queue
 * for all registered DNAs.
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
  for (const dnaHashB64 of uniqueDnas) {
    const dnaHash = decodeHashFromBase64(dnaHashB64);
    publishService.processQueue(dnaHash).catch(err => {
      log.warn(`Auto-retry failed for DNA ${dnaHashB64.substring(0, 15)}...:`, err);
    });
  }
}

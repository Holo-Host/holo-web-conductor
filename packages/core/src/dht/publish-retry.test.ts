/**
 * Tests for retryPublishesAfterReconnect.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { retryPublishesAfterReconnect } from "./publish-retry";
import type { WebSocketNetworkService } from "../network/websocket-service";
import type { PublishService } from "./publish-service";
import type { Logger } from "@hwc/shared";

function createMockWsService(overrides: Partial<WebSocketNetworkService> = {}): WebSocketNetworkService {
  return {
    pingForPeerCount: vi.fn().mockResolvedValue(3),
    getRegistrations: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as WebSocketNetworkService;
}

function createMockPublishService(): PublishService {
  return {
    processQueue: vi.fn().mockResolvedValue(undefined),
  } as unknown as PublishService;
}

function createMockLog(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("retryPublishesAfterReconnect", () => {
  let wsService: ReturnType<typeof createMockWsService>;
  let publishService: ReturnType<typeof createMockPublishService>;
  let log: ReturnType<typeof createMockLog>;

  beforeEach(() => {
    wsService = createMockWsService();
    publishService = createMockPublishService();
    log = createMockLog();
  });

  it("pings for peer count before processing", async () => {
    wsService = createMockWsService({
      getRegistrations: vi.fn().mockReturnValue([
        { dna_hash: "uhC0kAAAA", agent_pubkey: "uhCAkBBBB" },
      ]),
    } as any);

    await retryPublishesAfterReconnect(wsService, publishService as any, log);

    expect(wsService.pingForPeerCount).toHaveBeenCalledWith(5000);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("peer count: 3")
    );
  });

  it("processes queue for each unique DNA", async () => {
    wsService = createMockWsService({
      getRegistrations: vi.fn().mockReturnValue([
        { dna_hash: "uhC0kAAAA", agent_pubkey: "uhCAkBBBB" },
        { dna_hash: "uhC0kCCCC", agent_pubkey: "uhCAkBBBB" },
        { dna_hash: "uhC0kAAAA", agent_pubkey: "uhCAkDDDD" }, // duplicate DNA
      ]),
    } as any);

    await retryPublishesAfterReconnect(wsService, publishService as any, log);

    // Should process 2 unique DNAs, not 3
    expect(publishService.processQueue).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no registrations", async () => {
    await retryPublishesAfterReconnect(wsService, publishService as any, log);

    expect(wsService.pingForPeerCount).toHaveBeenCalled();
    expect(publishService.processQueue).not.toHaveBeenCalled();
  });

  it("passes custom timeout to pingForPeerCount", async () => {
    await retryPublishesAfterReconnect(wsService, publishService as any, log, 10000);

    expect(wsService.pingForPeerCount).toHaveBeenCalledWith(10000);
  });

  it("logs peer count as unknown when undefined", async () => {
    wsService = createMockWsService({
      pingForPeerCount: vi.fn().mockResolvedValue(undefined),
    } as any);

    await retryPublishesAfterReconnect(wsService, publishService as any, log);

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("peer count: unknown")
    );
  });
});

/**
 * Tests for retryPublishesAfterReconnect.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { retryPublishesAfterReconnect } from "./publish-retry";
import type { WebSocketNetworkService } from "../network/websocket-service";
import type { PublishService } from "./publish-service";
import type { PublishTracker } from "./publish-tracker";
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

function createMockTracker(): PublishTracker {
  return {
    resetFailedForDnas: vi.fn().mockResolvedValue(0),
  } as unknown as PublishTracker;
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
  let tracker: ReturnType<typeof createMockTracker>;
  let log: ReturnType<typeof createMockLog>;

  beforeEach(() => {
    wsService = createMockWsService();
    publishService = createMockPublishService();
    tracker = createMockTracker();
    log = createMockLog();
  });

  it("pings for peer count before processing", async () => {
    wsService = createMockWsService({
      getRegistrations: vi.fn().mockReturnValue([
        { dna_hash: "uhC0kAAAA", agent_pubkey: "uhCAkBBBB" },
      ]),
    } as any);

    await retryPublishesAfterReconnect(wsService, publishService as any, tracker as any, log);

    expect(wsService.pingForPeerCount).toHaveBeenCalledWith(5000);
  });

  it("resets failed ops to pending before processing queue", async () => {
    (tracker.resetFailedForDnas as any).mockResolvedValue(4);
    wsService = createMockWsService({
      getRegistrations: vi.fn().mockReturnValue([
        { dna_hash: "uhC0kAAAA", agent_pubkey: "uhCAkBBBB" },
      ]),
    } as any);

    await retryPublishesAfterReconnect(wsService, publishService as any, tracker as any, log);

    expect(tracker.resetFailedForDnas).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("reset 4 failed ops")
    );
    expect(publishService.processQueue).toHaveBeenCalled();
  });

  it("processes queue for each unique DNA", async () => {
    wsService = createMockWsService({
      getRegistrations: vi.fn().mockReturnValue([
        { dna_hash: "uhC0kAAAA", agent_pubkey: "uhCAkBBBB" },
        { dna_hash: "uhC0kCCCC", agent_pubkey: "uhCAkBBBB" },
        { dna_hash: "uhC0kAAAA", agent_pubkey: "uhCAkDDDD" }, // duplicate DNA
      ]),
    } as any);

    await retryPublishesAfterReconnect(wsService, publishService as any, tracker as any, log);

    // Should process 2 unique DNAs, not 3
    expect(publishService.processQueue).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no registrations", async () => {
    await retryPublishesAfterReconnect(wsService, publishService as any, tracker as any, log);

    expect(wsService.pingForPeerCount).toHaveBeenCalled();
    expect(tracker.resetFailedForDnas).not.toHaveBeenCalled();
    expect(publishService.processQueue).not.toHaveBeenCalled();
  });

  it("logs skip message when no registrations", async () => {
    await retryPublishesAfterReconnect(wsService, publishService as any, tracker as any, log);

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("no DNAs registered")
    );
  });

  it("passes custom timeout to pingForPeerCount", async () => {
    await retryPublishesAfterReconnect(wsService, publishService as any, tracker as any, log, 10000);

    expect(wsService.pingForPeerCount).toHaveBeenCalledWith(10000);
  });

  it("logs peer count as unknown when undefined", async () => {
    wsService = createMockWsService({
      pingForPeerCount: vi.fn().mockResolvedValue(undefined),
    } as any);

    await retryPublishesAfterReconnect(wsService, publishService as any, tracker as any, log);

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("peer count: unknown")
    );
  });

  it("does not log reset count when no failed ops", async () => {
    wsService = createMockWsService({
      getRegistrations: vi.fn().mockReturnValue([
        { dna_hash: "uhC0kAAAA", agent_pubkey: "uhCAkBBBB" },
      ]),
    } as any);

    await retryPublishesAfterReconnect(wsService, publishService as any, tracker as any, log);

    const infoCalls = (log.info as any).mock.calls.map((c: any) => c[0]);
    expect(infoCalls.some((msg: string) => msg.includes("reset"))).toBe(false);
  });

  it("logs DNA hash prefix on processQueue failure", async () => {
    (publishService.processQueue as any).mockRejectedValue(new Error("network down"));
    wsService = createMockWsService({
      getRegistrations: vi.fn().mockReturnValue([
        { dna_hash: "uhC0kAAAABBBBCCCC", agent_pubkey: "uhCAkBBBB" },
      ]),
    } as any);

    await retryPublishesAfterReconnect(wsService, publishService as any, tracker as any, log);

    // Wait for the fire-and-forget catch to log the warning
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("uhC0kAAAABBBBCC"),
        expect.any(Error)
      );
    });
  });
});

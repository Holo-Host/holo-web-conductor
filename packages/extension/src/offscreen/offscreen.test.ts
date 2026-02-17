/**
 * Tests for offscreen document helper functions
 *
 * These tests verify the logic that doesn't require Chrome APIs
 */

import { describe, it, expect } from "vitest";

// Helper function extracted from offscreen/index.ts for testing
function httpToWsUrl(httpUrl: string): string {
  return httpUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .replace(/\/$/, "") + "/ws";
}

describe("Offscreen Document Helpers", () => {
  describe("httpToWsUrl", () => {
    it("should convert http URL to ws URL", () => {
      expect(httpToWsUrl("http://localhost:8090")).toBe(
        "ws://localhost:8090/ws"
      );
    });

    it("should convert https URL to wss URL", () => {
      expect(httpToWsUrl("https://linker.example.com")).toBe(
        "wss://linker.example.com/ws"
      );
    });

    it("should remove trailing slash before adding /ws", () => {
      expect(httpToWsUrl("http://localhost:8090/")).toBe(
        "ws://localhost:8090/ws"
      );
    });

    it("should handle URL with port", () => {
      expect(httpToWsUrl("http://192.168.1.100:3000")).toBe(
        "ws://192.168.1.100:3000/ws"
      );
    });

    it("should handle URL with path", () => {
      expect(httpToWsUrl("http://localhost:8090/api/v1")).toBe(
        "ws://localhost:8090/api/v1/ws"
      );
    });
  });

  describe("Signal byte preservation", () => {
    it("should preserve signal bytes through array conversion round-trip", () => {
      // This is the actual conversion that happens during Chrome message passing
      const originalSignal = new Uint8Array([0xff, 0x00, 0xab, 0xcd, 0x12, 0x34]);
      const arraySignal = Array.from(originalSignal);
      const restoredSignal = new Uint8Array(arraySignal);

      expect(restoredSignal).toEqual(originalSignal);
    });

    it("should handle empty signal bytes", () => {
      const originalSignal = new Uint8Array([]);
      const arraySignal = Array.from(originalSignal);
      const restoredSignal = new Uint8Array(arraySignal);

      expect(restoredSignal).toEqual(originalSignal);
      expect(restoredSignal.length).toBe(0);
    });

    it("should handle large signal bytes", () => {
      // Signals can be substantial in size
      const originalSignal = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) {
        originalSignal[i] = i % 256;
      }
      const arraySignal = Array.from(originalSignal);
      const restoredSignal = new Uint8Array(arraySignal);

      expect(restoredSignal).toEqual(originalSignal);
    });
  });
});

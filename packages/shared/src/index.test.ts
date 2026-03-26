import { describe, it, expect } from "vitest";
import { ok, err, type ConnectionStatus } from "./index";

describe("shared utilities", () => {
  describe("Result type helpers", () => {
    it("ok() creates a success result", () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it("err() creates a failure result", () => {
      const error = new Error("test error");
      const result = err(error);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });
  });

  describe("ConnectionStatus shape", () => {
    // This test documents the expected fields of ConnectionStatus.
    // If a field is added to the shared type, this test must be updated —
    // and the manual mirror in packages/extension/src/inject/index.ts
    // must be updated to match (inject cannot import shared modules).
    it("has expected fields (sync with inject/index.ts mirror)", () => {
      const status: ConnectionStatus = {
        httpHealthy: true,
        wsHealthy: true,
        authenticated: true,
        linkerUrl: "http://localhost:8090",
        lastChecked: Date.now(),
        lastError: undefined,
        peerCount: 5,
      };

      const expectedKeys = [
        "httpHealthy",
        "wsHealthy",
        "authenticated",
        "linkerUrl",
        "lastChecked",
        "lastError",
        "peerCount",
      ];

      expect(Object.keys(status).sort()).toEqual(expectedKeys.sort());
    });
  });
});

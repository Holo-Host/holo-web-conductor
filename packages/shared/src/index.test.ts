import { describe, it, expect } from "vitest";
import { ok, err } from "./index";

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
});

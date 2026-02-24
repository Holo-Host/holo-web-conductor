import { describe, it, expect } from "vitest";
import {
  serializeAgentInfoCanonical,
  validateAgentInfo,
  AgentInfoFields,
} from "./agent-info-validator";

// base64url-no-pad encode
function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Create a valid HoloHash AgentPubKey base64 string from 32-byte core
// Format: "u" + base64url(3-byte prefix + 32-byte core + 4-byte location)
function makeAgentPubKeyB64(core32: Uint8Array): string {
  const full = new Uint8Array(39);
  // AgentPubKey prefix: 0x84 0x20 0x24
  full[0] = 0x84;
  full[1] = 0x20;
  full[2] = 0x24;
  full.set(core32, 3);
  // Location bytes: XOR-based location computation
  full[35] = 0;
  full[36] = 0;
  full[37] = 0;
  full[38] = 0;
  for (let i = 0; i < 32; i++) {
    full[35 + (i % 4)] ^= core32[i];
  }
  let binary = "";
  for (let i = 0; i < full.length; i++) {
    binary += String.fromCharCode(full[i]);
  }
  return (
    "u" +
    btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  );
}

describe("serializeAgentInfoCanonical", () => {
  it("matches kitsune2 test vector exactly", () => {
    // This test vector comes from kitsune2/crates/api/src/agent.rs happy_encode_decode test
    const info: AgentInfoFields = {
      agent: "dGVzdC1hZ2VudA",
      space: "dGVzdC1zcGFjZQ",
      createdAt: "1731690797907204",
      expiresAt: "1731762797907204",
      isTombstone: false,
      url: "ws://test.com:80/test-url",
      storageArc: [42, 330382099],
    };

    const result = serializeAgentInfoCanonical(info);
    const expected =
      '{"agent":"dGVzdC1hZ2VudA","space":"dGVzdC1zcGFjZQ","createdAt":"1731690797907204","expiresAt":"1731762797907204","isTombstone":false,"url":"ws://test.com:80/test-url","storageArc":[42,330382099]}';

    expect(result).toBe(expected);
  });

  it("handles null url", () => {
    const info: AgentInfoFields = {
      agent: "dGVzdA",
      space: "dGVzdA",
      createdAt: "1000000",
      expiresAt: "2000000",
      isTombstone: true,
      url: null,
      storageArc: null,
    };

    const result = serializeAgentInfoCanonical(info);
    expect(result).toContain('"url":null');
    expect(result).not.toContain('"url":"null"');
  });

  it("handles null/Empty storage arc", () => {
    const info: AgentInfoFields = {
      agent: "dGVzdA",
      space: "dGVzdA",
      createdAt: "1000000",
      expiresAt: "2000000",
      isTombstone: false,
      url: "https://example.com",
      storageArc: null,
    };

    const result = serializeAgentInfoCanonical(info);
    expect(result).toContain('"storageArc":null');
  });

  it("handles url with special characters requiring JSON escaping", () => {
    const info: AgentInfoFields = {
      agent: "dGVzdA",
      space: "dGVzdA",
      createdAt: "1000000",
      expiresAt: "2000000",
      isTombstone: false,
      url: 'https://example.com/path?q=1&b="test"',
      storageArc: null,
    };

    const result = serializeAgentInfoCanonical(info);
    // JSON.stringify properly escapes quotes
    expect(result).toContain('\\"test\\"');
  });
});

describe("validateAgentInfo", () => {
  const testCore32 = new Uint8Array(32).fill(0xab);
  const testAgentB64 = b64urlEncode(testCore32);
  const testPubKeyB64 = makeAgentPubKeyB64(testCore32);
  const nowMicros = BigInt(Date.now()) * 1000n;

  function makeValidInfo(
    overrides?: Partial<AgentInfoFields>,
  ): AgentInfoFields {
    return {
      agent: testAgentB64,
      space: b64urlEncode(new Uint8Array(32).fill(0x01)),
      createdAt: nowMicros.toString(),
      expiresAt: (nowMicros + 1200000000n).toString(), // 20 min later
      isTombstone: false,
      url: "https://relay.example.com:443/abc123",
      storageArc: null,
      ...overrides,
    };
  }

  it("accepts valid agent info", () => {
    const result = validateAgentInfo(makeValidInfo(), testPubKeyB64);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects agent field mismatch", () => {
    const wrongAgent = b64urlEncode(new Uint8Array(32).fill(0xff));
    const result = validateAgentInfo(
      makeValidInfo({ agent: wrongAgent }),
      testPubKeyB64,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("agent field does not match");
  });

  it("rejects non-empty storage arc", () => {
    const result = validateAgentInfo(
      makeValidInfo({ storageArc: [0, 4294967295] }),
      testPubKeyB64,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("storageArc");
  });

  it("rejects createdAt too far in the future", () => {
    const farFuture = (nowMicros + 600000000n).toString(); // 10 min ahead
    const result = validateAgentInfo(
      makeValidInfo({
        createdAt: farFuture,
        expiresAt: (BigInt(farFuture) + 1200000000n).toString(),
      }),
      testPubKeyB64,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("createdAt");
  });

  it("rejects createdAt too far in the past", () => {
    const farPast = (nowMicros - 600000000n).toString(); // 10 min ago
    const result = validateAgentInfo(
      makeValidInfo({
        createdAt: farPast,
        expiresAt: (nowMicros + 1200000000n).toString(),
      }),
      testPubKeyB64,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("createdAt");
  });

  it("rejects expiresAt before createdAt", () => {
    const result = validateAgentInfo(
      makeValidInfo({ expiresAt: (nowMicros - 1000000n).toString() }),
      testPubKeyB64,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expiresAt");
  });

  it("rejects tombstone with url", () => {
    const result = validateAgentInfo(
      makeValidInfo({ isTombstone: true, url: "https://example.com" }),
      testPubKeyB64,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("tombstone");
  });

  it("accepts tombstone with null url", () => {
    const result = validateAgentInfo(
      makeValidInfo({ isTombstone: true, url: null }),
      testPubKeyB64,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects unregistered space when registrations provided", () => {
    const registeredSpaces = new Set(["b3RoZXItc3BhY2U"]);
    const result = validateAgentInfo(
      makeValidInfo(),
      testPubKeyB64,
      registeredSpaces,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not registered");
  });

  it("accepts registered space", () => {
    const spaceB64 = b64urlEncode(new Uint8Array(32).fill(0x01));
    const registeredSpaces = new Set([spaceB64]);
    const result = validateAgentInfo(
      makeValidInfo(),
      testPubKeyB64,
      registeredSpaces,
    );
    expect(result.valid).toBe(true);
  });

  it("skips space check when no registrations provided", () => {
    const result = validateAgentInfo(makeValidInfo(), testPubKeyB64);
    expect(result.valid).toBe(true);
  });
});

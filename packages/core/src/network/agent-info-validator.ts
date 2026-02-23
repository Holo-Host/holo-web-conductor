/**
 * Agent info validation and canonical serialization for transparent signing protocol.
 *
 * The extension receives structured AgentInfo fields from the linker,
 * validates them, then constructs the canonical JSON to sign.
 * This ensures the extension never signs opaque data.
 */

/**
 * Decode a HoloHash base64 string (e.g., "uhCAk...") to Uint8Array.
 * HoloHash strings have a 'u' prefix followed by base64url-no-pad content.
 * Implemented locally to avoid importing @holochain/client which has
 * global side effects that require crypto polyfills in test environments.
 */
function decodeHoloHashBase64(s: string): Uint8Array {
  // Strip 'u' prefix
  const b64 = s.startsWith("u") ? s.slice(1) : s;
  return base64UrlNoPadDecode(b64);
}

/**
 * Structured agent info fields as sent by the linker.
 * Matches kitsune2's AgentInfo struct with camelCase field names.
 */
export interface AgentInfoFields {
  agent: string; // base64url-no-pad encoded 32-byte agent ID
  space: string; // base64url-no-pad encoded space ID
  createdAt: string; // microsecond timestamp as string
  expiresAt: string; // microsecond timestamp as string
  isTombstone: boolean;
  url: string | null; // transport URL or null
  storageArc: null | [number, number]; // DhtArc: null = Empty, [u32,u32] = Arc
}

/**
 * Result of agent info validation.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Decode a base64url-no-pad string to Uint8Array.
 */
function base64UrlNoPadDecode(s: string): Uint8Array {
  // Convert URL-safe base64 to standard base64
  let standard = s.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding
  const pad = (4 - (standard.length % 4)) % 4;
  standard += "=".repeat(pad);
  const binary = atob(standard);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Serialize AgentInfo fields to canonical JSON matching kitsune2's
 * serde_json::to_string(&AgentInfo) output exactly.
 *
 * Field order matches the Rust struct declaration order with camelCase names.
 * This must be byte-identical to what kitsune2 produces.
 *
 * We build the JSON string manually (not with JSON.stringify) to guarantee
 * field order and exact formatting matches serde_json output.
 */
export function serializeAgentInfoCanonical(info: AgentInfoFields): string {
  const parts: string[] = [];
  parts.push(`"agent":${JSON.stringify(info.agent)}`);
  parts.push(`"space":${JSON.stringify(info.space)}`);
  parts.push(`"createdAt":${JSON.stringify(info.createdAt)}`);
  parts.push(`"expiresAt":${JSON.stringify(info.expiresAt)}`);
  parts.push(`"isTombstone":${info.isTombstone}`);

  if (info.url === null) {
    parts.push(`"url":null`);
  } else {
    parts.push(`"url":${JSON.stringify(info.url)}`);
  }

  if (info.storageArc === null) {
    parts.push(`"storageArc":null`);
  } else {
    parts.push(`"storageArc":[${info.storageArc[0]},${info.storageArc[1]}]`);
  }

  return `{${parts.join(",")}}`;
}

/**
 * Validate agent info fields before signing.
 *
 * Checks:
 * 1. agent field matches the agent_pubkey (32-byte core)
 * 2. storageArc is "Empty" (browser agents are zero-arc)
 * 3. Timestamps are reasonable (createdAt within 5 min of now, expiresAt > createdAt)
 * 4. Tombstone consistency (tombstone should have null url)
 * 5. Space is registered (if registration info available)
 *
 * @param agentInfo - Structured agent info from the linker
 * @param agentPubkeyB64 - The agent pubkey from the sign request (HoloHash base64, e.g. "uhCAk...")
 * @param registeredSpaces - Optional set of base64url-no-pad encoded space IDs this agent is registered for
 */
export function validateAgentInfo(
  agentInfo: AgentInfoFields,
  agentPubkeyB64: string,
  registeredSpaces?: Set<string>,
): ValidationResult {
  // 1. Validate agent matches agent_pubkey
  try {
    const agentPubkeyBytes = decodeHoloHashBase64(agentPubkeyB64);
    // Extract 32-byte core from 39-byte HoloHash (skip 3-byte prefix, drop 4-byte location)
    const agentCore32 = agentPubkeyBytes.slice(3, 35);
    const agentInfoAgentBytes = base64UrlNoPadDecode(agentInfo.agent);

    if (agentInfoAgentBytes.length !== agentCore32.length) {
      return {
        valid: false,
        error: `agent field length mismatch: ${agentInfoAgentBytes.length} vs ${agentCore32.length}`,
      };
    }
    for (let i = 0; i < agentCore32.length; i++) {
      if (agentInfoAgentBytes[i] !== agentCore32[i]) {
        return {
          valid: false,
          error: "agent field does not match agent_pubkey",
        };
      }
    }
  } catch (e) {
    return {
      valid: false,
      error: `failed to decode agent_pubkey: ${e}`,
    };
  }

  // 2. Validate storage arc is null/Empty (browser agents are zero-arc)
  if (agentInfo.storageArc !== null) {
    return {
      valid: false,
      error: `unexpected storageArc: ${JSON.stringify(agentInfo.storageArc)} (browser agents must be zero-arc)`,
    };
  }

  // 3. Validate timestamps
  const nowMicros = BigInt(Date.now()) * 1000n;
  const createdAt = BigInt(agentInfo.createdAt);
  const expiresAt = BigInt(agentInfo.expiresAt);
  const FIVE_MINUTES_MICROS = 5n * 60n * 1000000n;

  const timeDiff =
    createdAt > nowMicros ? createdAt - nowMicros : nowMicros - createdAt;
  if (timeDiff > FIVE_MINUTES_MICROS) {
    return {
      valid: false,
      error: `createdAt ${agentInfo.createdAt} is too far from current time`,
    };
  }

  if (expiresAt <= createdAt) {
    return {
      valid: false,
      error: "expiresAt must be after createdAt",
    };
  }

  // 4. Validate tombstone consistency
  if (agentInfo.isTombstone && agentInfo.url !== null) {
    return {
      valid: false,
      error: "tombstone agent info should not have a url",
    };
  }

  // 5. Validate space is registered (if registration info available)
  if (registeredSpaces && registeredSpaces.size > 0) {
    if (!registeredSpaces.has(agentInfo.space)) {
      return {
        valid: false,
        error: `space ${agentInfo.space} is not registered for this agent`,
      };
    }
  }

  return { valid: true };
}

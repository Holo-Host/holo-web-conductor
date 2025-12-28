/**
 * create_link host function
 *
 * Creates a link between two entries.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Create link input structure
 */
interface CreateLinkInput {
  /** Base address (entry or action hash) */
  base: Uint8Array;

  /** Target address (entry or action hash) */
  target: Uint8Array;

  /** Link type */
  link_type: number | { App: { id: number; zome_id: number } };

  /** Optional link tag (arbitrary bytes) */
  tag?: Uint8Array;
}

/**
 * create_link host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Returns a random action hash for the create link action.
 * Step 6 will add real link storage.
 */
export const createLink: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  // Deserialize input
  const input = deserializeFromWasm(
    instance,
    inputPtr,
    inputLen
  ) as CreateLinkInput;

  const manifest = callContext.dnaManifest;

  // Log link creation with manifest info
  console.log("[create_link] Creating link", {
    zome: callContext.zome,
    hasManifest: !!manifest,
    linkType: input.link_type,
  });

  // TODO: Validate link_type against manifest in Step 6
  // For now, just log a warning if manifest is missing
  if (!manifest) {
    console.warn(
      "[create_link] No DNA manifest available - link type validation skipped"
    );
  }

  // Generate mock action hash (39 bytes: 3 prefix + 32 hash + 4 location)
  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84; // Action hash prefix
  actionHash[1] = 0x29; // ActionHash-specific byte (not 0x20 which is AgentPubKey)
  actionHash[2] = 0x24;

  console.warn(
    "[create_link] Using MOCK action hash - Step 6 will add real persistence"
  );

  return serializeResult(instance, actionHash);
};

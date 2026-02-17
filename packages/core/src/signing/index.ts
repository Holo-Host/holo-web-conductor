/**
 * Signing Module
 *
 * Provides cryptographic signing for Holochain actions and data.
 * Uses Lair client for key management and signing.
 */

export {
  getLairClient,
  setLairClient,
  hasLairClient,
  clearLairClient,
  signAction,
} from "./signing-provider";

// Re-export types
export type { Signature } from "@holochain/client";
export type { LairClient } from "@hwc/lair";

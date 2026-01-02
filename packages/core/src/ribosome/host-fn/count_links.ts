/**
 * count_links host function
 *
 * Counts links from a base address using storage.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";

/**
 * Count links input structure
 */
interface CountLinksInput {
  /** Base address to count links from */
  base: Uint8Array;

  /** Link type filter */
  link_type?: number | { App: { id: number; zome_id: number } };

  /** Tag filter prefix */
  tag_prefix?: Uint8Array;
}

/**
 * count_links host function implementation
 *
 * Counts links from storage (uses session cache for synchronous reads).
 */
export const countLinks: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as CountLinksInput;

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Parse link type filter
  const linkTypeFilter = input.link_type !== undefined
    ? (typeof input.link_type === 'number' ? input.link_type : input.link_type.App?.id)
    : undefined;

  // Get links from storage (always synchronous with StorageProvider)
  let storedLinks = storage.getLinks(input.base, dnaHash, agentPubKey, linkTypeFilter);

  // Filter by tag prefix if specified
  if (input.tag_prefix && input.tag_prefix.length > 0) {
    storedLinks = storedLinks.filter(link => {
      if (link.tag.length < input.tag_prefix!.length) return false;
      for (let i = 0; i < input.tag_prefix!.length; i++) {
        if (link.tag[i] !== input.tag_prefix![i]) return false;
      }
      return true;
    });
  }

  // Filter out deleted links
  storedLinks = storedLinks.filter(link => !link.deleted);

  const count = storedLinks.length;

  console.log('[count_links] Counted links:', count);

  return serializeResult(instance, count);
};

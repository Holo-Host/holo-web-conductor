/**
 * count_links host function
 *
 * Counts links from a base address using storage.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";

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
  const storage = SourceChainStorage.getInstance();

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as CountLinksInput;

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Parse link type filter
  const linkTypeFilter = input.link_type !== undefined
    ? (typeof input.link_type === 'number' ? input.link_type : input.link_type.App?.id)
    : undefined;

  // Get links from storage (synchronous if in cache)
  const linksResult = storage.getLinks(input.base, dnaHash, agentPubKey, linkTypeFilter);

  // If it's a Promise, we can't handle it synchronously yet (Step 7+)
  // For now, return 0 if not in cache
  if (linksResult instanceof Promise) {
    console.warn('[count_links] Links not in session cache - returning 0 (Step 7+ will support async reads)');
    return serializeResult(instance, 0);
  }

  let storedLinks = linksResult;

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

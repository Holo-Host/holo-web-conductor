/**
 * Synchronous XHR Network Service
 *
 * Network service implementation using synchronous XMLHttpRequest.
 * This ONLY works in DOM contexts (like Chrome offscreen documents),
 * NOT in service workers or Node.js.
 *
 * Uses sync XHR to make blocking network calls that WASM host functions need.
 */

import type {
  NetworkService,
  NetworkRecord,
  NetworkLink,
  NetworkEntry,
  NetworkFetchOptions,
} from './types';
import type { DnaHash, AnyDhtHash, SignedActionHashed } from '../types/holochain-types';
import { encodeHashToBase64 } from '../types/holochain-types';
import { createLogger } from '@fishy/shared';

const log = createLogger('SyncXHR');

/**
 * Default timeout for network requests (30 seconds)
 * Note: sync XHR timeout may not work reliably in all Worker contexts.
 * The timeout is set as a best-effort guard against indefinite blocking.
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Configuration for SyncXHRNetworkService
 */
export interface SyncXHRConfig {
  /** Gateway base URL */
  gatewayUrl: string;
  /** Default timeout in ms */
  timeout?: number;
  /** Session token for authenticated requests */
  sessionToken?: string;
}

/**
 * Synchronous XHR network service for offscreen document context
 *
 * Note: This service is designed for use with hc-membrane or similar gateway.
 *
 * Gateway endpoints:
 * - GET /dht/{dna_hash}/record/{hash} - Fetch a record by hash
 * - GET /dht/{dna_hash}/details/{hash} - Fetch details for a hash
 * - GET /dht/{dna_hash}/links?base={base}&type={type} - Fetch links
 * - GET /dht/{dna_hash}/links/count?base={base}&type={type} - Count links
 */
export class SyncXHRNetworkService implements NetworkService {
  private gatewayUrl: string;
  private defaultTimeout: number;
  private sessionToken: string | null;

  constructor(config: SyncXHRConfig | string, defaultTimeout: number = DEFAULT_TIMEOUT) {
    if (typeof config === 'string') {
      // Legacy constructor: just gatewayUrl
      this.gatewayUrl = config.replace(/\/$/, '');
      this.defaultTimeout = defaultTimeout;
      this.sessionToken = null;
    } else {
      this.gatewayUrl = config.gatewayUrl.replace(/\/$/, '');
      this.defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT;
      this.sessionToken = config.sessionToken ?? null;
    }
  }

  /**
   * Get the DNA hash as base64 for URL building
   * Note: Gateway expects Holochain base64 format "u{base64}" (with 'u' prefix)
   */
  private getDnaHashB64(dnaHash: DnaHash): string {
    // Use @holochain/client utility which adds 'u' prefix
    return encodeHashToBase64(dnaHash);
  }

  /**
   * Set the session token for authenticated requests
   */
  setSessionToken(token: string | null): void {
    this.sessionToken = token;
  }

  /**
   * Get the current session token
   */
  getSessionToken(): string | null {
    return this.sessionToken;
  }

  /**
   * Convert hash to Holochain base64 format with 'u' prefix
   * Uses @holochain/client utility for consistent encoding
   */
  private toHolochainBase64(bytes: Uint8Array): string {
    return encodeHashToBase64(bytes);
  }

  /**
   * Build URL for fetching a record
   */
  private buildRecordUrl(dnaHash: DnaHash, hash: AnyDhtHash): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const hashB64 = this.toHolochainBase64(hash);
    return `${this.gatewayUrl}/dht/${dnaHashB64}/record/${hashB64}`;
  }

  /**
   * Build URL for fetching details
   */
  private buildDetailsUrl(dnaHash: DnaHash, hash: AnyDhtHash): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const hashB64 = this.toHolochainBase64(hash);
    return `${this.gatewayUrl}/dht/${dnaHashB64}/details/${hashB64}`;
  }

  /**
   * Build URL for fetching links
   */
  private buildLinksUrl(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    zomeIndex?: number
  ): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const baseB64 = this.toHolochainBase64(baseAddress);
    const params = new URLSearchParams();
    params.set('base', baseB64);
    if (linkType !== undefined) {
      params.set('type', linkType.toString());
    }
    if (zomeIndex !== undefined) {
      params.set('zome_index', zomeIndex.toString());
    }
    return `${this.gatewayUrl}/dht/${dnaHashB64}/links?${params.toString()}`;
  }

  /**
   * Build URL for counting links
   */
  private buildCountLinksUrl(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    zomeIndex?: number
  ): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const baseB64 = this.toHolochainBase64(baseAddress);
    const params = new URLSearchParams();
    params.set('base', baseB64);
    if (linkType !== undefined) {
      params.set('type', linkType.toString());
    }
    if (zomeIndex !== undefined) {
      params.set('zome_index', zomeIndex.toString());
    }
    return `${this.gatewayUrl}/dht/${dnaHashB64}/count_links?${params.toString()}`;
  }

  /**
   * Add auth headers to XHR request
   */
  private addAuthHeaders(xhr: XMLHttpRequest): void {
    if (this.sessionToken) {
      xhr.setRequestHeader('X-Session-Token', this.sessionToken);
    }
  }

  /**
   * Parse record response from gateway
   */
  private parseRecordResponse(responseText: string): NetworkRecord | null {
    try {
      const data = JSON.parse(responseText) as Record<string, unknown>;
      if (!data || !data.signed_action) {
        return null;
      }

      const signedAction = this.parseSignedAction(data.signed_action);
      if (!signedAction) {
        return null;
      }

      return {
        signed_action: signedAction,
        entry: this.parseEntry(data.entry),
      };
    } catch (error) {
      console.error('[SyncXHR] Failed to parse record response:', error);
      return null;
    }
  }

  /**
   * Parse signed action from gateway response
   *
   * Gateway returns signed_action with:
   * - hashed.content: the action content
   * - hashed.hash: the action hash (as JSON array)
   * - signature: 64-byte signature (as JSON array)
   *
   * We need to convert arrays to Uint8Array for proper msgpack encoding later.
   */
  private parseSignedAction(data: unknown): SignedActionHashed | null {
    if (!data) return null;

    // Deep normalize: convert all byte arrays from JSON array format to Uint8Array
    return this.normalizeByteArrays(data) as SignedActionHashed;
  }

  /**
   * Recursively normalize byte arrays from JSON format to Uint8Array
   */
  private normalizeByteArrays(data: any): any {
    if (data === null || data === undefined) return data;
    if (data instanceof Uint8Array) return data;

    // Check if this looks like a byte array (array of numbers 0-255)
    if (Array.isArray(data)) {
      // Check if it's a flat array of numbers (likely bytes)
      if (data.length > 0 && data.every(v => typeof v === 'number' && v >= 0 && v <= 255)) {
        return new Uint8Array(data);
      }
      // Otherwise recurse into array elements
      return data.map(item => this.normalizeByteArrays(item));
    }

    // Recurse into objects
    if (typeof data === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.normalizeByteArrays(value);
      }
      return result;
    }

    return data;
  }

  /**
   * Parse entry from gateway response
   *
   * Gateway returns RecordEntry which is one of:
   * - null → 'NotApplicable'
   * - 'Hidden' | 'NotStored' | 'NotApplicable'
   * - { Present: Entry } where Entry is { entry_type: "App"|"Agent"|etc, entry: bytes }
   *
   * Entry bytes come as JSON arrays and need to be converted to Uint8Array.
   */
  private parseEntry(data: unknown): NetworkEntry {
    if (!data) {
      return 'NotApplicable';
    }
    if (data === 'Hidden' || data === 'NotStored' || data === 'NotApplicable') {
      return data;
    }
    // Gateway already returns { Present: Entry } format - don't double-wrap
    const record = data as Record<string, unknown>;
    if (record.Present !== undefined) {
      // Normalize byte arrays in the entry
      return { Present: this.normalizeByteArrays(record.Present) };
    }
    // If somehow we get just an Entry, wrap it and normalize
    return { Present: this.normalizeByteArrays(data) };
  }

  /**
   * Parse links response from gateway
   *
   * Gateway may return one of two formats:
   * 1. Vec<Link> - array of Link objects (conductor-dht mode)
   * 2. WireLinkOps - {creates: [...], deletes: [...]} (direct kitsune2 mode)
   *
   * Gateway returns hashes as byte arrays (e.g., [132, 41, 36, ...]) not base64 strings.
   * We use normalizeByteArrays to convert these to Uint8Array.
   *
   * @param responseText - JSON response from gateway
   * @param baseAddress - The base address from the query (needed for WireLinkOps format)
   */
  private parseLinksResponse(responseText: string, baseAddress?: AnyDhtHash): NetworkLink[] {
    try {
      const data = JSON.parse(responseText);

      // Check if this is WireLinkOps format (direct kitsune2 mode)
      if (data && typeof data === 'object' && 'creates' in data && Array.isArray(data.creates)) {
        log.info(`🔗 Parsing WireLinkOps format with ${data.creates.length} creates, ${data.deletes?.length || 0} deletes`);
        return this.parseWireLinkOps(data, baseAddress);
      }

      // Otherwise expect Vec<Link> format (conductor mode)
      if (!Array.isArray(data)) {
        log.warn(`🔗 Unexpected response format - not array or WireLinkOps:`, typeof data);
        return [];
      }

      log.debug(` Parsing ${data.length} links from gateway (Link array format)`);

      return data.map((link: any, idx: number): NetworkLink => {
        const target = this.normalizeByteArrays(link.target);
        const author = this.normalizeByteArrays(link.author);

        // Debug: log raw and normalized target for AgentPubKey investigation
        const rawTargetPrefix = Array.isArray(link.target) ? link.target.slice(0, 3) : 'not array';
        const normalizedTargetPrefix = target instanceof Uint8Array ? Array.from(target.slice(0, 3)) : 'not Uint8Array';

        log.debug(` Link ${idx} from gateway:`, {
          raw_target_prefix: rawTargetPrefix,
          raw_target_length: Array.isArray(link.target) ? link.target.length : 'N/A',
          normalized_target_prefix: normalizedTargetPrefix,
          normalized_target_length: target instanceof Uint8Array ? target.length : 'N/A',
          raw_author_prefix: Array.isArray(link.author) ? link.author.slice(0, 3) : 'not array',
        });

        return {
          create_link_hash: this.normalizeByteArrays(link.create_link_hash),
          base: this.normalizeByteArrays(link.base),
          target,
          zome_index: link.zome_index,
          link_type: link.link_type,
          tag: link.tag ? this.normalizeByteArrays(link.tag) : new Uint8Array(0),
          timestamp: link.timestamp,
          author,
        };
      });
    } catch (error) {
      console.error('[ProxyNetwork] Failed to parse links response:', error);
      return [];
    }
  }

  /**
   * Parse WireLinkOps format from direct kitsune2 response
   *
   * WireCreateLink has:
   * - author, timestamp, action_seq, prev_action, target_address,
   *   zome_index, link_type, tag, signature, validation_status, weight
   *
   * We need to construct NetworkLink which requires:
   * - create_link_hash (computed from prev_action + action_seq)
   * - base (from query parameter)
   * - target, zome_index, link_type, tag, timestamp, author
   */
  private parseWireLinkOps(wireOps: { creates: any[]; deletes?: any[] }, baseAddress?: AnyDhtHash): NetworkLink[] {
    if (!wireOps.creates || wireOps.creates.length === 0) {
      return [];
    }

    // Filter out deleted links if we have delete information
    const deletedLinkHashes = new Set<string>();
    if (wireOps.deletes) {
      for (const del of wireOps.deletes) {
        // WireDeleteLink has link_add_address which is the hash of the create link action
        if (del.link_add_address) {
          const hash = this.normalizeByteArrays(del.link_add_address);
          if (hash instanceof Uint8Array) {
            deletedLinkHashes.add(this.hashToKey(hash));
          }
        }
      }
    }

    return wireOps.creates.map((create: any, idx: number): NetworkLink => {
      const author = this.normalizeByteArrays(create.author);
      // WireCreateLink uses target_address, not target
      const target = this.normalizeByteArrays(create.target_address);
      const tag = create.tag ? this.normalizeByteArrays(create.tag) : new Uint8Array(0);

      // Compute a create_link_hash from prev_action and action_seq
      // This creates a unique identifier for the link action
      const prevAction = this.normalizeByteArrays(create.prev_action);
      const createLinkHash = this.computeCreateLinkHash(prevAction, create.action_seq);

      // Use provided baseAddress or create empty placeholder
      const base = baseAddress || new Uint8Array(39);

      log.debug(`🔗 WireLinkOps create ${idx}:`, {
        target_prefix: target instanceof Uint8Array ? Array.from(target.slice(0, 3)) : 'N/A',
        author_prefix: author instanceof Uint8Array ? Array.from(author.slice(0, 3)) : 'N/A',
        zome_index: create.zome_index,
        link_type: create.link_type,
        action_seq: create.action_seq,
      });

      return {
        create_link_hash: createLinkHash,
        base,
        target,
        zome_index: typeof create.zome_index === 'number' ? create.zome_index : create.zome_index?.value || 0,
        link_type: typeof create.link_type === 'number' ? create.link_type : create.link_type?.value || 0,
        tag,
        timestamp: create.timestamp,
        author,
      };
    });
  }

  /**
   * Compute a unique hash for a create link action based on prev_action and action_seq
   * This is used as a surrogate for the real ActionHash when we don't have it
   */
  private computeCreateLinkHash(prevAction: Uint8Array, actionSeq: number): Uint8Array {
    // Create a 39-byte hash with ActionHash prefix (132, 41, 36)
    // Use prev_action (32 bytes) XOR'd with action_seq for uniqueness
    const hash = new Uint8Array(39);
    // ActionHash prefix
    hash[0] = 132;
    hash[1] = 41;
    hash[2] = 36;

    // Copy core bytes from prev_action (skip its 3-byte prefix if present)
    const coreStart = prevAction.length === 39 ? 3 : 0;
    const coreBytes = prevAction.slice(coreStart, coreStart + 32);
    hash.set(coreBytes, 3);

    // XOR action_seq into first 4 bytes of core to make it unique
    hash[3] ^= (actionSeq >> 24) & 0xff;
    hash[4] ^= (actionSeq >> 16) & 0xff;
    hash[5] ^= (actionSeq >> 8) & 0xff;
    hash[6] ^= actionSeq & 0xff;

    // DHT location (last 4 bytes) - just copy from prev_action or compute
    if (prevAction.length >= 39) {
      hash.set(prevAction.slice(35, 39), 35);
    }

    return hash;
  }

  /**
   * Convert a hash to a string key for deduplication
   */
  private hashToKey(hash: Uint8Array): string {
    return Array.from(hash).join(',');
  }

  // NetworkService implementation

  getRecordSync(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: NetworkFetchOptions
  ): NetworkRecord | null {
    const url = this.buildRecordUrl(dnaHash, hash);
    const timeout = options?.timeout ?? this.defaultTimeout;

    log.debug(` Fetching record: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // false = synchronous
      // In a Worker context (not Window), xhr.timeout works for sync XHR.
      // Without this, a slow gateway DHT query blocks the entire worker thread
      // and serialized zome call chain indefinitely.
      try { xhr.timeout = timeout; } catch (_) { /* sync XHR timeout not supported in this context */ }
      xhr.setRequestHeader('Accept', 'application/json');
      this.addAuthHeaders(xhr);
      xhr.send();

      if (xhr.status === 200) {
        const record = this.parseRecordResponse(xhr.responseText);
        log.debug(` Record fetched successfully`);
        return record;
      } else if (xhr.status === 404) {
        log.debug(` Record not found (404)`);
        return null;
      } else {
        console.error(`[SyncXHR] Network error: ${xhr.status} ${xhr.statusText}`);
        throw new Error(`Network error: ${xhr.status} ${xhr.statusText}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Network error:')) {
        throw error;
      }
      console.error(`[SyncXHR] Request failed:`, error);
      throw new Error(`Network request failed: ${error}`);
    }
  }

  getLinksSync(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    zomeIndex?: number,
    options?: NetworkFetchOptions
  ): NetworkLink[] {
    const url = this.buildLinksUrl(dnaHash, baseAddress, linkType, zomeIndex);
    const timeout = options?.timeout ?? this.defaultTimeout;

    log.info(`🔗 Fetching links from gateway: ${url}`);
    log.info(`🔗 Base address: ${this.toHolochainBase64(baseAddress)}, linkType: ${linkType}, zomeIndex: ${zomeIndex}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // false = synchronous
      try { xhr.timeout = timeout; } catch (_) { /* sync XHR timeout not supported in this context */ }
      xhr.setRequestHeader('Accept', 'application/json');
      this.addAuthHeaders(xhr);
      xhr.send();

      if (xhr.status === 200) {
        log.info(`🔗 Gateway returned status 200, response length: ${xhr.responseText.length}`);
        const links = this.parseLinksResponse(xhr.responseText, baseAddress);
        log.info(`🔗 Parsed ${links.length} links from gateway response`);
        return links;
      } else if (xhr.status === 404) {
        log.info(`🔗 No links found (404)`);
        return [];
      } else {
        log.error(`🔗 Gateway error: ${xhr.status} ${xhr.statusText}`);
        throw new Error(`Network error: ${xhr.status} ${xhr.statusText}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Network error:')) {
        throw error;
      }
      console.error(`[SyncXHR] Request failed:`, error);
      throw new Error(`Network request failed: ${error}`);
    }
  }

  getDetailsSync(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: NetworkFetchOptions
  ): any | null {
    const url = this.buildDetailsUrl(dnaHash, hash);
    const timeout = options?.timeout ?? this.defaultTimeout;

    log.debug(` Fetching details: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // false = synchronous
      try { xhr.timeout = timeout; } catch (_) { /* sync XHR timeout not supported in this context */ }
      xhr.setRequestHeader('Accept', 'application/json');
      this.addAuthHeaders(xhr);
      xhr.send();

      if (xhr.status === 200) {
        const details = JSON.parse(xhr.responseText);
        log.debug(` Details fetched successfully`);
        return details;
      } else if (xhr.status === 404) {
        log.debug(` Details not found (404)`);
        return null;
      } else {
        console.error(`[SyncXHR] Network error: ${xhr.status} ${xhr.statusText}`);
        throw new Error(`Network error: ${xhr.status} ${xhr.statusText}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Network error:')) {
        throw error;
      }
      console.error(`[SyncXHR] Request failed:`, error);
      throw new Error(`Network request failed: ${error}`);
    }
  }

  countLinksSync(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    zomeIndex?: number,
    options?: NetworkFetchOptions
  ): number {
    const url = this.buildCountLinksUrl(dnaHash, baseAddress, linkType, zomeIndex);
    const timeout = options?.timeout ?? this.defaultTimeout;

    log.debug(` Counting links: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // false = synchronous
      try { xhr.timeout = timeout; } catch (_) { /* sync XHR timeout not supported in this context */ }
      xhr.setRequestHeader('Accept', 'application/json');
      this.addAuthHeaders(xhr);
      xhr.send();

      if (xhr.status === 200) {
        const count = JSON.parse(xhr.responseText);
        log.debug(` Link count response:`, typeof count, Array.isArray(count) ? `array(${count.length})` : count);
        // CountLinksResponse is Vec<ActionHash> (array) in kitsune mode, or number in conductor mode
        if (Array.isArray(count)) {
          return count.length;
        }
        return typeof count === 'number' ? count : 0;
      } else if (xhr.status === 404) {
        log.debug(` No links found (404)`);
        return 0;
      } else {
        console.error(`[SyncXHR] Network error: ${xhr.status} ${xhr.statusText}`);
        throw new Error(`Network error: ${xhr.status} ${xhr.statusText}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Network error:')) {
        throw error;
      }
      console.error(`[SyncXHR] Request failed:`, error);
      throw new Error(`Network request failed: ${error}`);
    }
  }

  isAvailable(): boolean {
    // Check if we're in a DOM context where sync XHR works
    return typeof XMLHttpRequest !== 'undefined';
  }

  getGatewayUrl(): string | null {
    return this.gatewayUrl;
  }

  /**
   * Request an authentication challenge (nonce) from the gateway
   */
  requestChallenge(): { nonce: string; expires_at: number } {
    const url = `${this.gatewayUrl}/auth/challenge`;

    log.debug(` Requesting auth challenge: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, false); // false = synchronous
      // Note: xhr.timeout on sync XHR may cause hangs in some Worker contexts.
      // Disabled for now - rely on gateway's own timeouts.
      // try { xhr.timeout = this.defaultTimeout; } catch (_) {}
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send();

      if (xhr.status === 200) {
        const challenge = JSON.parse(xhr.responseText);
        log.debug(` Auth challenge received`);
        return challenge;
      } else {
        console.error(`[SyncXHR] Auth challenge failed: ${xhr.status} ${xhr.statusText}`);
        throw new Error(`Auth challenge failed: ${xhr.status} ${xhr.statusText}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Auth challenge failed:')) {
        throw error;
      }
      console.error(`[SyncXHR] Auth challenge request failed:`, error);
      throw new Error(`Auth challenge request failed: ${error}`);
    }
  }

  /**
   * Verify a signed challenge and get a session token
   *
   * @param agentPubKey - Agent public key (base64 encoded)
   * @param signature - Signature of the nonce (base64 encoded)
   * @param nonce - The nonce that was signed
   */
  verifyChallenge(
    agentPubKey: string,
    signature: string,
    nonce: string
  ): { token: string; expires_at: number } {
    const url = `${this.gatewayUrl}/auth/verify`;

    log.debug(` Verifying auth challenge: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, false); // false = synchronous
      // Note: xhr.timeout on sync XHR may cause hangs in some Worker contexts.
      // Disabled for now - rely on gateway's own timeouts.
      // try { xhr.timeout = this.defaultTimeout; } catch (_) {}
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({
        agent_pub_key: agentPubKey,
        signature: signature,
        nonce: nonce,
      }));

      if (xhr.status === 200) {
        const session = JSON.parse(xhr.responseText);
        log.debug(` Auth verified, session token received`);
        // Automatically set the session token
        this.sessionToken = session.token;
        return session;
      } else if (xhr.status === 401 || xhr.status === 403) {
        console.error(`[SyncXHR] Auth verification failed: unauthorized`);
        throw new Error(`Auth verification failed: unauthorized`);
      } else {
        console.error(`[SyncXHR] Auth verification failed: ${xhr.status} ${xhr.statusText}`);
        throw new Error(`Auth verification failed: ${xhr.status} ${xhr.statusText}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Auth verification failed:')) {
        throw error;
      }
      console.error(`[SyncXHR] Auth verification request failed:`, error);
      throw new Error(`Auth verification request failed: ${error}`);
    }
  }

  /**
   * Check if the service has a valid session token
   */
  hasSession(): boolean {
    return this.sessionToken !== null;
  }

  /**
   * Clear the current session
   */
  clearSession(): void {
    this.sessionToken = null;
  }
}

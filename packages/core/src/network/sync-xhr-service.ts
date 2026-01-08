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
import { encodeHashToBase64, decodeHashFromBase64 } from '../types/holochain-types';

/**
 * Default timeout for network requests (30 seconds)
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
 * Note: This service is designed for use with hc-http-gw or similar gateway.
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
    linkType?: number
  ): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const baseB64 = this.toHolochainBase64(baseAddress);
    const params = new URLSearchParams();
    params.set('base', baseB64);
    if (linkType !== undefined) {
      params.set('type', linkType.toString());
    }
    return `${this.gatewayUrl}/dht/${dnaHashB64}/links?${params.toString()}`;
  }

  /**
   * Build URL for counting links
   */
  private buildCountLinksUrl(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number
  ): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const baseB64 = this.toHolochainBase64(baseAddress);
    const params = new URLSearchParams();
    params.set('base', baseB64);
    if (linkType !== undefined) {
      params.set('type', linkType.toString());
    }
    return `${this.gatewayUrl}/dht/${dnaHashB64}/links/count?${params.toString()}`;
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
   * Uses @holochain/client's decodeHashFromBase64 for proper hash decoding
   */
  private parseLinksResponse(responseText: string): NetworkLink[] {
    try {
      const data = JSON.parse(responseText);
      if (!Array.isArray(data)) {
        return [];
      }

      return data.map((link: any): NetworkLink => ({
        create_link_hash: decodeHashFromBase64(link.create_link_hash),
        base: decodeHashFromBase64(link.base),
        target: decodeHashFromBase64(link.target),
        zome_index: link.zome_index,
        link_type: link.link_type,
        tag: link.tag ? this.base64ToUint8Array(link.tag) : new Uint8Array(0),
        timestamp: link.timestamp,
        author: decodeHashFromBase64(link.author),
      }));
    } catch (error) {
      console.error('[SyncXHR] Failed to parse links response:', error);
      return [];
    }
  }

  /**
   * Convert base64 string to Uint8Array
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    // Handle URL-safe base64
    const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // NetworkService implementation

  getRecordSync(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: NetworkFetchOptions
  ): NetworkRecord | null {
    const url = this.buildRecordUrl(dnaHash, hash);
    const timeout = options?.timeout ?? this.defaultTimeout;

    console.log(`[SyncXHR] Fetching record: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // false = synchronous
      // Note: timeout cannot be set for synchronous requests from a document
      // The request will block until complete or browser timeout
      xhr.setRequestHeader('Accept', 'application/json');
      this.addAuthHeaders(xhr);
      xhr.send();

      if (xhr.status === 200) {
        const record = this.parseRecordResponse(xhr.responseText);
        console.log(`[SyncXHR] Record fetched successfully`);
        return record;
      } else if (xhr.status === 404) {
        console.log(`[SyncXHR] Record not found (404)`);
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
    options?: NetworkFetchOptions
  ): NetworkLink[] {
    const url = this.buildLinksUrl(dnaHash, baseAddress, linkType);
    const timeout = options?.timeout ?? this.defaultTimeout;

    console.log(`[SyncXHR] Fetching links: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // false = synchronous
      // Note: timeout cannot be set for synchronous requests from a document
      xhr.setRequestHeader('Accept', 'application/json');
      this.addAuthHeaders(xhr);
      xhr.send();

      if (xhr.status === 200) {
        const links = this.parseLinksResponse(xhr.responseText);
        console.log(`[SyncXHR] Fetched ${links.length} links`);
        return links;
      } else if (xhr.status === 404) {
        console.log(`[SyncXHR] No links found (404)`);
        return [];
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

  getDetailsSync(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: NetworkFetchOptions
  ): any | null {
    const url = this.buildDetailsUrl(dnaHash, hash);
    const timeout = options?.timeout ?? this.defaultTimeout;

    console.log(`[SyncXHR] Fetching details: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // false = synchronous
      // Note: timeout cannot be set for synchronous requests from a document
      xhr.setRequestHeader('Accept', 'application/json');
      this.addAuthHeaders(xhr);
      xhr.send();

      if (xhr.status === 200) {
        const details = JSON.parse(xhr.responseText);
        console.log(`[SyncXHR] Details fetched successfully`);
        return details;
      } else if (xhr.status === 404) {
        console.log(`[SyncXHR] Details not found (404)`);
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
    options?: NetworkFetchOptions
  ): number {
    const url = this.buildCountLinksUrl(dnaHash, baseAddress, linkType);
    const timeout = options?.timeout ?? this.defaultTimeout;

    console.log(`[SyncXHR] Counting links: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // false = synchronous
      // Note: timeout cannot be set for synchronous requests from a document
      xhr.setRequestHeader('Accept', 'application/json');
      this.addAuthHeaders(xhr);
      xhr.send();

      if (xhr.status === 200) {
        const count = JSON.parse(xhr.responseText);
        console.log(`[SyncXHR] Link count: ${count}`);
        return typeof count === 'number' ? count : 0;
      } else if (xhr.status === 404) {
        console.log(`[SyncXHR] No links found (404)`);
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

    console.log(`[SyncXHR] Requesting auth challenge: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, false); // false = synchronous
      // Note: timeout cannot be set for synchronous requests from a document
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send();

      if (xhr.status === 200) {
        const challenge = JSON.parse(xhr.responseText);
        console.log(`[SyncXHR] Auth challenge received`);
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

    console.log(`[SyncXHR] Verifying auth challenge: ${url}`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, false); // false = synchronous
      // Note: timeout cannot be set for synchronous requests from a document
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({
        agent_pub_key: agentPubKey,
        signature: signature,
        nonce: nonce,
      }));

      if (xhr.status === 200) {
        const session = JSON.parse(xhr.responseText);
        console.log(`[SyncXHR] Auth verified, session token received`);
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

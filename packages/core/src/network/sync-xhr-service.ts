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
  NetworkFetchOptions,
} from './types';
import type { DnaHash, AnyDhtHash } from '../types/holochain-types';

/**
 * Convert Uint8Array to base64 for URL encoding
 */
function toBase64Url(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  // Convert to URL-safe base64
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert Uint8Array to standard base64
 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

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
   * Build URL for fetching a record
   */
  private buildRecordUrl(dnaHash: DnaHash, hash: AnyDhtHash): string {
    const dnaHashB64 = toBase64Url(dnaHash);
    const hashB64 = toBase64Url(hash);
    return `${this.gatewayUrl}/dht/${dnaHashB64}/record/${hashB64}`;
  }

  /**
   * Build URL for fetching details
   */
  private buildDetailsUrl(dnaHash: DnaHash, hash: AnyDhtHash): string {
    const dnaHashB64 = toBase64Url(dnaHash);
    const hashB64 = toBase64Url(hash);
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
    const dnaHashB64 = toBase64Url(dnaHash);
    const baseB64 = toBase64(baseAddress);
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
    const dnaHashB64 = toBase64Url(dnaHash);
    const baseB64 = toBase64(baseAddress);
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
      const data = JSON.parse(responseText);
      if (!data || !data.signed_action) {
        return null;
      }

      // Convert base64 fields back to Uint8Array
      // This depends on the gateway response format
      return {
        signed_action: this.parseSignedAction(data.signed_action),
        entry: this.parseEntry(data.entry),
      };
    } catch (error) {
      console.error('[SyncXHR] Failed to parse record response:', error);
      return null;
    }
  }

  /**
   * Parse signed action from gateway response
   */
  private parseSignedAction(data: any): any {
    // Gateway should return msgpack-encoded data or JSON
    // Actual parsing depends on gateway format - placeholder for now
    return data;
  }

  /**
   * Parse entry from gateway response
   */
  private parseEntry(data: any): any {
    if (!data) {
      return 'NotApplicable';
    }
    if (data === 'Hidden' || data === 'NotStored' || data === 'NotApplicable') {
      return data;
    }
    return { Present: data };
  }

  /**
   * Parse links response from gateway
   */
  private parseLinksResponse(responseText: string): NetworkLink[] {
    try {
      const data = JSON.parse(responseText);
      if (!Array.isArray(data)) {
        return [];
      }

      return data.map((link: any) => ({
        create_link_hash: this.base64ToUint8Array(link.create_link_hash),
        base: this.base64ToUint8Array(link.base),
        target: this.base64ToUint8Array(link.target),
        zome_index: link.zome_index,
        link_type: link.link_type,
        tag: link.tag ? this.base64ToUint8Array(link.tag) : new Uint8Array(0),
        timestamp: link.timestamp,
        author: this.base64ToUint8Array(link.author),
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
      xhr.timeout = timeout;
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
      xhr.timeout = timeout;
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
      xhr.timeout = timeout;
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
      xhr.timeout = timeout;
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
      xhr.timeout = this.defaultTimeout;
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
      xhr.timeout = this.defaultTimeout;
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

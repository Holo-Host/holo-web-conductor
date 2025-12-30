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
 * Default timeout for network requests (30 seconds)
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Synchronous XHR network service for offscreen document context
 *
 * Note: This service is designed for use with hc-http-gw or similar gateway.
 * The actual endpoints will be configured in Step 8.
 *
 * Expected gateway endpoints:
 * - GET /dht/{dna_hash}/record/{hash} - Fetch a record by hash
 * - GET /dht/{dna_hash}/links/{base_hash}?type={link_type} - Fetch links
 */
export class SyncXHRNetworkService implements NetworkService {
  private gatewayUrl: string;
  private defaultTimeout: number;

  constructor(gatewayUrl: string, defaultTimeout: number = DEFAULT_TIMEOUT) {
    // Remove trailing slash
    this.gatewayUrl = gatewayUrl.replace(/\/$/, '');
    this.defaultTimeout = defaultTimeout;
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
   * Build URL for fetching links
   */
  private buildLinksUrl(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number
  ): string {
    const dnaHashB64 = toBase64Url(dnaHash);
    const baseB64 = toBase64Url(baseAddress);
    let url = `${this.gatewayUrl}/dht/${dnaHashB64}/links/${baseB64}`;
    if (linkType !== undefined) {
      url += `?type=${linkType}`;
    }
    return url;
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

  isAvailable(): boolean {
    // Check if we're in a DOM context where sync XHR works
    return typeof XMLHttpRequest !== 'undefined';
  }

  getGatewayUrl(): string | null {
    return this.gatewayUrl;
  }
}

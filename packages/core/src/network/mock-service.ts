/**
 * Mock Network Service
 *
 * A mock implementation of NetworkService for testing purposes.
 * Allows pre-configuring responses for specific hashes.
 */

import type {
  NetworkService,
  NetworkRecord,
  NetworkLink,
  NetworkFetchOptions,
} from './types';
import type { DnaHash, AnyDhtHash } from '../types/holochain-types';

/**
 * Convert Uint8Array to base64 for use as map key
 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Mock network service for testing
 *
 * Usage:
 * ```typescript
 * const mockNetwork = new MockNetworkService();
 * mockNetwork.addRecord(hash, record);
 * mockNetwork.addLinks(baseAddress, links);
 *
 * // In tests:
 * const result = mockNetwork.getRecordSync(dnaHash, hash);
 * expect(result).toEqual(record);
 * ```
 */
export class MockNetworkService implements NetworkService {
  private records = new Map<string, NetworkRecord>();
  private links = new Map<string, NetworkLink[]>();
  private available = true;
  private callLog: Array<{ method: string; args: any[] }> = [];

  /**
   * Add a record that will be returned for the given hash
   */
  addRecord(hash: AnyDhtHash, record: NetworkRecord): void {
    const key = toBase64(hash);
    this.records.set(key, record);
  }

  /**
   * Add links that will be returned for the given base address
   */
  addLinks(baseAddress: AnyDhtHash, links: NetworkLink[]): void {
    const key = toBase64(baseAddress);
    const existing = this.links.get(key) || [];
    this.links.set(key, [...existing, ...links]);
  }

  /**
   * Clear all mock data
   */
  clear(): void {
    this.records.clear();
    this.links.clear();
    this.callLog = [];
  }

  /**
   * Set whether the network is available
   */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /**
   * Get the call log for verification in tests
   */
  getCallLog(): Array<{ method: string; args: any[] }> {
    return [...this.callLog];
  }

  /**
   * Clear the call log
   */
  clearCallLog(): void {
    this.callLog = [];
  }

  // NetworkService implementation

  getRecordSync(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: NetworkFetchOptions
  ): NetworkRecord | null {
    this.callLog.push({
      method: 'getRecordSync',
      args: [dnaHash, hash, options],
    });

    if (!this.available) {
      throw new Error('Network unavailable');
    }

    const key = toBase64(hash);
    return this.records.get(key) || null;
  }

  getLinksSync(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    zomeIndex?: number,
    options?: NetworkFetchOptions
  ): NetworkLink[] {
    this.callLog.push({
      method: 'getLinksSync',
      args: [dnaHash, baseAddress, linkType, zomeIndex, options],
    });

    if (!this.available) {
      throw new Error('Network unavailable');
    }

    const key = toBase64(baseAddress);
    let links = this.links.get(key) || [];

    // Filter by link type if specified
    if (linkType !== undefined) {
      links = links.filter((l) => l.link_type === linkType);
    }

    return links;
  }

  getDetailsSync(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: NetworkFetchOptions
  ): any | null {
    this.callLog.push({
      method: 'getDetailsSync',
      args: [dnaHash, hash, options],
    });

    if (!this.available) {
      throw new Error('Network unavailable');
    }

    // Mock returns null - real implementation would return details
    return null;
  }

  countLinksSync(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    zomeIndex?: number,
    options?: NetworkFetchOptions
  ): number {
    this.callLog.push({
      method: 'countLinksSync',
      args: [dnaHash, baseAddress, linkType, zomeIndex, options],
    });

    if (!this.available) {
      throw new Error('Network unavailable');
    }

    const key = toBase64(baseAddress);
    let links = this.links.get(key) || [];

    if (linkType !== undefined) {
      links = links.filter((l) => l.link_type === linkType);
    }

    return links.length;
  }

  isAvailable(): boolean {
    return this.available;
  }

  getGatewayUrl(): string | null {
    return 'mock://test-gateway';
  }
}

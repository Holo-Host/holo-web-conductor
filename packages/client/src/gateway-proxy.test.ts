import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayProxy, GatewayError } from './gateway-proxy';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const GATEWAY_URL = 'https://gateway.example.com';
const DNA_HASH = 'uhC0kTestDnaHash';
const COORDINATOR_ID = 'my-app';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GatewayProxy', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('constructor', () => {
    it('strips trailing slash from gateway URL', () => {
      const proxy = new GatewayProxy(GATEWAY_URL + '/', {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [DNA_HASH],
      });
      expect(proxy.isAvailable()).toBe(true);
    });
  });

  describe('callZome', () => {
    it('calls the correct URL without payload', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ posts: [] }));

      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [DNA_HASH],
      });

      const result = await proxy.callZome({
        dna_hash: DNA_HASH,
        zome_name: 'posts',
        fn_name: 'get_all_posts',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        `${GATEWAY_URL}/${DNA_HASH}/${COORDINATOR_ID}/posts/get_all_posts`,
      );
      expect(result).toEqual({ posts: [] });
    });

    it('encodes payload as base64url query parameter', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ found: true }));

      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [DNA_HASH],
      });

      await proxy.callZome({
        dna_hash: DNA_HASH,
        zome_name: 'posts',
        fn_name: 'get_post',
        payload: { hash: 'abc123' },
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('?payload=');

      // Decode and verify the payload
      const payloadParam = calledUrl.split('?payload=')[1];
      // Convert base64url back to standard base64
      const base64 = payloadParam.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = atob(base64);
      expect(JSON.parse(decoded)).toEqual({ hash: 'abc123' });
    });

    it('omits payload parameter when payload is null', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [DNA_HASH],
      });

      await proxy.callZome({
        dna_hash: DNA_HASH,
        zome_name: 'posts',
        fn_name: 'get_all',
        payload: null,
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('?payload=');
    });

    it('throws GatewayError on HTTP error with structured error body', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Function not allowed' }, 403),
      );

      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [DNA_HASH],
      });

      try {
        await proxy.callZome({
          dna_hash: DNA_HASH,
          zome_name: 'admin',
          fn_name: 'secret_fn',
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GatewayError);
        expect((e as GatewayError).code).toBe('gateway_call_failed');
        expect((e as GatewayError).message).toBe('Function not allowed');
        expect((e as GatewayError).httpStatus).toBe(403);
      }
    });

    it('marks gateway unavailable on 404', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Not Found', { status: 404 }),
      );

      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [DNA_HASH],
      });

      await expect(
        proxy.callZome({
          dna_hash: DNA_HASH,
          zome_name: 'posts',
          fn_name: 'get_all',
        }),
      ).rejects.toThrow(GatewayError);

      expect(proxy.isAvailable()).toBe(false);
    });

    it('marks gateway unavailable on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));

      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [DNA_HASH],
      });

      await expect(
        proxy.callZome({
          dna_hash: DNA_HASH,
          zome_name: 'posts',
          fn_name: 'get_all',
        }),
      ).rejects.toThrow(GatewayError);

      expect(proxy.isAvailable()).toBe(false);
    });

    it('throws when called while unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));

      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [DNA_HASH],
      });

      // First call makes it unavailable
      await expect(
        proxy.callZome({
          dna_hash: DNA_HASH,
          zome_name: 'posts',
          fn_name: 'get_all',
        }),
      ).rejects.toThrow();

      // Second call throws immediately without fetching
      await expect(
        proxy.callZome({
          dna_hash: DNA_HASH,
          zome_name: 'posts',
          fn_name: 'get_all',
        }),
      ).rejects.toThrow('Gateway is not available');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws on unknown DNA hash', async () => {
      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [DNA_HASH],
      });

      await expect(
        proxy.callZome({
          dna_hash: 'uhC0kUnknownDna',
          zome_name: 'posts',
          fn_name: 'get_all',
        }),
      ).rejects.toThrow('not served by this gateway');
    });

    it('allows any DNA hash when dnaHashes is empty', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [],
      });

      await proxy.callZome({
        dna_hash: 'uhC0kAnyDna',
        zome_name: 'posts',
        fn_name: 'get_all',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetAvailability', () => {
    it('resets availability after failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const proxy = new GatewayProxy(GATEWAY_URL, {
        coordinatorId: COORDINATOR_ID,
        dnaHashes: [],
      });

      await expect(
        proxy.callZome({
          dna_hash: DNA_HASH,
          zome_name: 'test',
          fn_name: 'test',
        }),
      ).rejects.toThrow();

      expect(proxy.isAvailable()).toBe(false);

      proxy.resetAvailability();
      expect(proxy.isAvailable()).toBe(true);
    });
  });
});

describe('GatewayError', () => {
  it('has correct properties', () => {
    const err = new GatewayError('test_code', 'Test message', 500);
    expect(err.name).toBe('GatewayError');
    expect(err.code).toBe('test_code');
    expect(err.message).toBe('Test message');
    expect(err.httpStatus).toBe(500);
    expect(err).toBeInstanceOf(Error);
  });
});

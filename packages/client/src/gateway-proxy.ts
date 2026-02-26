/**
 * GatewayProxy — routes callZome requests to an hc-http-gw instance.
 *
 * Used for read-only browsing before the user has joined (browse-before-join UX).
 * The gateway only supports GET requests, so only read-only zome calls are possible.
 */

/**
 * Parameters for a gateway zome call.
 * Mirrors the relevant fields from @holochain/client's CallZomeRequest.
 */
export interface GatewayCallZomeParams {
  dna_hash: string;
  zome_name: string;
  fn_name: string;
  payload?: unknown;
}

/**
 * A thin proxy that routes callZome requests to an hc-http-gw instance.
 *
 * hc-http-gw exposes a GET endpoint:
 *   GET /{dna_hash}/{coordinator_id}/{zome_name}/{fn_name}?payload={base64url_json}
 *
 * The gateway handles msgpack transcoding internally — requests and responses
 * are plain JSON on the wire.
 *
 * @example
 * ```typescript
 * const proxy = new GatewayProxy('https://gateway.example.com', {
 *   coordinatorId: 'my-app',
 *   dnaHashes: ['uhC0k...'],
 * });
 *
 * if (proxy.isAvailable()) {
 *   const result = await proxy.callZome({
 *     dna_hash: 'uhC0k...',
 *     zome_name: 'posts',
 *     fn_name: 'get_all_posts',
 *   });
 * }
 * ```
 */
export class GatewayProxy {
  private readonly gatewayUrl: string;
  private readonly dnaHashes: Set<string>;
  private readonly coordinatorId: string;
  private available = true;

  constructor(
    gatewayUrl: string,
    options: {
      coordinatorId: string;
      dnaHashes: string[];
    },
  ) {
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, '');
    this.dnaHashes = new Set(options.dnaHashes);
    this.coordinatorId = options.coordinatorId;
  }

  /**
   * Whether this gateway proxy is available for calls.
   * Returns false if a previous call indicated the gateway is unreachable.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Call a zome function via the HTTP gateway.
   *
   * Only read-only calls are supported — the gateway uses GET requests
   * and does not have access to the agent's signing key.
   */
  async callZome(params: GatewayCallZomeParams): Promise<unknown> {
    if (!this.available) {
      throw new GatewayError('gateway_unavailable', 'Gateway is not available');
    }

    if (this.dnaHashes.size > 0 && !this.dnaHashes.has(params.dna_hash)) {
      throw new GatewayError(
        'unknown_dna',
        `DNA hash ${params.dna_hash} is not served by this gateway`,
      );
    }

    // Build the URL: /{dna_hash}/{coordinator_id}/{zome_name}/{fn_name}
    let url = `${this.gatewayUrl}/${params.dna_hash}/${this.coordinatorId}/${params.zome_name}/${params.fn_name}`;

    // Encode payload as base64url JSON if present
    if (params.payload !== undefined && params.payload !== null) {
      const jsonPayload = JSON.stringify(params.payload);
      const encoded = base64UrlEncode(jsonPayload);
      url += `?payload=${encoded}`;
    }

    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      this.available = false;
      throw new GatewayError(
        'network_error',
        `Gateway request failed: ${(e as Error).message}`,
      );
    }

    if (!res.ok) {
      if (res.status === 404 || res.status === 503) {
        this.available = false;
      }
      let errorMessage = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body.error) {
          errorMessage = body.error;
        }
      } catch {
        // Response wasn't JSON
      }
      throw new GatewayError('gateway_call_failed', errorMessage, res.status);
    }

    return res.json();
  }

  /**
   * Reset the availability flag (e.g. after a network recovery).
   */
  resetAvailability(): void {
    this.available = true;
  }
}

export class GatewayError extends Error {
  code: string;
  httpStatus?: number;

  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ---- Helpers ----

/**
 * Base64 URL-safe encode a string.
 * hc-http-gw expects base64url (RFC 4648 §5): uses - and _ instead of + and /.
 */
function base64UrlEncode(input: string): string {
  // Encode to UTF-8 bytes, then to base64, then convert to URL-safe
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

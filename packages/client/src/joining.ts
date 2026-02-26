/**
 * JoiningClient — handles the full discovery-join-verify-credentials flow
 * against a Holo joining service.
 *
 * Can be used standalone or orchestrated by WebConductorAppClient.
 */

// ---- API Types ----

export interface WellKnownHoloJoining {
  joining_service_url: string;
  happ_id: string;
  version: string;
}

export interface JoiningServiceInfo {
  happ: {
    id: string;
    name: string;
    description?: string;
    icon_url?: string;
  };
  http_gateways?: HttpGateway[];
  auth_methods: AuthMethod[];
  linker_info: {
    selection_mode: 'assigned' | 'client_choice';
    region_hints?: string[];
  };
  happ_bundle_url?: string;
  dna_modifiers?: DnaModifiers;
}

export interface HttpGateway {
  url: string;
  dna_hashes: string[];
  status: 'available' | 'degraded' | 'offline';
}

export type AuthMethod =
  | 'open'
  | 'email_code'
  | 'sms_code'
  | 'evm_signature'
  | 'solana_signature'
  | 'invite_code'
  | `x-${string}`;

export interface DnaModifiers {
  network_seed?: string;
  properties?: Record<string, unknown>;
}

export interface Challenge {
  id: string;
  type: AuthMethod;
  description: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
  completed?: boolean;
}

export interface JoinCredentials {
  linker_urls: string[];
  membrane_proofs?: Record<string, string>;
  happ_bundle_url?: string;
  dna_modifiers?: DnaModifiers;
  linker_urls_expire_at?: string;
}

export interface ReconnectRequest {
  agent_key: string;
  timestamp: string;
  signature: string;
}

export interface ReconnectResponse {
  linker_urls: string[];
  http_gateways?: HttpGateway[];
  linker_urls_expire_at?: string;
}

interface JoinResponseRaw {
  session: string;
  status: 'ready' | 'pending' | 'rejected';
  challenges?: Challenge[];
  reason?: string;
  poll_interval_ms?: number;
}

interface VerifyResponseRaw {
  status: 'ready' | 'pending' | 'rejected';
  challenges_remaining?: Challenge[];
  reason?: string;
  poll_interval_ms?: number;
}

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ---- Error class ----

export class JoiningError extends Error {
  code: string;
  httpStatus: number;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'JoiningError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

// ---- JoinSession (immutable) ----

export class JoinSession {
  readonly sessionToken: string;
  readonly status: 'ready' | 'pending' | 'rejected';
  readonly challenges?: Challenge[];
  readonly reason?: string;
  readonly pollIntervalMs?: number;

  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    sessionToken: string,
    status: 'ready' | 'pending' | 'rejected',
    challenges?: Challenge[],
    reason?: string,
    pollIntervalMs?: number,
  ) {
    this.baseUrl = baseUrl;
    this.sessionToken = sessionToken;
    this.status = status;
    this.challenges = challenges;
    this.reason = reason;
    this.pollIntervalMs = pollIntervalMs;
  }

  async verify(challengeId: string, response: string): Promise<JoinSession> {
    const res = await fetch(
      `${this.baseUrl}/join/${this.sessionToken}/verify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge_id: challengeId, response }),
      },
    );

    if (!res.ok) {
      await throwJoiningError(res);
    }

    const body: VerifyResponseRaw = await res.json();
    return new JoinSession(
      this.baseUrl,
      this.sessionToken,
      body.status,
      body.challenges_remaining,
      body.reason,
      body.poll_interval_ms,
    );
  }

  async pollStatus(): Promise<JoinSession> {
    const res = await fetch(
      `${this.baseUrl}/join/${this.sessionToken}/status`,
    );

    if (!res.ok) {
      await throwJoiningError(res);
    }

    const body = await res.json();
    return new JoinSession(
      this.baseUrl,
      this.sessionToken,
      body.status,
      body.challenges,
      body.reason,
      body.poll_interval_ms,
    );
  }

  async getCredentials(): Promise<JoinCredentials> {
    const res = await fetch(
      `${this.baseUrl}/join/${this.sessionToken}/credentials`,
    );

    if (!res.ok) {
      await throwJoiningError(res);
    }

    return res.json();
  }
}

// ---- JoiningClient ----

export class JoiningClient {
  private readonly baseUrl: string;
  private cachedInfo?: JoiningServiceInfo;

  private constructor(baseUrl: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Discover a joining service from the app domain's .well-known endpoint.
   */
  static async discover(appDomain: string): Promise<JoiningClient> {
    const origin = appDomain.startsWith('http')
      ? appDomain
      : `https://${appDomain}`;
    const url = `${origin.replace(/\/+$/, '')}/.well-known/holo-joining`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new JoiningError(
        'discovery_failed',
        `Failed to discover joining service at ${url}: ${res.status}`,
        res.status,
      );
    }

    const body: WellKnownHoloJoining = await res.json();
    return new JoiningClient(body.joining_service_url);
  }

  /**
   * Create a client from an explicit joining service URL.
   */
  static fromUrl(joiningServiceUrl: string): JoiningClient {
    return new JoiningClient(joiningServiceUrl);
  }

  /**
   * Get service info (hApp metadata, auth methods, gateways).
   */
  async getInfo(): Promise<JoiningServiceInfo> {
    if (this.cachedInfo) return this.cachedInfo;

    const res = await fetch(`${this.baseUrl}/info`);
    if (!res.ok) {
      await throwJoiningError(res);
    }

    this.cachedInfo = await res.json();
    return this.cachedInfo!;
  }

  /**
   * Initiate a join session for the given agent key.
   *
   * @param agentKey - Base64-encoded 39-byte AgentPubKey
   * @param claims - Optional identity claims (email, invite_code, etc.)
   * @returns A JoinSession — check `.status` to determine next steps
   */
  async join(
    agentKey: string,
    claims?: Record<string, string>,
  ): Promise<JoinSession> {
    const body: Record<string, unknown> = { agent_key: agentKey };
    if (claims && Object.keys(claims).length > 0) {
      body.claims = claims;
    }

    const res = await fetch(`${this.baseUrl}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwJoiningError(res);
    }

    const data: JoinResponseRaw = await res.json();
    return new JoinSession(
      this.baseUrl,
      data.session,
      data.status,
      data.challenges,
      data.reason,
      data.poll_interval_ms,
    );
  }

  /**
   * Reconnect an already-joined agent to get fresh linker/gateway URLs.
   *
   * @param agentKey - Base64-encoded 39-byte AgentPubKey
   * @param signTimestamp - Callback that signs an ISO 8601 timestamp string
   *   with the agent's ed25519 private key and returns the signature bytes
   */
  async reconnect(
    agentKey: string,
    signTimestamp: (timestamp: string) => Promise<Uint8Array>,
  ): Promise<ReconnectResponse> {
    const timestamp = new Date().toISOString();
    const signatureBytes = await signTimestamp(timestamp);
    const signature = uint8ArrayToBase64(signatureBytes);

    const res = await fetch(`${this.baseUrl}/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, timestamp, signature }),
    });

    if (!res.ok) {
      await throwJoiningError(res);
    }

    return res.json();
  }

  /** The resolved base URL of this joining service. */
  get url(): string {
    return this.baseUrl;
  }
}

// ---- Helpers ----

async function throwJoiningError(res: Response): Promise<never> {
  let code = 'unknown_error';
  let message = `HTTP ${res.status}`;
  let details: Record<string, unknown> | undefined;

  try {
    const body: ErrorResponseBody = await res.json();
    if (body.error) {
      code = body.error.code;
      message = body.error.message;
      details = body.error.details;
    }
  } catch {
    // Response wasn't JSON — use status text
    message = res.statusText || message;
  }

  throw new JoiningError(code, message, res.status, details);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Works in both Node.js and browsers
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

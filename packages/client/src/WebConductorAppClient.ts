/**
 * WebConductorAppClient - AppClient implementation for the Holo Web Conductor browser extension.
 *
 * This adapter implements the @holochain/client AppClient interface
 * using the window.holochain API provided by the Web Conductor extension.
 *
 * @example
 * ```typescript
 * import { WebConductorAppClient, waitForHolochain } from '@holo-host/web-conductor-client';
 *
 * await waitForHolochain();
 * const client = await WebConductorAppClient.connect({
 *   linkerUrl: 'http://localhost:8090',
 * });
 *
 * const result = await client.callZome({
 *   role_name: 'my_role',
 *   zome_name: 'my_zome',
 *   fn_name: 'my_function',
 *   payload: { ... },
 * });
 * ```
 */

import {
  CellType,
  SignalType,
  encodeHashToBase64,
  type AppClient,
  type AppInfo,
  type CallZomeRequest,
  type RoleNameCallZomeRequest,
  type SignalCb,
  type AgentPubKey,
  type InstalledAppId,
  type CellId,
  type CreateCloneCellRequest,
  type CreateCloneCellResponse,
  type EnableCloneCellRequest,
  type EnableCloneCellResponse,
  type DisableCloneCellRequest,
  type DisableCloneCellResponse,
  type AppDumpNetworkStatsResponse,
  type DumpNetworkMetricsRequest,
  type DumpNetworkMetricsResponse,
  type Signal,
} from '@holochain/client';

/** Unsubscribe function type */
type UnsubscribeFunction = () => void;

import {
  ConnectionMonitor,
  ReconnectionManager,
  ConnectionStatus,
  type ConnectionConfig,
  type ConnectionState,
  type ConnectionEventMap,
} from './connection';
import { toUint8Array, deepConvertByteArrays } from './utils/byte-arrays';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import type { HolochainAPI, WebConductorAppInfo } from './types';
import {
  JoiningClient,
  JoiningError,
  type Challenge,
  type JoinProvision,
} from '@holo-host/joining-service/client';

/**
 * Options for creating a WebConductorAppClient.
 */
export interface WebConductorAppClientOptions extends ConnectionConfig {
  /** Role name to use for RoleNameCallZomeRequest (default: inferred from hApp) */
  roleName?: string;
  /** Path to hApp bundle for auto-install (default: looks for .happ in current path) */
  happBundlePath?: string;
  /** Explicit joining service URL (e.g. "https://joining.example.com/v1") */
  joiningServiceUrl?: string;
  /** Discover joining service from the current domain's .well-known endpoint */
  autoDiscover?: boolean;
  /** UI callback invoked for each verification challenge during join.
   *  Should return the user's response (e.g. email code, invite code). */
  onChallenge?: (challenge: Challenge) => Promise<string>;
  /** Identity claims to submit with the join request (e.g. { email: "..." }) */
  claims?: Record<string, string>;
  /** Pre-obtained membrane proofs keyed by role name (bypasses joining service) */
  membraneProofs?: Record<string, Uint8Array>;
  /** Skip the initial holochain.connect() call (already connected externally) */
  skipExtensionConnect?: boolean;
}

/**
 * WebConductorAppClient implements the AppClient interface from @holochain/client
 * using the Web Conductor browser extension's window.holochain API.
 */
export class WebConductorAppClient implements AppClient {
  private _myPubKey: AgentPubKey | null = null;
  private _installedAppId: InstalledAppId = '';
  private _cellId: CellId | null = null;
  private _roleName: string;
  private signalHandlers = new Set<SignalCb>();
  private unsubscribeExtension: (() => void) | null = null;

  /** Connection monitor for health status */
  readonly connection: ConnectionMonitor;

  /** Reconnection manager */
  private reconnectionManager: ReconnectionManager;

  /** Connection configuration */
  private connectionConfig: WebConductorAppClientOptions;

  /** Cached AppInfo for ZomeClient compatibility */
  cachedAppInfo: AppInfo | null = null;

  get myPubKey(): AgentPubKey {
    if (!this._myPubKey) throw new Error('Not connected - myPubKey not available');
    return this._myPubKey;
  }

  get installedAppId(): InstalledAppId {
    return this._installedAppId;
  }

  /**
   * Create and connect a WebConductorAppClient.
   *
   * @param config - Connection configuration (string for just linkerUrl, or full config object)
   * @returns Connected WebConductorAppClient
   *
   * @example
   * ```typescript
   * // Simple usage
   * const client = await WebConductorAppClient.connect('http://localhost:8090');
   *
   * // With options
   * const client = await WebConductorAppClient.connect({
   *   linkerUrl: 'http://localhost:8090',
   *   autoReconnect: true,
   *   reconnectDelayMs: 2000,
   * });
   * ```
   */
  static async connect(config: string | WebConductorAppClientOptions): Promise<WebConductorAppClient> {
    const normalizedConfig: WebConductorAppClientOptions =
      typeof config === 'string' ? { linkerUrl: config } : config;

    const client = new WebConductorAppClient(normalizedConfig);
    await client.initialize();
    return client;
  }

  private constructor(config: WebConductorAppClientOptions) {
    this.connectionConfig = {
      autoReconnect: true,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
      healthCheckIntervalMs: 10000,
      ...config,
    };
    this._roleName = config.roleName ?? 'default';

    this.connection = new ConnectionMonitor(this.connectionConfig);
    this.reconnectionManager = new ReconnectionManager(
      this.connectionConfig,
      () => this.doReconnect(),
      (state) => {
        if (state.reconnectAttempt !== undefined && state.nextReconnectMs !== undefined) {
          this.connection.setReconnecting(state.reconnectAttempt, state.nextReconnectMs);
        }
      }
    );

    // Start reconnection on connection errors
    this.connection.on('connection:error', ({ recoverable }) => {
      if (recoverable && this.connectionConfig.autoReconnect !== false) {
        this.reconnectionManager.reconnect();
      }
    });
  }

  private async initialize(): Promise<void> {
    const holochain = window.holochain;
    if (!holochain?.isWebConductor) {
      throw new Error('Holochain extension not detected. Please install the Holochain browser extension.');
    }

    // Connect to extension (triggers authorization popup if needed)
    if (!this.connectionConfig.skipExtensionConnect) {
      await holochain.connect();
    }

    // Check if hApp is already installed
    let alreadyInstalled = false;
    try {
      const info = await holochain.appInfo();
      if (info?.agentPubKey && info?.cells?.length > 0) {
        alreadyInstalled = true;
        // Already installed — try to get fresh linker URLs if joining service is configured
        await this.setupFromAppInfo(info);
        const reconnected = await this.configureLinkerFromJoiningServiceOrConfig(info);
        if (reconnected) {
          this.connection.setConnected();
          this.subscribeToExtensionConnectionStatus();
          return;
        }
        // Reconnect failed — but the app IS installed. Proceed with degraded
        // connectivity so the user can still access their local data.
        // The linker may already be configured from a previous session.
        console.log('[WebConductorAppClient] Reconnect failed but app is installed, proceeding with degraded connectivity');
        this.connection.setConnected();
        this.subscribeToExtensionConnectionStatus();
        return;
      }
    } catch (e) {
      console.log('[WebConductorAppClient] hApp not installed, will install...');
    }

    // Not installed — use joining service if configured
    const useJoiningService = this.connectionConfig.joiningServiceUrl
      || this.connectionConfig.autoDiscover;

    if (useJoiningService) {
      await this.joinAndInstall(holochain);
    } else {
      // Direct flow: configure linker from config, install hApp
      if (this.connectionConfig.linkerUrl) {
        await holochain.configureNetwork({ linkerUrl: this.connectionConfig.linkerUrl });
      }
      await this.installHapp();
    }

    const info = await holochain.appInfo();
    if (!info?.agentPubKey) {
      throw new Error('Failed to get app info after installation');
    }

    await this.setupFromAppInfo(info);
    this.connection.setConnected();
    this.subscribeToExtensionConnectionStatus();
  }

  /**
   * Re-join the joining service to restore a lost session and obtain
   * a fresh linker URL. The hApp is NOT reinstalled — only the joining
   * service session and linker configuration are updated.
   *
   * Use this when the app is already installed but the joining service
   * session was lost (e.g. KV wipe, manual deletion).
   *
   * @param claims - Optional claims for the join flow (e.g. invite_code).
   *                 If omitted, uses the claims from the original connection config.
   * @param onChallenge - Optional callback for interactive challenges.
   *                      If omitted, uses the callback from the original connection config.
   */
  async rejoin(
    claims?: Record<string, string>,
    onChallenge?: (challenge: Challenge) => Promise<string>,
  ): Promise<void> {
    const holochain = window.holochain;
    if (!holochain?.isWebConductor) {
      throw new Error('Holochain extension not detected');
    }

    const mergedConfig = {
      ...this.connectionConfig,
      ...(claims && { claims }),
      ...(onChallenge && { onChallenge }),
    };
    const savedConfig = this.connectionConfig;
    this.connectionConfig = mergedConfig;

    try {
      await this.joinAndConfigure(holochain);
      // Clear any previous joining service error
      this.connection.setJoiningServiceError('');
      this.connection.setConnected();
    } finally {
      this.connectionConfig = savedConfig;
    }
  }

  /**
   * Join via the joining service, obtain provision, configure linker, and install.
   */
  private async joinAndInstall(holochain: HolochainAPI): Promise<void> {
    await this.joinAndConfigure(holochain);

    // Build membrane proofs: map DnaHash keys to role names
    const membraneProofs = this.connectionConfig.membraneProofs
      ?? this.decodeMembraneProofs(this._lastProvision!.membrane_proofs);

    // Fetch and install the hApp bundle
    const bundleUrl = this._lastProvision!.happ_bundle_url
      ?? this.connectionConfig.happBundlePath;
    const bundle = await this.fetchHappBundle(bundleUrl);

    await holochain.installApp({
      bundle,
      installedAppId: this._roleName,
      membraneProofs,
    });
    console.log('[WebConductorAppClient] hApp installed via joining service');
  }

  /** Shared join logic: join the service, handle challenges, configure linker. */
  private _lastProvision: JoinProvision | null = null;
  private async joinAndConfigure(holochain: HolochainAPI): Promise<void> {
    const joiningClient = await this.getJoiningClient();

    // The extension generates the agent key during connect()
    if (!holochain.myPubKey) {
      throw new Error('Agent key not available after connect');
    }
    const agentKeyBase64 = encodeHashToBase64(holochain.myPubKey);

    let provision: JoinProvision;
    try {
      // Attempt to join
      let session = await joiningClient.join(agentKeyBase64, this.connectionConfig.claims);

      // Handle pending challenges (supports OR groups via challenge.group field)
      const satisfiedGroups = new Set<string>();

      while (session.status === 'pending') {
        if (!session.challenges || session.challenges.length === 0) {
          // No challenges but pending — poll until resolved
          await delay(session.pollIntervalMs ?? 2000);
          session = await session.pollStatus();
          continue;
        }

        let madeProgress = false;

        for (const challenge of session.challenges) {
          if (challenge.completed) continue;
          // Skip challenges whose OR group is already satisfied
          if (challenge.group && satisfiedGroups.has(challenge.group)) continue;

          if (challenge.type === 'agent_allow_list') {
            // Machine-verifiable: sign nonce via extension
            const response = await this.signAgentAllowListChallenge(holochain, challenge);
            if (response) {
              session = await session.verify(challenge.id, response);
              if (challenge.group) satisfiedGroups.add(challenge.group);
              madeProgress = true;
              break; // Re-evaluate from top after verify changes session
            }
            // Signing failed or not supported — skip (try OR alternatives)
            continue;
          }

          // Interactive challenge — requires UI callback
          if (!this.connectionConfig.onChallenge) {
            throw new JoiningError(
              'challenge_callback_required',
              'Join session requires verification but no onChallenge callback was provided',
              0,
            );
          }

          const response = await this.connectionConfig.onChallenge(challenge);
          session = await session.verify(challenge.id, response);
          if (challenge.group) satisfiedGroups.add(challenge.group);
          madeProgress = true;
          break; // Re-evaluate from top after verify changes session
        }

        if (!madeProgress) {
          // No actionable challenges — poll for external resolution
          await delay(session.pollIntervalMs ?? 2000);
          session = await session.pollStatus();
        }
      }

      if (session.status === 'rejected') {
        throw new JoiningError(
          'join_rejected',
          session.reason ?? 'Join request was rejected',
          0,
        );
      }

      provision = await session.getProvision();
    } catch (e: unknown) {
      if (e instanceof JoiningError && e.code === 'agent_already_joined') {
        // Already joined — reconnect to get fresh URLs
        provision = await this.reconnectViaJoiningService(joiningClient, holochain);
      } else {
        throw e;
      }
    }

    // Store provision for callers that need it (joinAndInstall uses membrane_proofs)
    this._lastProvision = provision;

    // Configure linker from provision, falling back to config linkerUrl
    const linkerUrl = provision.linker_urls?.[0]?.url
      ?? this.connectionConfig.linkerUrl;
    console.log('[WebConductorAppClient] join linker config:', {
      provisionUrls: provision.linker_urls,
      fallbackUrl: this.connectionConfig.linkerUrl,
      resolvedUrl: linkerUrl,
    });
    if (linkerUrl) {
      console.log('[WebConductorAppClient] Calling configureNetwork with:', linkerUrl);
      await holochain.configureNetwork({ linkerUrl });
      console.log('[WebConductorAppClient] configureNetwork returned');
    } else {
      console.log('[WebConductorAppClient] No linker URL from joining service or config');
    }
  }

  /**
   * Reconnect via the joining service to get fresh linker URLs.
   */
  private async reconnectViaJoiningService(
    joiningClient: JoiningClient,
    holochain: HolochainAPI,
  ): Promise<JoinProvision> {
    if (!holochain.myPubKey) {
      throw new Error('Agent key not available for reconnect');
    }
    const agentKeyBase64 = encodeHashToBase64(holochain.myPubKey);

    const response = await joiningClient.reconnect(
      agentKeyBase64,
      async (timestamp: string) => {
        if (holochain.signReconnectChallenge) {
          return holochain.signReconnectChallenge(timestamp);
        }
        throw new Error('Extension does not support signReconnectChallenge — update required');
      },
    );

    return {
      linker_urls: response.linker_urls,
    };
  }

  /**
   * For an already-installed app, try to configure linker URL from joining service
   * (reconnect flow) or fall back to the config value.
   *
   * @returns true if linker was configured (or no joining service), false if
   *          reconnect failed and no fallback linker URL is available.
   */
  private async configureLinkerFromJoiningServiceOrConfig(
    info: WebConductorAppInfo,
  ): Promise<boolean> {
    const holochain = window.holochain;
    if (!holochain) return true;

    const useJoiningService = this.connectionConfig.joiningServiceUrl
      || this.connectionConfig.autoDiscover;

    if (useJoiningService && holochain.myPubKey) {
      try {
        const joiningClient = await this.getJoiningClient();
        const agentKeyBase64 = encodeHashToBase64(holochain.myPubKey);

        const response = await joiningClient.reconnect(
          agentKeyBase64,
          async (timestamp: string) => {
            if (holochain.signReconnectChallenge) {
              return holochain.signReconnectChallenge(timestamp);
            }
            throw new Error('Extension does not support signReconnectChallenge — update required');
          },
        );

        if (response.linker_urls && response.linker_urls.length > 0) {
          console.log('[WebConductorAppClient] Configuring linker from joining service:', response.linker_urls[0].url);
          await holochain.configureNetwork({ linkerUrl: response.linker_urls[0].url });
          return true;
        }
        console.log('[WebConductorAppClient] Reconnect succeeded but no linker_urls returned');
        return true;
      } catch (e: any) {
        let joiningError: string;
        if (e?.code === 'agent_not_joined' || e?.httpStatus === 403) {
          joiningError = 'Agent session not found in joining service (may have been removed)';
          console.log('[WebConductorAppClient] Agent not found in joining service:', e?.message);
        } else if (e?.code === 'agent_revoked') {
          joiningError = 'Agent has been revoked by administrator';
          console.log('[WebConductorAppClient] Agent revoked by administrator:', e?.message);
        } else {
          joiningError = `Joining service reconnect failed: ${e?.message ?? e}`;
          console.log('[WebConductorAppClient] Joining service reconnect failed:', e);
        }
        this.connection.setJoiningServiceError(joiningError);
        // Fall through to try configured linkerUrl fallback
      }
    }

    // Fall back to configured linkerUrl
    if (this.connectionConfig.linkerUrl) {
      console.log('[WebConductorAppClient] Configuring linker from config:', this.connectionConfig.linkerUrl);
      await holochain.configureNetwork({ linkerUrl: this.connectionConfig.linkerUrl });
      return true;
    }

    console.log('[WebConductorAppClient] No linkerUrl available — proceeding without linker');
    return false;
  }

  /**
   * Auto-handle an agent_allow_list challenge by signing the nonce via the extension.
   * Returns the base64-encoded signature, or null if signing is unavailable/failed.
   */
  private async signAgentAllowListChallenge(
    holochain: HolochainAPI,
    challenge: Challenge,
  ): Promise<string | null> {
    if (!challenge.metadata?.nonce) return null;
    if (!holochain.signJoiningNonce) return null;

    try {
      const nonceBytes = base64ToUint8Array(challenge.metadata.nonce as string);
      const signature = await holochain.signJoiningNonce(nonceBytes);
      return uint8ArrayToBase64(signature);
    } catch {
      return null; // Signing failed — caller can try OR alternatives
    }
  }

  private async getJoiningClient(): Promise<JoiningClient> {
    if (this.connectionConfig.joiningServiceUrl) {
      return JoiningClient.fromUrl(this.connectionConfig.joiningServiceUrl);
    }
    if (this.connectionConfig.autoDiscover) {
      return JoiningClient.discover(window.location.origin);
    }
    throw new Error('No joining service URL configured and autoDiscover is not enabled');
  }

  /**
   * Decode base64-encoded membrane proofs from the joining service response.
   * The joining service returns Record<DnaHash, base64-string> keyed by DnaHash.
   * We decode the values to Uint8Array. The keys stay as DnaHash strings — the
   * extension maps them to role names internally.
   */
  private decodeMembraneProofs(
    proofs?: Record<string, string>,
  ): Record<string, Uint8Array> | undefined {
    if (!proofs) return undefined;

    const decoded: Record<string, Uint8Array> = {};
    for (const [key, value] of Object.entries(proofs)) {
      decoded[key] = base64ToUint8Array(value);
    }
    return decoded;
  }

  private async fetchHappBundle(bundleUrl?: string): Promise<Uint8Array> {
    const paths = bundleUrl
      ? [bundleUrl]
      : this.connectionConfig.happBundlePath
        ? [this.connectionConfig.happBundlePath]
        : ['/app.happ', `/${this._roleName}.happ`, '/bundle.happ'];

    for (const path of paths) {
      try {
        const response = await fetch(path);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          // Validate: gzip magic number (1f 8b) confirms this is a real .happ bundle,
          // not an SPA fallback serving index.html with a 200 status.
          if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
            console.warn(`[WebConductorAppClient] ${path} is not a gzip bundle (got ${bytes.length} bytes), skipping`);
            continue;
          }
          console.log(`[WebConductorAppClient] Found hApp bundle at ${path} (${bytes.length} bytes)`);
          return bytes;
        }
      } catch {
        // Try next path
      }
    }

    throw new Error(
      `Failed to fetch hApp bundle. Tried: ${paths.join(', ')}. ` +
        'Provide happBundlePath in config or place bundle at one of these locations.'
    );
  }

  /**
   * Subscribe to extension's connection status updates for real-time monitoring.
   * The extension handles health checks - we just reflect its status.
   *
   * Extension connection status is separate from linker health:
   * - Extension: Always "connected" if window.holochain exists
   * - Linker: May be healthy or unreachable
   */
  private subscribeToExtensionConnectionStatus(): void {
    const holochain = window.holochain;
    if (!holochain?.onConnectionChange) return;

    // Disable client-side auto-reconnection since extension handles health monitoring
    this.reconnectionManager.cancel();

    const applyStatus = (status: { httpHealthy: boolean; wsHealthy: boolean; authenticated: boolean; linkerUrl?: string | null; lastError?: string }) => {
      this.connection.setLinkerHealth(
        status.httpHealthy,
        status.wsHealthy,
        status.authenticated,
        status.lastError,
        status.linkerUrl,
      );
    };

    // Subscribe to future changes
    holochain.onConnectionChange(applyStatus);

    // Fetch current status to catch events that fired before we subscribed
    // (e.g., WS auth completing during the connect flow)
    if (holochain.getConnectionStatus) {
      holochain.getConnectionStatus().then(applyStatus).catch(() => {});
    }
  }

  private async setupFromAppInfo(info: WebConductorAppInfo): Promise<void> {
    this._myPubKey = toUint8Array(info.agentPubKey);
    this._installedAppId = info.contextId || 'default';

    if (!info.cells || info.cells.length === 0) {
      throw new Error('No cells available in app info');
    }
    this._cellId = [toUint8Array(info.cells[0][0]), toUint8Array(info.cells[0][1])];

    // Infer role name from context if not provided
    if (!this.connectionConfig.roleName) {
      this._roleName = info.contextId?.split('.')[0] || 'default';
    }

    // Cache AppInfo for ZomeClient signal filtering
    this.cachedAppInfo = await this.appInfo();
    this.setupSignalForwarding();
  }

  private async installHapp(): Promise<void> {
    const holochain = window.holochain;
    if (!holochain) throw new Error('Holochain extension not available');

    const bundle = await this.fetchHappBundle();

    console.log('[WebConductorAppClient] Installing hApp...');
    await holochain.installApp({
      bundle,
      installedAppId: this._roleName,
      membraneProofs: this.connectionConfig.membraneProofs,
    });
    console.log('[WebConductorAppClient] hApp installed successfully');
  }

  private setupSignalForwarding(): void {
    const holochain = window.holochain;
    if (!holochain) return;

    // Unsubscribe from previous if any
    if (this.unsubscribeExtension) {
      this.unsubscribeExtension();
    }

    // Subscribe to signals from extension
    this.unsubscribeExtension = holochain.on('signal', (rawSignal: unknown) => {
      const raw = rawSignal as {
        value?: {
          cell_id?: [unknown, unknown];
          zome_name?: string;
          payload?: unknown;
        };
      };

      // Convert to standard Signal format expected by @holochain/client
      const signal: Signal = {
        type: SignalType.App,
        value: {
          cell_id: raw.value?.cell_id
            ? [toUint8Array(raw.value.cell_id[0]), toUint8Array(raw.value.cell_id[1])]
            : this._cellId!,
          zome_name: raw.value?.zome_name || '',
          payload: raw.value?.payload,
        },
      };

      // Dispatch to all registered handlers
      this.signalHandlers.forEach((handler) => {
        try {
          handler(signal);
        } catch (e) {
          console.error('[WebConductorAppClient] Signal handler error:', e);
        }
      });
    });
  }

  private async doReconnect(): Promise<void> {
    const holochain = window.holochain;
    if (!holochain) throw new Error('Holochain extension not available');

    // Try WebSocket reconnect if available
    if (holochain.reconnectWebSocket) {
      await holochain.reconnectWebSocket();
    }

    // Re-verify connection
    await holochain.connect();

    this.reconnectionManager.reset();
    this.connection.setConnected();
  }

  // --- Public API ---

  /**
   * Subscribe to connection events.
   *
   * @param event - Event name
   * @param callback - Event handler
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = client.onConnection('connection:change', (state) => {
   *   console.log('Connection status:', state.status);
   *   if (state.status === ConnectionStatus.Error) {
   *     showErrorBanner(state.lastError);
   *   }
   * });
   * ```
   */
  onConnection<K extends keyof ConnectionEventMap>(
    event: K,
    callback: (data: ConnectionEventMap[K]) => void
  ): () => void {
    return this.connection.on(event, callback);
  }

  /**
   * Get current connection state.
   */
  getConnectionState(): ConnectionState {
    return this.connection.getState();
  }

  /**
   * Manually trigger reconnection.
   */
  async reconnect(): Promise<void> {
    this.reconnectionManager.cancel();
    await this.doReconnect();
  }

  /**
   * Call a zome function.
   */
  async callZome(
    args: CallZomeRequest | RoleNameCallZomeRequest,
    _timeout?: number
  ): Promise<unknown> {
    const holochain = window.holochain;
    if (!holochain) throw new Error('Holochain extension not available');

    // Determine cell_id
    let cell_id: CellId;
    if ('role_name' in args) {
      // RoleNameCallZomeRequest - use stored cell_id
      if (!this._cellId) {
        throw new Error('No cell_id available - not connected');
      }
      cell_id = this._cellId;
    } else {
      cell_id = args.cell_id;
    }

    try {
      const result = await holochain.callZome({
        cell_id,
        zome_name: args.zome_name,
        fn_name: args.fn_name,
        payload: args.payload,
        provenance: args.provenance || this._myPubKey || undefined,
        cap_secret: args.cap_secret,
      });

      this.connection.reportCallSuccess();

      // Chrome messaging converts Uint8Array to plain arrays.
      // Convert them back for @holochain/client compatibility.
      return deepConvertByteArrays(result);
    } catch (error) {
      this.connection.reportCallFailure(error as Error);
      throw error;
    }
  }

  /**
   * Subscribe to signals.
   */
  on<Name extends keyof { signal: Signal }>(
    eventName: Name | readonly Name[],
    listener: SignalCb
  ): UnsubscribeFunction {
    const events = Array.isArray(eventName) ? eventName : [eventName];

    if (events.includes('signal' as Name)) {
      this.signalHandlers.add(listener);
      return () => {
        this.signalHandlers.delete(listener);
      };
    }

    // Return no-op unsubscribe for unknown events
    return () => {};
  }

  /**
   * Get app info in standard @holochain/client format.
   */
  async appInfo(): Promise<AppInfo | null> {
    const holochain = window.holochain;
    if (!holochain) throw new Error('Holochain extension not available');

    const info = await holochain.appInfo();
    if (!info) return null;

    // Convert extension format to standard AppInfo format
    const agentPubKey = toUint8Array(info.agentPubKey);
    const cellId: CellId = [toUint8Array(info.cells[0][0]), toUint8Array(info.cells[0][1])];

    // Get DNA properties from the extension response (stored during hApp installation)
    // Encode as msgpack bytes since @holochain/client expects SerializedBytes
    const rawProperties = info.dnaProperties?.[this._roleName] ?? null;
    const propertiesBytes = new Uint8Array(msgpackEncode(rawProperties));

    // Construct AppInfo in @holochain/client format
    // Use type assertions for fields that may vary between client versions
    const appInfo: AppInfo = {
      installed_app_id: info.contextId || this._installedAppId,
      agent_pub_key: agentPubKey,
      cell_info: {
        [this._roleName]: [
          {
            type: CellType.Provisioned,
            value: {
              cell_id: cellId,
              dna_modifiers: {
                network_seed: '',
                properties: propertiesBytes,
                origin_time: 0,
                quantum_time: { secs: 0, nanos: 0 },
              } as any,
              name: this._roleName,
            },
          },
        ],
      } as any,
      status: { type: 'running' } as any,
      installed_at: Date.now() * 1000,
    };

    return appInfo;
  }

  /**
   * Disconnect from the extension and stop monitoring.
   */
  async disconnect(): Promise<void> {
    this.connection.stop();
    this.reconnectionManager.cancel();

    if (this.unsubscribeExtension) {
      this.unsubscribeExtension();
      this.unsubscribeExtension = null;
    }

    const holochain = window.holochain;
    if (holochain) {
      await holochain.disconnect();
    }

    this.connection.setDisconnected();
  }

  /**
   * Provide membrane proofs for an app in 'awaitingMemproofs' state.
   * This triggers genesis with the provided proofs.
   *
   * @param memproofs - Map of role_name to proof bytes
   * @param contextId - Optional context ID (defaults to current app)
   */
  async provideMemproofs(
    memproofs: Record<string, Uint8Array>,
    contextId?: string
  ): Promise<void> {
    const holochain = window.holochain;
    if (!holochain) throw new Error('Holochain extension not available');

    await holochain.provideMemproofs({
      contextId: contextId || this._installedAppId || undefined,
      memproofs,
    });
  }

  // --- Stub implementations for methods not supported by Web Conductor ---

  async dumpNetworkStats(): Promise<AppDumpNetworkStatsResponse> {
    console.warn('[WebConductorAppClient] dumpNetworkStats not supported in Web Conductor mode');
    return { peer_urls: [], connections: [] } as unknown as AppDumpNetworkStatsResponse;
  }

  async dumpNetworkMetrics(
    _args: DumpNetworkMetricsRequest
  ): Promise<DumpNetworkMetricsResponse> {
    console.warn('[WebConductorAppClient] dumpNetworkMetrics not supported in Web Conductor mode');
    return {} as DumpNetworkMetricsResponse;
  }

  async createCloneCell(_args: CreateCloneCellRequest): Promise<CreateCloneCellResponse> {
    throw new Error('createCloneCell not supported in Web Conductor mode');
  }

  async enableCloneCell(_args: EnableCloneCellRequest): Promise<EnableCloneCellResponse> {
    throw new Error('enableCloneCell not supported in Web Conductor mode');
  }

  async disableCloneCell(_args: DisableCloneCellRequest): Promise<DisableCloneCellResponse> {
    throw new Error('disableCloneCell not supported in Web Conductor mode');
  }
}

// ---- Module-level helpers ----

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

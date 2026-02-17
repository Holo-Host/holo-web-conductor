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
 *   gatewayUrl: 'http://localhost:8090',
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

/**
 * Options for creating a WebConductorAppClient.
 */
export interface WebConductorAppClientOptions extends ConnectionConfig {
  /** Role name to use for RoleNameCallZomeRequest (default: inferred from hApp) */
  roleName?: string;
  /** Path to hApp bundle for auto-install (default: looks for .happ in current path) */
  happBundlePath?: string;
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
   * @param config - Connection configuration (string for just gatewayUrl, or full config object)
   * @returns Connected WebConductorAppClient
   *
   * @example
   * ```typescript
   * // Simple usage
   * const client = await WebConductorAppClient.connect('http://localhost:8090');
   *
   * // With options
   * const client = await WebConductorAppClient.connect({
   *   gatewayUrl: 'http://localhost:8090',
   *   autoReconnect: true,
   *   reconnectDelayMs: 2000,
   * });
   * ```
   */
  static async connect(config: string | WebConductorAppClientOptions): Promise<WebConductorAppClient> {
    const normalizedConfig: WebConductorAppClientOptions =
      typeof config === 'string' ? { gatewayUrl: config } : config;

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

    // Configure gateway
    await holochain.configureNetwork({ gatewayUrl: this.connectionConfig.gatewayUrl });

    // Connect (triggers authorization popup if needed)
    await holochain.connect();

    // Check if hApp is installed by getting app info
    try {
      const info = await holochain.appInfo();
      if (info?.agentPubKey && info?.cells?.length > 0) {
        // Already installed
        await this.setupFromAppInfo(info);
        this.connection.setConnected();
        // Subscribe to extension's push status updates (no polling needed)
        this.subscribeToExtensionConnectionStatus();
        return;
      }
    } catch (e) {
      // Not installed yet, continue to installation
      console.log('[WebConductorAppClient] hApp not installed, will install...');
    }

    // Install hApp
    await this.installHapp();

    // Get app info after install
    const info = await holochain.appInfo();
    if (!info?.agentPubKey) {
      throw new Error('Failed to get app info after installation');
    }

    await this.setupFromAppInfo(info);
    this.connection.setConnected();
    // Don't call this.connection.start() - we get push updates from extension
    // via subscribeToExtensionConnectionStatus() instead of polling
    this.subscribeToExtensionConnectionStatus();
  }

  /**
   * Subscribe to extension's connection status updates for real-time monitoring.
   * The extension handles health checks - we just reflect its status.
   *
   * Extension connection status is separate from gateway health:
   * - Extension: Always "connected" if window.holochain exists
   * - Gateway: May be healthy or unreachable
   */
  private subscribeToExtensionConnectionStatus(): void {
    const holochain = window.holochain;
    if (!holochain?.onConnectionChange) return;

    // Disable client-side auto-reconnection since extension handles health monitoring
    this.reconnectionManager.cancel();

    // Get initial status immediately (subscription only fires on changes)
    if (holochain.getConnectionStatus) {
      holochain.getConnectionStatus().then((status) => {
        this.connection.setGatewayHealth(
          status.httpHealthy,
          status.wsHealthy,
          status.lastError
        );
      }).catch(() => {
        // Ignore - extension may not support this API
      });
    }

    // Subscribe to future changes
    holochain.onConnectionChange((status) => {
      this.connection.setGatewayHealth(
        status.httpHealthy,
        status.wsHealthy,
        status.lastError
      );
    });
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

    // Try to fetch bundled hApp from configured path or common locations
    const paths = this.connectionConfig.happBundlePath
      ? [this.connectionConfig.happBundlePath]
      : ['./app.happ', `./${this._roleName}.happ`, './bundle.happ'];

    let bundle: Uint8Array | null = null;
    for (const path of paths) {
      try {
        const response = await fetch(path);
        if (response.ok) {
          bundle = new Uint8Array(await response.arrayBuffer());
          console.log(`[WebConductorAppClient] Found hApp bundle at ${path}`);
          break;
        }
      } catch {
        // Try next path
      }
    }

    if (!bundle) {
      throw new Error(
        `Failed to fetch hApp bundle. Tried: ${paths.join(', ')}. ` +
          'Provide happBundlePath in config or place bundle at one of these locations.'
      );
    }

    console.log('[WebConductorAppClient] Installing hApp...');
    await holochain.installApp({
      bundle,
      installedAppId: this._roleName,
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

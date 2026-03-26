/**
 * @holo-host/web-conductor-client
 *
 * Drop-in replacement for @holochain/client's AppClient that uses the
 * Holo Web Conductor browser extension for zero-arc Holochain nodes.
 *
 * @example
 * ```typescript
 * import { WebConductorAppClient, waitForHolochain, ConnectionStatus } from '@holo-host/web-conductor-client';
 *
 * // Wait for extension to be ready
 * await waitForHolochain();
 *
 * // Connect to linker
 * const client = await WebConductorAppClient.connect({
 *   linkerUrl: 'http://localhost:8090',
 *   autoReconnect: true,
 * });
 *
 * // Monitor connection status
 * client.onConnection('connection:change', (state) => {
 *   if (state.status === ConnectionStatus.Error) {
 *     showReconnectingBanner();
 *   } else if (state.status === ConnectionStatus.Connected) {
 *     hideReconnectingBanner();
 *   }
 * });
 *
 * // Use like regular AppClient
 * const result = await client.callZome({
 *   role_name: 'my_role',
 *   zome_name: 'my_zome',
 *   fn_name: 'my_function',
 *   payload: { ... },
 * });
 * ```
 *
 * @packageDocumentation
 */

// Core client
export { WebConductorAppClient, type WebConductorAppClientOptions } from './WebConductorAppClient';

// Connection management
export {
  ConnectionStatus,
  type ConnectionState,
  type ConnectionConfig,
  type ConnectionStatusAPI,
  type ConnectionEventMap,
  type ConnectionEventListener,
} from './connection/types';
export { ConnectionMonitor } from './connection/monitor';
export { ReconnectionManager } from './connection/reconnect';

// Utilities
export { waitForHolochain, isWebConductorAvailable } from './utils/wait-for-holochain';
export { deepConvertByteArrays, toUint8Array, looksLikeByteArray } from './utils/byte-arrays';

// Joining service client (re-exported from @holo-host/joining-service/client)
export {
  JoiningClient,
  JoinSession,
  JoiningError,
} from '@holo-host/joining-service/client';
export type {
  WellKnownHoloJoining,
  JoiningServiceInfo,
  HttpGateway,
  LinkerUrl,
  AuthMethod,
  DnaModifiers,
  Challenge,
  JoinProvision,
  ReconnectRequest,
  ReconnectResponse,
} from '@holo-host/joining-service/client';

// Gateway proxy (read-only browsing before join)
export { GatewayProxy, GatewayError, type GatewayCallZomeParams } from '@holo-host/joining-service/client';

// Types
export type { HolochainAPI, WebConductorAppInfo, CallZomeParams, InstallAppRequest } from './types';

// Re-export useful @holochain/client types for convenience
export type {
  AppClient,
  AppInfo,
  CallZomeRequest,
  RoleNameCallZomeRequest,
  Signal,
  SignalCb,
  AgentPubKey,
  CellId,
  InstalledAppId,
} from '@holochain/client';
export { CellType, SignalType } from '@holochain/client';

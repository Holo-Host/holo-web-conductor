/**
 * @holo-host/web-conductor-client
 *
 * Drop-in replacement for @holochain/client's AppClient that uses the
 * Holo Web Conductor browser extension for zero-arc Holochain nodes.
 *
 * @example
 * ```typescript
 * import { FishyAppClient, waitForFishy, ConnectionStatus } from '@holo-host/web-conductor-client';
 *
 * // Wait for extension to be ready
 * await waitForFishy();
 *
 * // Connect to gateway
 * const client = await FishyAppClient.connect({
 *   gatewayUrl: 'http://localhost:8090',
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
export { FishyAppClient, type FishyAppClientOptions } from './FishyAppClient';

// Connection management
export {
  ConnectionStatus,
  type ConnectionState,
  type ConnectionConfig,
  type ConnectionEventMap,
  type ConnectionEventListener,
} from './connection/types';
export { ConnectionMonitor } from './connection/monitor';
export { ReconnectionManager } from './connection/reconnect';

// Utilities
export { waitForFishy, isFishyAvailable } from './utils/wait-for-fishy';
export { deepConvertByteArrays, toUint8Array, looksLikeByteArray } from './utils/byte-arrays';

// Types
export type { FishyHolochainAPI, FishyAppInfo, CallZomeParams, InstallAppRequest } from './types';

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

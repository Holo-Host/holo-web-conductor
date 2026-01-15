/**
 * Connection management exports.
 */

export {
  ConnectionStatus,
  type ConnectionState,
  type ConnectionConfig,
  type ConnectionEventMap,
  type ConnectionEventListener,
} from './types';

export { ConnectionMonitor } from './monitor';
export { ReconnectionManager } from './reconnect';

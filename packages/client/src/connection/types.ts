/**
 * Connection status and monitoring types for FishyAppClient.
 */

/**
 * Connection status enum representing the current state of the gateway connection.
 */
export enum ConnectionStatus {
  /** Not connected to the gateway */
  Disconnected = 'disconnected',
  /** Attempting initial connection */
  Connecting = 'connecting',
  /** Successfully connected to gateway */
  Connected = 'connected',
  /** Connection lost, attempting to reconnect */
  Reconnecting = 'reconnecting',
  /** Connection error (may or may not be recoverable) */
  Error = 'error',
}

/**
 * Current state of the gateway connection.
 */
export interface ConnectionState {
  /** Overall connection status */
  status: ConnectionStatus;
  /** Whether HTTP endpoint is healthy */
  httpHealthy: boolean;
  /** Whether WebSocket is connected */
  wsHealthy: boolean;
  /** Last error message if status is Error */
  lastError?: string;
  /** Current reconnection attempt number (if reconnecting) */
  reconnectAttempt?: number;
  /** Milliseconds until next reconnection attempt */
  nextReconnectMs?: number;
}

/**
 * Configuration for gateway connection.
 */
export interface ConnectionConfig {
  /** URL of the hc-http-gw gateway */
  gatewayUrl: string;
  /** Enable automatic reconnection (default: true) */
  autoReconnect?: boolean;
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelayMs?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs?: number;
  /** Health check interval in ms (default: 10000) */
  healthCheckIntervalMs?: number;
}

/**
 * Event map for connection-related events.
 */
export interface ConnectionEventMap {
  /** Fired when connection state changes */
  'connection:change': ConnectionState;
  /** Fired when a connection error occurs */
  'connection:error': { error: string; recoverable: boolean };
  /** Fired when starting a reconnection attempt */
  'connection:reconnecting': { attempt: number; delayMs: number };
  /** Fired when successfully reconnected after disconnect */
  'connection:reconnected': void;
}

/**
 * Type for connection event listener functions.
 */
export type ConnectionEventListener<K extends keyof ConnectionEventMap> = (
  data: ConnectionEventMap[K]
) => void;

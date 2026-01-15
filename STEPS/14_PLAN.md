# Step 14: Fishy Client Library Package

**Status**: PLANNED
**Priority**: High (enables ecosystem adoption)
**Dependencies**: Step 12.2 (debug panel provides connection status patterns)

## Goal

Create a standalone `@zippy/fishy-client` (or `@holochain/fishy-client`) npm package that:
1. Drop-in replacement for `@holochain/client`'s AppClient
2. Provides connection status and reconnection UI hooks
3. Usable by any hApp wanting to support the Fishy extension
4. Works both published to npm and locally during development

---

## Current State

**FishyAppClient location**: `../ziptest/ui/src/fishy/FishyAppClient.ts`

**Current features**:
- Implements `AppClient` interface from @holochain/client
- `callZome()`, `appInfo()`, `on("signal", cb)` methods
- Deep conversion of Chrome message arrays back to Uint8Array
- `cachedAppInfo` for ZomeClient compatibility
- `waitForFishy()` helper function

**Missing features**:
- Connection status monitoring (HTTP/WebSocket health)
- Reconnection logic with exponential backoff
- Event emitters for connection state changes
- Gateway configuration persistence
- Network diagnostics for debugging

---

## Package Structure

```
packages/client/
├── package.json           # @zippy/fishy-client
├── tsconfig.json
├── vite.config.ts         # Library build config
├── src/
│   ├── index.ts           # Main exports
│   ├── FishyAppClient.ts  # Core AppClient implementation
│   ├── connection/
│   │   ├── index.ts
│   │   ├── types.ts       # ConnectionState, ConnectionConfig
│   │   ├── monitor.ts     # Connection health monitoring
│   │   └── reconnect.ts   # Reconnection logic
│   ├── utils/
│   │   ├── byte-arrays.ts # Deep Uint8Array conversion
│   │   └── wait-for-fishy.ts
│   └── types.ts           # Public type exports
├── test/
│   └── FishyAppClient.test.ts
└── README.md
```

---

## Phase 1: Package Setup & Migration

### 1.1 Create Package Structure

**package.json**:
```json
{
  "name": "@zippy/fishy-client",
  "version": "0.1.0",
  "description": "Holochain AppClient for Fishy browser extension",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist", "README.md"],
  "peerDependencies": {
    "@holochain/client": "^0.18.0"
  },
  "devDependencies": {
    "@holochain/client": "^0.18.0",
    "typescript": "^5.0.0",
    "vite": "^5.0.0",
    "vite-plugin-dts": "^3.0.0"
  },
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "test": "vitest",
    "prepublishOnly": "npm run build"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/anthropics/fishy"
  },
  "keywords": ["holochain", "browser-extension", "zero-arc"],
  "license": "MIT"
}
```

**vite.config.ts** (library mode):
```typescript
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FishyClient',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['@holochain/client'],
    },
  },
  plugins: [dts({ rollupTypes: true })],
});
```

### 1.2 Migrate FishyAppClient

Move from `../ziptest/ui/src/fishy/`:
- `FishyAppClient.ts` → `packages/client/src/FishyAppClient.ts`
- `ZeroArcProfilesClient.ts` → Keep in ziptest (app-specific)
- `index.ts` → `packages/client/src/index.ts`

Extract utilities:
- `toUint8Array()` → `packages/client/src/utils/byte-arrays.ts`
- `deepConvertByteArrays()` → `packages/client/src/utils/byte-arrays.ts`
- `looksLikeByteArray()` → `packages/client/src/utils/byte-arrays.ts`
- `waitForFishy()` → `packages/client/src/utils/wait-for-fishy.ts`

---

## Phase 2: Connection Status Interface

### 2.1 Connection Types

**File: `packages/client/src/connection/types.ts`**

```typescript
export enum ConnectionStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Error = 'error',
}

export interface ConnectionState {
  status: ConnectionStatus;
  httpHealthy: boolean;
  wsHealthy: boolean;
  lastError?: string;
  reconnectAttempt?: number;
  nextReconnectMs?: number;
}

export interface ConnectionConfig {
  gatewayUrl: string;
  /** Enable automatic reconnection (default: true) */
  autoReconnect?: boolean;
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelayMs?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs?: number;
  /** Health check interval in ms (default: 5000) */
  healthCheckIntervalMs?: number;
}

export type ConnectionEventMap = {
  'connection:change': ConnectionState;
  'connection:error': { error: string; recoverable: boolean };
  'connection:reconnecting': { attempt: number; delayMs: number };
  'connection:reconnected': void;
};
```

### 2.2 Connection Monitor

**File: `packages/client/src/connection/monitor.ts`**

```typescript
/**
 * Monitors gateway connection health via:
 * 1. HTTP health endpoint polling
 * 2. WebSocket connection state
 * 3. Zome call success/failure patterns
 */
export class ConnectionMonitor {
  private state: ConnectionState;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private listeners = new Map<keyof ConnectionEventMap, Set<Function>>();

  constructor(private config: ConnectionConfig) {
    this.state = {
      status: ConnectionStatus.Disconnected,
      httpHealthy: false,
      wsHealthy: false,
    };
  }

  /** Start health monitoring */
  start(): void { ... }

  /** Stop health monitoring */
  stop(): void { ... }

  /** Get current connection state */
  getState(): ConnectionState { ... }

  /** Subscribe to connection events */
  on<K extends keyof ConnectionEventMap>(
    event: K,
    callback: (data: ConnectionEventMap[K]) => void
  ): () => void { ... }

  /** Report a zome call failure (used internally) */
  reportCallFailure(error: Error): void { ... }

  /** Report a zome call success (used internally) */
  reportCallSuccess(): void { ... }

  private async checkHealth(): Promise<void> { ... }
  private emit<K extends keyof ConnectionEventMap>(event: K, data: ConnectionEventMap[K]): void { ... }
}
```

### 2.3 Reconnection Logic

**File: `packages/client/src/connection/reconnect.ts`**

```typescript
/**
 * Handles automatic reconnection with exponential backoff
 */
export class ReconnectionManager {
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private isReconnecting = false;

  constructor(
    private config: ConnectionConfig,
    private reconnectFn: () => Promise<void>,
    private onStateChange: (state: Partial<ConnectionState>) => void
  ) {}

  /** Trigger reconnection sequence */
  async reconnect(): Promise<void> { ... }

  /** Cancel ongoing reconnection */
  cancel(): void { ... }

  /** Reset attempt counter (call on successful connection) */
  reset(): void { ... }

  private getDelay(): number {
    // Exponential backoff: delay * 2^attempt, capped at max
    const delay = this.config.reconnectDelayMs ?? 1000;
    const max = this.config.maxReconnectDelayMs ?? 30000;
    return Math.min(delay * Math.pow(2, this.attempt), max);
  }
}
```

---

## Phase 3: Enhanced FishyAppClient

### 3.1 Add Connection Management to Client

**File: `packages/client/src/FishyAppClient.ts`**

```typescript
import { ConnectionMonitor, ConnectionState, ConnectionConfig, ConnectionEventMap } from './connection';

export class FishyAppClient implements AppClient {
  // Existing properties...

  /** Connection monitor for health status */
  readonly connection: ConnectionMonitor;

  /** Connection configuration */
  private connectionConfig: ConnectionConfig;

  /**
   * Create and connect a FishyAppClient
   *
   * @param config - Connection configuration including gateway URL
   * @returns Connected FishyAppClient
   */
  static async connect(config: string | ConnectionConfig): Promise<FishyAppClient> {
    const normalizedConfig = typeof config === 'string'
      ? { gatewayUrl: config }
      : config;

    const client = new FishyAppClient(normalizedConfig);
    await client.initialize();
    return client;
  }

  private constructor(config: ConnectionConfig) {
    this.connectionConfig = {
      autoReconnect: true,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
      healthCheckIntervalMs: 5000,
      ...config,
    };
    this.connection = new ConnectionMonitor(this.connectionConfig);
  }

  /**
   * Subscribe to connection events
   *
   * @example
   * ```typescript
   * client.onConnection('connection:change', (state) => {
   *   console.log('Connection status:', state.status);
   *   if (state.status === 'error') {
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
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connection.getState();
  }

  /**
   * Manually trigger reconnection
   */
  async reconnect(): Promise<void> {
    // Re-initialize connection to gateway
    await this.initialize();
  }

  // Enhanced callZome with connection tracking
  async callZome(args: CallZomeRequest | RoleNameCallZomeRequest, timeout?: number): Promise<any> {
    try {
      const result = await this._callZomeInternal(args, timeout);
      this.connection.reportCallSuccess();
      return result;
    } catch (error) {
      this.connection.reportCallFailure(error as Error);
      throw error;
    }
  }

  // ... rest of existing implementation
}
```

### 3.2 Update Exports

**File: `packages/client/src/index.ts`**

```typescript
// Core client
export { FishyAppClient } from './FishyAppClient';

// Connection management
export {
  ConnectionStatus,
  ConnectionState,
  ConnectionConfig,
  ConnectionEventMap,
} from './connection/types';
export { ConnectionMonitor } from './connection/monitor';

// Utilities
export { waitForFishy } from './utils/wait-for-fishy';
export { deepConvertByteArrays, toUint8Array } from './utils/byte-arrays';

// Re-export useful @holochain/client types for convenience
export type {
  AppClient,
  AppInfo,
  CallZomeRequest,
  Signal,
  AgentPubKey,
  CellId,
} from '@holochain/client';
```

---

## Phase 4: Extension API Enhancements

The client needs corresponding extension API support. Add to `window.holochain`:

**File: `packages/extension/src/inject/index.ts`** (or content script)

```typescript
interface FishyHolochainAPI {
  // Existing...

  /** Get connection status */
  getConnectionStatus(): Promise<{
    httpHealthy: boolean;
    wsHealthy: boolean;
    gatewayUrl: string;
  }>;

  /** Subscribe to connection status changes */
  onConnectionChange(callback: (status: ConnectionState) => void): () => void;

  /** Manually trigger WebSocket reconnection */
  reconnectWebSocket(): Promise<void>;
}
```

**File: `packages/extension/src/background/index.ts`**

Add message handlers:
- `GET_CONNECTION_STATUS` - Return current HTTP/WS health
- `RECONNECT_WEBSOCKET` - Force WebSocket reconnection

---

## Phase 5: Local Development Support

### 5.1 npm link workflow

For local development, apps can use:

```bash
# In fishy repo
cd packages/client
npm link

# In consumer app
npm link @zippy/fishy-client
```

### 5.2 Monorepo workspace reference

Other fishy packages can use:

```json
{
  "dependencies": {
    "@zippy/fishy-client": "workspace:*"
  }
}
```

### 5.3 Update extension tests

Update `packages/extension/test/` to use the new client package:

```typescript
// Before (in ziptest)
import { FishyAppClient } from './fishy/FishyAppClient';

// After (from package)
import { FishyAppClient } from '@zippy/fishy-client';
```

---

## Phase 6: Documentation

### 6.1 README.md

```markdown
# @zippy/fishy-client

Drop-in replacement for `@holochain/client`'s AppClient that uses the
Fishy browser extension for zero-arc Holochain nodes.

## Installation

```bash
npm install @zippy/fishy-client
```

## Usage

```typescript
import { FishyAppClient, waitForFishy, ConnectionStatus } from '@zippy/fishy-client';

// Wait for extension to be ready
await waitForFishy();

// Connect to gateway
const client = await FishyAppClient.connect({
  gatewayUrl: 'http://localhost:8090',
  autoReconnect: true,
});

// Monitor connection status
client.onConnection('connection:change', (state) => {
  if (state.status === ConnectionStatus.Error) {
    showReconnectingBanner();
  } else if (state.status === ConnectionStatus.Connected) {
    hideReconnectingBanner();
  }
});

// Use like regular AppClient
const result = await client.callZome({
  role_name: 'my_role',
  zome_name: 'my_zome',
  fn_name: 'my_function',
  payload: { ... },
});
```

## Switching between Fishy and standard Holochain

```typescript
import { FishyAppClient, waitForFishy } from '@zippy/fishy-client';
import { AppWebsocket } from '@holochain/client';

async function getClient(): Promise<AppClient> {
  // Check if Fishy extension is available
  if (window.holochain?.isFishy) {
    await waitForFishy();
    return FishyAppClient.connect('http://localhost:8090');
  } else {
    // Fall back to standard Holochain conductor
    return AppWebsocket.connect('ws://localhost:8888');
  }
}
```
```

---

## Files to Create

| File | Lines (est.) | Description |
|------|--------------|-------------|
| `packages/client/package.json` | 45 | Package manifest |
| `packages/client/tsconfig.json` | 20 | TypeScript config |
| `packages/client/vite.config.ts` | 25 | Build config |
| `packages/client/src/index.ts` | 30 | Main exports |
| `packages/client/src/FishyAppClient.ts` | 450 | Enhanced client |
| `packages/client/src/connection/types.ts` | 50 | Connection types |
| `packages/client/src/connection/monitor.ts` | 150 | Health monitoring |
| `packages/client/src/connection/reconnect.ts` | 80 | Reconnection logic |
| `packages/client/src/connection/index.ts` | 10 | Connection exports |
| `packages/client/src/utils/byte-arrays.ts` | 100 | Uint8Array helpers |
| `packages/client/src/utils/wait-for-fishy.ts` | 30 | Extension detection |
| `packages/client/README.md` | 150 | Documentation |

**Total**: ~1,140 lines

## Files to Modify

| File | Changes |
|------|---------|
| `package.json` (root) | Add `packages/client` to workspaces |
| `packages/extension/src/inject/index.ts` | Add connection status API |
| `packages/extension/src/background/index.ts` | Add connection status handlers |
| `packages/extension/src/lib/messaging.ts` | Add connection message types |

---

## Success Criteria

- [ ] Package builds with `npm run build`
- [ ] TypeScript declarations generated correctly
- [ ] Can be used via `npm link` in ziptest
- [ ] Drop-in replacement works (existing ziptest code unchanged except imports)
- [ ] Connection status events fire correctly
- [ ] Reconnection works when gateway restarts
- [ ] Package publishable to npm (prepublishOnly script works)

---

## Future Enhancements (Out of Scope)

- React hooks package (`@zippy/fishy-react`)
- Svelte stores package (`@zippy/fishy-svelte`)
- Vue composables package (`@zippy/fishy-vue`)
- CLI for hApp developers

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Package setup & migration | 2-3 hours |
| Phase 2: Connection types & interfaces | 2-3 hours |
| Phase 3: Enhanced FishyAppClient | 3-4 hours |
| Phase 4: Extension API enhancements | 2-3 hours |
| Phase 5: Local dev workflow | 1-2 hours |
| Phase 6: Documentation | 1-2 hours |

**Total**: ~12-17 hours

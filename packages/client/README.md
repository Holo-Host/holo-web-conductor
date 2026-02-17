# @holo-host/web-conductor-client

Drop-in replacement for `@holochain/client`'s AppClient that uses the
Holo Web Conductor browser extension for zero-arc Holochain nodes.

## Installation

```bash
npm install @holo-host/web-conductor-client
```

## Usage

```typescript
import { WebConductorAppClient, waitForHolochain, ConnectionStatus } from '@holo-host/web-conductor-client';

// Wait for extension to be ready
await waitForHolochain();

// Connect to linker
const client = await WebConductorAppClient.connect({
  linkerUrl: 'http://localhost:8090',
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

## Switching between Holo Web Conductor and standard Holochain

```typescript
import { WebConductorAppClient, waitForHolochain, isWebConductorAvailable } from '@holo-host/web-conductor-client';
import { AppWebsocket } from '@holochain/client';
import type { AppClient } from '@holochain/client';

async function getClient(): Promise<AppClient> {
  // Check if Holo Web Conductor extension is available
  if (isWebConductorAvailable()) {
    await waitForHolochain();
    return WebConductorAppClient.connect('http://localhost:8090');
  } else {
    // Fall back to standard Holochain conductor
    return AppWebsocket.connect('ws://localhost:8888');
  }
}
```

## Connection Configuration

```typescript
const client = await WebConductorAppClient.connect({
  // Required: Linker URL
  linkerUrl: 'http://localhost:8090',

  // Optional: Auto-reconnect on disconnect (default: true)
  autoReconnect: true,

  // Optional: Initial reconnect delay in ms (default: 1000)
  reconnectDelayMs: 1000,

  // Optional: Maximum reconnect delay in ms (default: 30000)
  maxReconnectDelayMs: 30000,

  // Optional: Health check interval in ms (default: 10000)
  healthCheckIntervalMs: 10000,

  // Optional: Role name for the hApp (default: inferred from hApp)
  roleName: 'my_role',

  // Optional: Path to hApp bundle for auto-install
  happBundlePath: './my-app.happ',
});
```

## Connection Events

```typescript
// Listen for any status change
client.onConnection('connection:change', (state) => {
  console.log('Status:', state.status);
  console.log('HTTP healthy:', state.httpHealthy);
  console.log('WebSocket healthy:', state.wsHealthy);
});

// Listen for errors
client.onConnection('connection:error', ({ error, recoverable }) => {
  console.error('Connection error:', error);
  if (recoverable) {
    console.log('Will attempt to reconnect...');
  }
});

// Listen for reconnection attempts
client.onConnection('connection:reconnecting', ({ attempt, delayMs }) => {
  console.log(`Reconnection attempt ${attempt} in ${delayMs}ms`);
});

// Listen for successful reconnection
client.onConnection('connection:reconnected', () => {
  console.log('Reconnected successfully!');
});
```

## Connection Status Enum

```typescript
import { ConnectionStatus } from '@holo-host/web-conductor-client';

// Available statuses:
ConnectionStatus.Disconnected  // Not connected to linker
ConnectionStatus.Connecting    // Initial connection in progress
ConnectionStatus.Connected     // Successfully connected
ConnectionStatus.Reconnecting  // Lost connection, attempting to reconnect
ConnectionStatus.Error         // Connection error
```

## Manual Reconnection

```typescript
// Manually trigger reconnection
await client.reconnect();

// Get current connection state
const state = client.getConnectionState();
console.log(state.status, state.lastError);
```

## Signals

```typescript
// Subscribe to signals (same API as @holochain/client)
const unsubscribe = client.on('signal', (signal) => {
  console.log('Received signal:', signal);
});

// Unsubscribe when done
unsubscribe();
```

## API Compatibility

WebConductorAppClient implements the full `AppClient` interface from `@holochain/client` :

- ✅ `callZome()` - Call zome functions
- ✅ `appInfo()` - Get app information
- ✅ `on('signal', callback)` - Signal subscription
- ✅ `myPubKey` / `installedAppId` getters
- ❌ `createCloneCell()` - Not supported (throws error)
- ❌ `enableCloneCell()` - Not supported (throws error)
- ❌ `disableCloneCell()` - Not supported (throws error)
- ⚠️ `dumpNetworkStats()` - Returns empty result
- ⚠️ `dumpNetworkMetrics()` - Returns empty result

## Byte Array Utilities

Chrome messaging converts `Uint8Array` to plain objects with numeric keys. The package provides utilities to handle this:

```typescript
import {
  toUint8Array,
  deepConvertByteArrays,
  looksLikeByteArray
} from '@holo-host/web-conductor-client';

// Convert a single value back to Uint8Array
const bytes = toUint8Array({ 0: 132, 1: 32, 2: 36 });

// Deep convert nested structures (automatically handles response objects)
const result = deepConvertByteArrays({
  hash: { 0: 132, 1: 41, 2: 36, /* ... */ },
  nested: { data: [1, 2, 3] }
});

// Check if a value looks like a byte array
looksLikeByteArray({ 0: 1, 1: 2, 2: 3 }); // true
looksLikeByteArray([1, 2, 3]); // true (if all values 0-255)
```

Note: `callZome()` automatically converts response byte arrays, so you typically don't need these utilities directly.

## Requirements

- Holo Web Conductor browser extension installed
- h2hc-linker running
- hApp bundle available at configured path

## License

MIT

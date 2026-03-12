# Building Apps with Holo Web Conductor

This guide is for Holochain application developers who want their hApps to run in the browser via the HWC extension, without requiring users to install a local Holochain conductor.

For the high-level vision and trust model, see [HOLOCHAIN_FOR_THE_WEB.md](./HOLOCHAIN_FOR_THE_WEB.md).

---

## How It Works

```
Your Web App ──► @holo-host/web-conductor-client ──► HWC Browser Extension ──► Linker ──► Holochain Network
```

- **Your web app** uses `@holo-host/web-conductor-client` instead of connecting to a local WebSocket conductor. The client library implements the `AppClient` interface from `@holochain/client`, so zome calls, signals, and app info work the same way.
- **The HWC browser extension** runs your hApp's WASM in the browser, stores keys in IndexedDB, and communicates with the network through a linker relay.
- **The linker** (h2hc-linker) bridges between the browser extension and the Holochain network. It relays zome calls, publishes DHT operations, and forwards signals.
- **The joining service** (optional) handles agent onboarding — verifying identity, issuing membrane proofs, and providing linker URLs.

---

## Quick Start

### 1. Install the client library

```bash
npm install @holo-host/web-conductor-client
```

> **Not yet published to npm?** See [Local Development Setup](#local-development-setup-before-npm-publish) below for how to use `file:` dependencies during the pre-publish period.

### 2. Detect the extension and connect

```typescript
import {
  WebConductorAppClient,
  waitForHolochain,
} from '@holo-host/web-conductor-client';
import { AppWebsocket } from '@holochain/client';

let client;

// Check for HWC extension
try {
  await waitForHolochain(3000); // Wait up to 3 seconds

  client = await WebConductorAppClient.connect({
    linkerUrl: 'wss://linker.example.com:8090',
    roleName: 'my_role',
  });
} catch {
  // Extension not available — fall back to standard Holochain
  client = await AppWebsocket.connect({ defaultTimeout: 60000 });
}

// From here, use client the same way regardless of backend
const result = await client.callZome({
  role_name: 'my_role',
  zome_name: 'my_zome',
  fn_name: 'get_posts',
  payload: null,
});
```

### 3. Add joining service (optional)

If you want agent onboarding with identity verification:

```typescript
client = await WebConductorAppClient.connect({
  linkerUrl: 'wss://linker.example.com:8090',
  roleName: 'my_role',
  joiningServiceUrl: 'https://joining.example.com',
  claims: { email: userEmail },
  onChallenge: async (challenge) => {
    // Show UI for user to enter verification code
    return await promptUser(`Enter the code sent to your email`);
  },
});
```

### 4. Build-time configuration

Inject URLs at build time so the same code works across environments:

```typescript
// vite.config.ts
export default defineConfig({
  define: {
    __LINKER_URL__: JSON.stringify(process.env.LINKER_URL || 'http://localhost:8000'),
    __JOINING_SERVICE_URL__: JSON.stringify(process.env.JOINING_SERVICE_URL || ''),
  },
});
```

```typescript
// client.ts
declare const __LINKER_URL__: string;
declare const __JOINING_SERVICE_URL__: string;

const LINKER_URL = typeof __LINKER_URL__ !== 'undefined' ? __LINKER_URL__ : 'http://localhost:8000';
const JOINING_SERVICE_URL = typeof __JOINING_SERVICE_URL__ !== 'undefined' ? __JOINING_SERVICE_URL__ : '';
```

---

## Authentication Use Cases

The joining service supports multiple auth methods. Choose based on your network's trust requirements.

### Open (no auth)

Anyone can join immediately. Good for public test networks.

```typescript
// Joining service config
{ auth_methods: ['open'] }

// Client — no claims or onChallenge needed
await WebConductorAppClient.connect({
  joiningServiceUrl: 'https://joining.example.com',
  roleName: 'my_role',
});
```

### Invite Code

Pre-issued codes for beta programs or limited rollouts.

```typescript
// Joining service config
{ auth_methods: ['invite_code'] }

// Client
await WebConductorAppClient.connect({
  joiningServiceUrl: 'https://joining.example.com',
  roleName: 'my_role',
  claims: { invite_code: userProvidedCode },
});
```

### Email Verification

User receives a 6-digit code via email.

```typescript
// Joining service config
{
  auth_methods: ['email_code'],
  email: { transport: 'postmark', api_key: '...', from: 'noreply@example.com' }
}

// Client
await WebConductorAppClient.connect({
  joiningServiceUrl: 'https://joining.example.com',
  roleName: 'my_role',
  claims: { email: 'user@example.com' },
  onChallenge: async (challenge) => {
    // Show a text input for the verification code
    return await showVerificationDialog(challenge.description);
  },
});
```

### Agent Whitelist

Only pre-approved agent keys can join. The extension auto-signs the nonce — no UI needed.

```typescript
// Joining service config
{
  auth_methods: ['agent_whitelist'],
  agent_whitelist: ['uhCAk...base64key1', 'uhCAk...base64key2']
}

// Client — no claims or onChallenge needed (extension signs automatically)
await WebConductorAppClient.connect({
  joiningServiceUrl: 'https://joining.example.com',
  roleName: 'my_role',
});
```

### Wallet-Gated (EVM or Solana)

Require a crypto wallet signature to join.

```typescript
// Joining service config
{ auth_methods: ['evm_signature'] }

// Client
await WebConductorAppClient.connect({
  joiningServiceUrl: 'https://joining.example.com',
  roleName: 'my_role',
  claims: { evm_address: walletAddress },
  onChallenge: async (challenge) => {
    // Sign the message with the user's EVM wallet
    const signature = await wallet.signMessage(challenge.metadata.message);
    return signature; // hex string 0x...
  },
});
```

### Multi-Factor (AND groups)

Require multiple methods in sequence:

```typescript
// Joining service config — user must provide invite code AND verify email
{ auth_methods: ['invite_code', 'email_code'] }
```

### OR Groups

Accept any one of several methods:

```typescript
// Joining service config — agent whitelist OR email verification
{ auth_methods: [{ any_of: ['agent_whitelist', 'email_code'] }] }
```

The client handles OR group routing automatically — it tries `agent_whitelist` first (auto-signed), and falls back to `email_code` (via `onChallenge`) if the agent isn't whitelisted.

### Auth Method Reference

| Method | Claims Required | Challenge Handling | Notes |
|--------|----------------|--------------------|-------|
| `open` | none | Automatic | Instant join |
| `invite_code` | `invite_code` | Automatic | Pre-issued codes |
| `email_code` | `email` | `onChallenge` → 6-digit code | Needs email provider |
| `sms_code` | `phone` | `onChallenge` → 6-digit code | Needs SMS provider |
| `evm_signature` | `evm_address` | `onChallenge` → hex signature | User signs with wallet |
| `solana_signature` | `solana_address` | `onChallenge` → base58 signature | User signs with wallet |
| `agent_whitelist` | none | Automatic (extension signs nonce) | Pre-approved keys |

---

## Zero-Arc Behavior

HWC nodes are zero-arc — they don't gossip or hold DHT data locally. All data is fetched from the network via the linker.

**What this means for your app:**

- **Get strategy override**: HWC ignores `GetStrategy::Local` and always fetches from network. Your standard zome calls work without changes.
- **UX implications**: Every read requires a network round-trip. Plan for loading states. There's no offline read capability.

---

## Connection Management

The client monitors the linker connection and supports automatic reconnection.

### Listening to connection status

```typescript
const client = await WebConductorAppClient.connect({ ... });

client.onConnection('connection:change', (state) => {
  switch (state.status) {
    case 'connected':
      hideConnectionBanner();
      break;
    case 'reconnecting':
      showBanner(`Reconnecting (attempt ${state.reconnectAttempt})...`);
      break;
    case 'error':
      showBanner(`Connection error: ${state.lastError}`);
      break;
  }
});
```

### Connection state

```typescript
const state = client.getConnectionState();
// {
//   status: 'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error',
//   httpHealthy: boolean,
//   wsHealthy: boolean,
//   lastError?: string,
//   reconnectAttempt?: number,
//   nextReconnectMs?: number,
// }
```

### Connection events

| Event | Payload | When |
|-------|---------|------|
| `connection:change` | `ConnectionState` | Any status change |
| `connection:error` | `{ error, recoverable }` | Connection error occurs |
| `connection:reconnecting` | `{ attempt, delayMs }` | Starting a reconnect attempt |
| `connection:reconnected` | `void` | Successfully reconnected |

### Configuration

```typescript
await WebConductorAppClient.connect({
  autoReconnect: true,       // default: true
  reconnectDelayMs: 1000,    // initial delay, default: 1000
  maxReconnectDelayMs: 30000, // max backoff, default: 30000
  healthCheckIntervalMs: 10000, // health poll interval, default: 10000
});
```

---

## Reconnect Flow

When a user returns to your app after the linker URL has expired, the client handles reconnection automatically if a joining service is configured:

1. Extension detects the hApp is already installed
2. Client calls the joining service's reconnect endpoint
3. Extension signs a timestamp to prove agent identity
4. Joining service returns fresh linker URLs
5. Client reconfigures the network connection

No code changes needed — this is handled by `WebConductorAppClient.connect()`.

---

## Auto-Discovery

Instead of hardcoding URLs, you can serve a `.well-known/holo-joining` file from your domain:

```json
// https://myapp.example.com/.well-known/holo-joining
{
  "joining_service_url": "https://joining.example.com"
}
```

Then connect with auto-discovery:

```typescript
await WebConductorAppClient.connect({
  autoDiscover: true,
  roleName: 'my_role',
  onChallenge: handleChallenge,
});
```

The client fetches `/.well-known/holo-joining` from the current domain and uses the joining service URL it finds.

---

## API Reference

### `WebConductorAppClient.connect(options)`

Static factory that creates and connects a client.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `linkerUrl` | `string` | — | Linker relay URL (optional when using joining service) |
| `roleName` | `string` | `'default'` | Role name for zome calls |
| `joiningServiceUrl` | `string` | — | Joining service base URL |
| `autoDiscover` | `boolean` | `false` | Discover joining service from `.well-known` |
| `claims` | `Record<string, string>` | — | Identity claims for joining (email, invite_code, etc.) |
| `onChallenge` | `(challenge) => Promise<string>` | — | UI callback for verification challenges |
| `happBundlePath` | `string` | — | URL to fetch hApp bundle from |
| `membraneProofs` | `Record<string, Uint8Array>` | — | Pre-obtained membrane proofs (bypasses joining service) |
| `autoReconnect` | `boolean` | `true` | Auto-reconnect on connection loss |
| `reconnectDelayMs` | `number` | `1000` | Initial reconnect delay |
| `maxReconnectDelayMs` | `number` | `30000` | Max reconnect backoff |
| `healthCheckIntervalMs` | `number` | `10000` | Health check interval |

### Methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `callZome` | `(args: CallZomeRequest \| RoleNameCallZomeRequest) => Promise<unknown>` | Same as `@holochain/client` |
| `appInfo` | `() => Promise<AppInfo \| null>` | Returns standard `AppInfo` |
| `on` | `('signal', callback: SignalCb) => () => void` | Subscribe to signals |
| `myPubKey` | `AgentPubKey` (getter) | Current agent's public key |
| `installedAppId` | `string` (getter) | Installed app ID |
| `cachedAppInfo` | `AppInfo \| null` | Cached app info for ZomeClient |
| `disconnect` | `() => Promise<void>` | Disconnect and stop monitoring |
| `onConnection` | `(event, callback) => () => void` | Subscribe to connection events |
| `getConnectionState` | `() => ConnectionState` | Current connection state |
| `reconnect` | `() => Promise<void>` | Manually trigger reconnect |
| `provideMemproofs` | `(memproofs, contextId?) => Promise<void>` | Provide membrane proofs post-install |

### Not Supported

These methods throw or return empty data:

- `createCloneCell()` — throws
- `enableCloneCell()` — throws
- `disableCloneCell()` — throws
- `dumpNetworkStats()` — returns empty
- `dumpNetworkMetrics()` — returns empty

---

## hApp Bundle Hosting

The client needs to fetch your `.happ` bundle to install it. It tries these locations in order:

1. URL from joining service provision (`happ_bundle_url`)
2. `happBundlePath` from connect options
3. `./app.happ`, `./{roleName}.happ`, `./bundle.happ` relative to the page

For production, configure `happ_bundle_url` in your joining service. For dev, place the bundle alongside your UI files.

---

## Signals

Signal handling works the same as with `@holochain/client`:

```typescript
const unsubscribe = client.on('signal', (signal) => {
  if (signal.type === SignalType.App) {
    console.log('Signal from zome:', signal.value.zome_name);
    console.log('Payload:', signal.value.payload);
  }
});

// Later: unsubscribe()
```

Signals are forwarded from the extension in real-time via the linker's WebSocket connection.

---

## Local Development Setup (Before npm Publish)

The `@holo-host/web-conductor-client` and `@holo-host/joining-service` packages are not yet published to npm. During this interim period, your hApp uses npm `file:` dependencies that point to local checkouts of these repos.

### Directory layout

All repos must be siblings in the same parent directory:

```
parent/
├── holo-web-conductor/       # This repo (contains client + lair packages)
├── joining-service/          # Optional — only if your app uses joining flows
├── h2hc-linker/              # Optional — needed to run local HWC infrastructure
└── your-happ/                # Your application
```

### 1. Clone the repos

```bash
cd ~/code   # or wherever your projects live

# Required
git clone https://github.com/holo-host/holo-web-conductor.git

# Optional (for joining flows)
git clone https://github.com/holo-host/joining-service.git

# Optional (for local linker — or use a prebuilt binary)
git clone https://github.com/holo-host/h2hc-linker.git
```

### 2. Run the setup script

```bash
cd holo-web-conductor
nix develop -c ./scripts/holo-dev-setup.sh
```

This verifies the directory layout, checks that `file:` dependencies resolve, runs `npm install`, and builds the packages your hApp depends on.

Options:
- `--check` — verify only, don't build
- `--clone` — clone missing repos automatically, then build
- `--download-linker` — download a prebuilt h2hc-linker binary instead of building from source

### 3. Add file: dependencies to your hApp

In your hApp's UI `package.json`:

```json
{
  "dependencies": {
    "@holo-host/web-conductor-client": "file:../../holo-web-conductor/packages/client",
    "@holo-host/joining-service": "file:../../joining-service"
  }
}
```

Adjust the relative paths if your directory layout differs. Then run `npm install` in your hApp.

### 4. Develop normally

The `file:` references are symlinks — changes to the client or joining-service source are picked up immediately after a rebuild of the dependency:

```bash
# After changing web-conductor-client source:
cd ../holo-web-conductor && nix develop -c npm run build --workspace=packages/client

# After changing joining-service source:
cd ../joining-service && npm run build
```

Your hApp's dev server (Vite, etc.) will see the updated files.

### 5. Run local HWC infrastructure

Most hApps use mewsfeed's `deploy/local-dev.sh` pattern (or a copy of it) to start conductors, bootstrap, linker, and optionally the joining service. See the [mewsfeed README](https://github.com/holo-host/mewsfeed#local-hwc-development) for the full pattern.

### When these packages are published

Once published to npm, replace the `file:` references with version ranges:

```json
{
  "dependencies": {
    "@holo-host/web-conductor-client": "^0.1.0",
    "@holo-host/joining-service": "^0.1.0"
  }
}
```

To continue local development after publishing, use `npm link` to override the npm version with your local checkout:

```bash
# In holo-web-conductor:
cd packages/client && npm link

# In your hApp:
cd your-happ/ui && npm link @holo-host/web-conductor-client
```

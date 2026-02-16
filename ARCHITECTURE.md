# Fishy Architecture

A browser extension implementation of the Holochain conductor, enabling hApps to run in the browser with the extension handling host-side operations (signing, storage, network).

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                         │
│                                                                              │
│  ┌──────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐ │
│  │  WEB PAGE    │    │ CONTENT SCRIPT  │    │    BACKGROUND SERVICE       │ │
│  │              │    │                 │    │         WORKER              │ │
│  │ window.      │◄──►│ Bridge between  │◄──►│                             │ │
│  │ holochain.   │    │ page & extension│    │ - Message routing           │ │
│  │ callZome()   │    │                 │    │ - Lair keystore (IndexedDB) │ │
│  │              │    │ postMessage ↔   │    │ - hApp context management   │ │
│  │ (hApp JS)    │    │ chrome.runtime  │    │ - Authorization flow        │ │
│  └──────────────┘    └─────────────────┘    └──────────┬──────────────────┘ │
│                                                        │                     │
│                                                        │ chrome.runtime      │
│                                                        ▼                     │
│                      ┌─────────────────────────────────────────────────────┐ │
│                      │              OFFSCREEN DOCUMENT                      │ │
│                      │                                                      │ │
│                      │  - Spawns Ribosome Worker                           │ │
│                      │  - Sync XHR proxy (XMLHttpRequest)                  │ │
│                      │  - WebSocket connection to gateway                  │ │
│                      │  - Sign request relay to background                 │ │
│                      │                                                      │ │
│                      └──────────────────────┬──────────────────────────────┘ │
│                                             │                                │
│                                             │ postMessage + SharedArrayBuffer│
│                                             ▼                                │
│                      ┌─────────────────────────────────────────────────────┐ │
│                      │              RIBOSOME WORKER                         │ │
│                      │                                                      │ │
│                      │  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │ │
│                      │  │ WASM Engine │  │ SQLite WASM  │  │   Proxy    │  │ │
│                      │  │             │  │   (OPFS)     │  │  Services  │  │ │
│                      │  │ Host funcs: │  │              │  │            │  │ │
│                      │  │ - create    │  │ Source chain │  │ - Network  │  │ │
│                      │  │ - get       │◄─┤ Actions      │  │ - Lair     │  │ │
│                      │  │ - get_links │  │ Entries      │  │            │  │ │
│                      │  │ - sign      │  │ Links        │  │ Atomics.   │  │ │
│                      │  │ - etc.      │  │              │  │ wait()     │  │ │
│                      │  └─────────────┘  └──────────────┘  └────────────┘  │ │
│                      └─────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┬─┘
                                                                             │
                          HTTP (sync XHR)                    WebSocket       │
                              │                                  │           │
                              ▼                                  ▼           │
┌─────────────────────────────────────────────────────────────────────────────┐
│                        hc-membrane (Gateway)                                │
│                                                                             │
│  ┌──────────────────────┐  ┌───────────────────┐  ┌─────────────────────┐  │
│  │     HTTP Routes      │  │     WebSocket     │  │   AgentProxyManager │  │
│  │                      │  │      Handler      │  │                     │  │
│  │ GET /dht/{dna}/      │  │                   │  │ - Track browser     │  │
│  │     record/{hash}    │  │ - Auth messages   │  │   agents per DNA    │  │
│  │ GET /dht/{dna}/      │  │ - Register agent  │  │ - Route signals to  │  │
│  │     links?base=...   │  │ - Remote signals  │  │   WebSocket         │  │
│  │ POST /dht/{dna}/     │  │ - Sign requests   │  │ - Manage sign req/  │  │
│  │      publish         │  │                   │  │   response flow     │  │
│  └──────────┬───────────┘  └─────────┬─────────┘  └──────────┬──────────┘  │
│             │                        │                       │             │
│             │                        └───────────┬───────────┘             │
│             │                                    │                         │
│             ▼                                    ▼                         │
│  ┌──────────────────────┐           ┌────────────────────────────────────┐ │
│  │   TempOpStore        │           │         GatewayKitsune             │ │
│  │                      │           │                                    │ │
│  │ - Hold browser ops   │           │ ┌────────────────┐ ┌────────────┐ │ │
│  │   during publish     │           │ │ KitsuneProxy   │ │ ProxyAgent │ │ │
│  │ - 60s TTL per op     │           │ │                │ │            │ │ │
│  │ - Serve to peers     │◄──────────┤ │ Implements     │ │ Represents │ │ │
│  │   on fetch           │           │ │ KitsuneHandler │ │ browser    │ │ │
│  │                      │           │ │ for spaces     │ │ in network │ │ │
│  └──────────────────────┘           │ └────────────────┘ └────────────┘ │ │
│                                     └─────────────┬──────────────────────┘ │
└───────────────────────────────────────────────────┬─────────────────────────┘
                                                    │
                                                    │ kitsune2 protocol
                                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HOLOCHAIN NETWORK                                    │
│                                                                              │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                     │
│   │ Conductor 1 │    │ Conductor 2 │    │ Conductor N │                     │
│   │             │    │             │    │             │                     │
│   │ DHT Storage │    │ DHT Storage │    │ DHT Storage │                     │
│   │ Full Arc    │    │ Full Arc    │    │ Full Arc    │                     │
│   └─────────────┘    └─────────────┘    └─────────────┘                     │
│                                                                              │
│   (Browser agents are zero-arc: they store nothing, fetch everything)       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Why This Architecture?

### The Core Problem

**WASM host functions must be synchronous.**

When Holochain WASM calls a host function like `get_entry(hash)`, it expects an immediate return value. It cannot `await` a Promise. This is fundamental to how WASM interacts with host environments.

```rust
// In WASM (Holochain HDK)
let entry = get(entry_hash)?;  // Must return immediately, no async
```

### Browser Limitations

| Context | Sync XHR | SharedArrayBuffer | WASM | IndexedDB | Why Problematic |
|---------|----------|-------------------|------|-----------|-----------------|
| Service Worker | No | Limited | Heavy | Yes | No sync network calls |
| Web Worker | No | Yes | Yes | Yes | No sync network calls |
| Offscreen Document | Yes | Yes | Yes | Yes | Has DOM (XMLHttpRequest) |
| Content Script | No | No | No | No | Isolated world, limited APIs |

### The Solution: Distributed Responsibilities

```
┌─────────────────────────────────────────────────────────────────┐
│ RIBOSOME WORKER                                                  │
│                                                                  │
│  WASM runs here with SYNCHRONOUS host functions:                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ get_entry(hash)                                              ││
│  │   │                                                          ││
│  │   ├─► SQLite query (sync, in-worker)     ──► Found? Return   ││
│  │   │                                                          ││
│  │   └─► Network fetch needed?                                  ││
│  │         │                                                    ││
│  │         ├─ Post message to offscreen                         ││
│  │         ├─ Atomics.wait(signalBuffer) ◄── BLOCKS HERE        ││
│  │         │                                                    ││
│  │         └─ Read result from SharedArrayBuffer                ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ OFFSCREEN DOCUMENT                                               │
│                                                                  │
│  Receives network request via postMessage                       │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ const xhr = new XMLHttpRequest();                            ││
│  │ xhr.open('GET', gatewayUrl, false);  // false = synchronous  ││
│  │ xhr.send();                                                  ││
│  │                                                              ││
│  │ // Write result to SharedArrayBuffer                         ││
│  │ resultBuffer.set(xhr.responseText);                          ││
│  │ Atomics.store(signalBuffer, 0, 1);  // Signal completion     ││
│  │ Atomics.notify(signalBuffer, 0);    // Wake worker           ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## Browser Components

### 1. Background Service Worker

**File**: `packages/extension/src/background/index.ts`

**Purpose**: Central coordinator and persistent state

**Responsibilities**:
- Message routing (handles ~20 message types)
- Lair keystore operations (key generation, signing)
- hApp context management (install, enable, disable)
- Authorization flow (popup approval)
- Network configuration
- Delegates WASM execution through `ZomeExecutor` interface

**Why It Exists**:
- Only context that survives tab navigation
- Required by Chrome Extension Manifest V3
- Has access to all chrome.* APIs

**Sync Model**: Async only (Promises)

#### ZomeExecutor Interface

The background service worker uses a `ZomeExecutor` interface (`packages/extension/src/lib/zome-executor.ts`) to abstract over the WASM execution environment. This decouples the background from Chrome-specific offscreen document management.

```typescript
interface ZomeExecutor {
  initialize(): Promise<void>;
  isReady(): boolean;
  configureNetwork(config): Promise<void>;
  updateSessionToken(token): Promise<void>;
  registerAgent(dnaHashB64, agentPubKeyB64): Promise<void>;
  executeZomeCall(contextId, request): Promise<ZomeCallResult>;
  getAllRecords(dnaHash, agentPubKey): Promise<{ records: any[] }>;
  processPublishQueue(dnaHashes): Promise<void>;
  disconnectGateway(): Promise<void>;
  reconnectGateway(): Promise<void>;
  getWebSocketState(): Promise<WsStateInfo>;
  onRemoteSignal(callback): void;
  onSignRequest(callback): void;
  onWebSocketStateChange(callback): void;
}
```

**Chrome implementation**: `ChromeOffscreenExecutor` (`packages/extension/src/background/chrome-offscreen-executor.ts`) manages the offscreen document lifecycle and routes messages between background and offscreen via `chrome.runtime.sendMessage`.

**Firefox implementation**: Planned. Firefox MV3 event pages have DOM access, so the executor can spawn workers directly without an offscreen document.

---

### 2. Content Script

**File**: `packages/extension/src/content/index.ts`

**Purpose**: Bridge between untrusted page and trusted extension

**Responsibilities**:
- Listen for `window.postMessage` from page
- Forward to background via `chrome.runtime.sendMessage`
- Relay responses back to page
- Forward signals from background to page

**Why It Exists**:
- Content Security Policy (CSP) isolates page JavaScript
- Only injected scripts can access page's global scope
- Security boundary: validates messages before forwarding

**Sync Model**: Async (postMessage is inherently async)

---

### 3. Injected Script

**File**: `packages/extension/src/inject/index.ts`

**Purpose**: Provide `window.holochain` API to hApp code

**API Surface**:
```typescript
window.holochain = {
  callZome(request): Promise<any>,
  appInfo(): Promise<AppInfo>,
  installApp(bundle, networkConfig): Promise<AppInfo>,
  on(event, callback): unsubscribe,
  configureNetwork(config): Promise<void>
}
```

**Why It Exists**:
- hApp code expects `window.holochain` (holochain-client compatibility)
- Must run in page's global scope (not content script's isolated world)
- Handles Uint8Array ↔ Array conversion for Chrome messaging

**Sync Model**: Async (returns Promises)

---

### 4. Offscreen Document

**File**: `packages/extension/src/offscreen/index.ts`

**Purpose**: Provide sync primitives unavailable elsewhere

**Responsibilities**:
- Spawn and manage Ribosome Worker
- Execute synchronous XHR for network requests
- Maintain WebSocket connection to gateway
- Relay sign requests between worker and background
- Coordinate via SharedArrayBuffer + Atomics

**Why It Exists**:
- **Only DOM context available in extensions** with sync XMLHttpRequest
- Service workers deprecated sync XHR
- Web workers never had sync XHR
- Offscreen documents (Chrome 109+) have full DOM access

**Sync Model**: Mixed
- Async messaging from background
- Provides sync services to worker via Atomics

---

### 5. Ribosome Worker

**File**: `packages/extension/src/offscreen/ribosome-worker.ts`

**Purpose**: Execute WASM zome functions with all dependencies

**Components**:
```
┌─────────────────────────────────────────────────────────┐
│ Ribosome Worker                                          │
│                                                          │
│  ┌─────────────────┐  ┌─────────────────────────────┐   │
│  │  WASM Runtime   │  │  DirectSQLiteStorage        │   │
│  │                 │  │                             │   │
│  │  - callZome()   │  │  SQLite WASM + OPFS VFS    │   │
│  │  - Host funcs   │  │  Fully synchronous         │   │
│  └────────┬────────┘  └─────────────────────────────┘   │
│           │                                              │
│  ┌────────┴────────────────────────────────────────┐    │
│  │  Proxy Services (use Atomics.wait to block)     │    │
│  │                                                  │    │
│  │  ┌──────────────────┐  ┌────────────────────┐   │    │
│  │  │ ProxyNetworkSvc  │  │ ProxyLairClient    │   │    │
│  │  │                  │  │                    │   │    │
│  │  │ Blocks on buffer │  │ Blocks on buffer   │   │    │
│  │  │ while offscreen  │  │ while background   │   │    │
│  │  │ does sync XHR    │  │ signs async        │   │    │
│  │  └──────────────────┘  └────────────────────┘   │    │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Why It Exists**:
- WASM needs dedicated thread (CPU intensive)
- SQLite WASM runs directly in worker (sync access)
- Isolated from extension's main thread
- Can use Atomics.wait (blocks without burning CPU)

**Sync Model**: Fully synchronous internally
- Storage: Direct SQLite calls
- Network: Atomics.wait until offscreen completes XHR
- Signing: Atomics.wait until background completes

---

## Gateway Components

### HTTP Routes

**Base URL**: `http://localhost:8090` (configurable)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/auth/challenge` | POST | Get auth challenge |
| `/auth/verify` | POST | Verify auth token |
| `/dht/{dna}/record/{hash}` | GET | Fetch DHT record |
| `/dht/{dna}/details/{hash}` | GET | Fetch entry with action history |
| `/dht/{dna}/links?base=&type=&zome_index=` | GET | Get links (optional type/zome filter) |
| `/dht/{dna}/links/count?base=&type=` | GET | Count links |
| `/dht/{dna}/publish` | POST | Publish browser agent's DHT ops |
| `/ws` | GET | WebSocket upgrade |

---

### WebSocket Protocol

**Client → Gateway Messages**:
```typescript
{ type: "auth", session_token: string }
{ type: "register", dna_hash: string, agent_pubkey: string }
{ type: "unregister", dna_hash: string, agent_pubkey: string }
{ type: "ping" }
{ type: "sign_response", request_id: string, signature?: string, error?: string }
{ type: "send_remote_signal", dna_hash: string, signals: SignedRemoteSignalTransport[] }
```

**Gateway → Client Messages**:
```typescript
{ type: "auth_ok" }
{ type: "auth_error", message: string }
{ type: "registered", dna_hash: string, agent_pubkey: string }
{ type: "signal", dna_hash: string, from_agent: string, zome_name: string, signal: string }
{ type: "sign_request", request_id: string, agent_pubkey: string, message: string }
{ type: "pong" }
{ type: "error", message: string }
```

---

### Kitsune2 Integration

```
┌─────────────────────────────────────────────────────────┐
│ GatewayKitsune                                           │
│                                                          │
│  Manages browser agents' participation in kitsune2      │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ KitsuneProxy (implements KitsuneHandler)           │ │
│  │                                                     │ │
│  │ - Creates ProxySpaceHandler per DNA                │ │
│  │ - Handles recv_notify (RemoteSignalEvt)            │ │
│  │ - Forwards signals to AgentProxyManager            │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ ProxyAgent (per browser agent)                     │ │
│  │                                                     │ │
│  │ - Zero-arc (stores nothing)                        │ │
│  │ - Implements Signer (remote signing via WS)        │ │
│  │ - Joins/leaves kitsune2 space                      │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ TempOpStore                                         │ │
│  │                                                     │ │
│  │ - Holds ops during publish (60s TTL)               │ │
│  │ - Peers fetch ops after publish notification       │ │
│  │ - Automatic cleanup every 10s                      │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Encoding/Decoding Boundaries

### Summary Table

| Boundary | Format | Encode Function | Decode Function | Why This Format |
|----------|--------|-----------------|-----------------|-----------------|
| Page ↔ Content | JSON + type markers | `serializeMessage()` | `deserializeMessage()` | Chrome loses Uint8Array type |
| Content ↔ Background | Chrome structured clone | (automatic) | `normalizeUint8Arrays()` | Chrome converts to `{0:..., 1:...}` |
| Background ↔ Offscreen | Array format | `serializeForTransport()` | `new Uint8Array()` | Cleaner than object format |
| Offscreen ↔ Worker | SharedArrayBuffer | `Atomics.store()` | `Atomics.wait()` + read | Sync blocking required |
| Worker ↔ WASM | MessagePack | `@msgpack/msgpack encode()` | `decode()` | Holochain wire format |
| Extension ↔ Gateway HTTP | JSON + base64 | `encodeHashToBase64()` | `normalizeByteArraysFromJson()` | URL-safe hashes |
| Extension ↔ Gateway WS | JSON + base64 | `btoa()` | `atob()` | Binary over text |
| Worker ↔ SQLite | MessagePack blobs | `encode()` | `decode()` | Efficient binary |

---

### Chrome Message Passing Problem

**The Issue**: Chrome's structured cloning algorithm converts `Uint8Array` to plain objects:

```javascript
// Before postMessage
const data = new Uint8Array([1, 2, 3]);

// After receiving
// data = { 0: 1, 1: 2, 2: 3 }  // NOT a Uint8Array!
```

**Solution Layers**:

1. **Explicit Serialization** (Page ↔ Content):
```typescript
// In serializeMessage()
{
  __type: "Uint8Array",
  data: [1, 2, 3]
}
```

2. **Normalization** (Background receives):
```typescript
// normalizeUint8Arrays() handles Chrome's format
function normalizeUint8Arrays(obj) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if ('0' in obj) {
      return new Uint8Array(Object.values(obj));
    }
  }
  // ... recursive handling
}
```

---

### WASM Boundary (MessagePack)

**Input to WASM**:
```
TypeScript object
    │
    ▼ @msgpack/msgpack encode()
MessagePack bytes
    │
    ▼ Write to WASM memory
GuestPtr (ptr in high 32 bits, len in low 32 bits)
    │
    ▼ Call WASM function
```

**Output from WASM**:
```
WASM returns i64 (ptr|len)
    │
    ▼ Read from WASM memory
MessagePack bytes (Result<T, WasmError>)
    │
    ▼ @msgpack/msgpack decode()
{ Ok: value } or { Err: error }
    │
    ▼ Unwrap
TypeScript value
```

**Important**: Holochain's ribosome wraps all results in `Result<T, WasmError>`. Even though we implement host functions directly, we must maintain this wrapper.

---

### HTTP Gateway Encoding

**Hashes use Holochain base64 format** (`'u' + url_safe_base64`):

```typescript
// encodeHashToBase64() adds 'u' prefix
const encoded = 'u' + base64.encode(hashBytes).replace(/\+/g, '-').replace(/\//g, '_');
// Example: "uhCAkm2BfX1W3tL..."

// decodeHashFromBase64() removes prefix and decodes
const decoded = base64.decode(encoded.slice(1).replace(/-/g, '+').replace(/_/g, '/'));
```

**Request URL format**:
```
GET /dht/uhCAk.../record/uhCkk...
           │              │
           DNA hash       Action/Entry hash
```

**Response format** (JSON with number arrays):
```json
{
  "action": {
    "hash": [132, 41, 36, ...],
    "author": [134, 21, 50, ...]
  },
  "entry": [99, 111, 110, ...]
}
```

Converted by `normalizeByteArraysFromJson()` to proper Uint8Arrays.

---

### WebSocket Encoding

**Binary data encoded as base64 strings**:

```typescript
// Sending signal
{
  type: "send_remote_signal",
  dna_hash: "uhCAk...",  // Holochain base64 format
  signals: [{
    target_agent: [132, 21, 50, ...],      // Number array
    zome_call_params: [99, 111, ...],      // Number array
    signature: [1, 2, 3, ...(64 bytes)]    // Number array
  }]
}

// Receiving signal
{
  type: "signal",
  dna_hash: "uhCAk...",
  from_agent: "uhCAk...",
  signal: "c29tZSBtc2dwYWNrIGRhdGE="  // base64 msgpack
}
```

**URL-safe base64 handling** (sign requests use different alphabet):
```typescript
// Gateway sends URL-safe base64
const urlSafe = message.replace(/-/g, '+').replace(/_/g, '/');
const padded = urlSafe + '='.repeat((4 - urlSafe.length % 4) % 4);
const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
```

---

## Data Flow Diagrams

### Zome Call Flow

```
┌────────────┐
│ hApp Page  │  window.holochain.callZome({ cell_id, zome, fn, payload })
└─────┬──────┘
      │ postMessage (payload serialized)
      ▼
┌─────────────────┐
│ Content Script  │  chrome.runtime.sendMessage()
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Background Service Worker                                        │
│                                                                  │
│ handleCallZome():                                                │
│   1. normalizeUint8Arrays(payload)                               │
│   2. Look up hApp context (get WASM, DNA hash)                  │
│   3. Prepare request { cellId, zomeName, fnName, payload }      │
│   4. executor.executeZomeCall(contextId, request)                │
│                                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ChromeOffscreenExecutor (implements ZomeExecutor)            │ │
│ │   - Converts Uint8Array → number[] for Chrome messaging     │ │
│ │   - chrome.runtime.sendMessage → offscreen                   │ │
│ └──────────────────────────────────┬──────────────────────────┘ │
└────────────────────────────────────┬────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Offscreen Document                                               │
│                                                                  │
│ handleZomeCall():                                                │
│   1. Check WASM cache (IndexedDB or in-memory)                  │
│   2. If not cached, request from background                      │
│   3. Post to ribosome worker with SharedArrayBuffer refs         │
└────────────────────────────────────┬────────────────────────────┘
                                     │ postMessage
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Ribosome Worker                                                  │
│                                                                  │
│ onmessage(CALL_ZOME):                                           │
│   1. Get/compile WASM module                                     │
│   2. Create runtime with storage, network, lair proxies         │
│   3. callZome(cellId, zomeName, fnName, payload)                │
│                                                                  │
│   Inside callZome:                                               │
│     a. Encode payload as MessagePack                             │
│     b. Allocate WASM memory, write payload                       │
│     c. Call zome function                                        │
│     d. Host functions execute (sync via Atomics)                 │
│     e. Read result from WASM memory                              │
│     f. Decode MessagePack, unwrap Result                         │
│                                                                  │
│   4. Return { result, pendingRecords, remoteSignals }           │
└────────────────────────────────────┬────────────────────────────┘
                                     │ postMessage
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Offscreen Document                                               │
│                                                                  │
│   1. Decode result                                               │
│   2. If pendingRecords: call publishService.publishRecord()     │
│   3. If remoteSignals: send via WebSocket                        │
│   4. Return result to background                                 │
└────────────────────────────────────┬────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Background → Content Script → Page                               │
│                                                                  │
│ Result decoded, Promise resolves in hApp code                   │
└─────────────────────────────────────────────────────────────────┘
```

---

### Signal Flow (Holochain → Browser)

```
┌────────────────────────────────────────┐
│ Holochain Conductor                     │
│                                         │
│ Agent calls send_remote_signal()        │
│   │                                     │
│   ▼                                     │
│ kitsune2 sends RemoteSignalEvt          │
└──────────────────┬─────────────────────┘
                   │ kitsune2 protocol
                   ▼
┌────────────────────────────────────────────────────────────────┐
│ hc-membrane                                                      │
│                                                                 │
│ ProxySpaceHandler.recv_notify():                               │
│   1. Decode WireMessage batch                                   │
│   2. Extract RemoteSignalEvt { to_agent, zome_call_params }    │
│   3. Look up WebSocket for target agent                         │
│   4. Create ServerMessage::Signal { dna, from_agent, signal }  │
│   5. Send via WebSocket                                         │
└─────────────────────────────┬──────────────────────────────────┘
                              │ WebSocket JSON
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Offscreen Document                                              │
│                                                                 │
│ WebSocket onmessage:                                           │
│   1. Parse JSON message                                         │
│   2. Decode base64 signal payload                               │
│   3. chrome.runtime.sendMessage({ type: SIGNAL, ... })         │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Background Service Worker                                       │
│                                                                 │
│ handleSignal():                                                 │
│   1. Find tab(s) with matching DNA                              │
│   2. chrome.tabs.sendMessage(tabId, signalData)                │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Content Script                                                  │
│                                                                 │
│ onMessage:                                                      │
│   window.postMessage({ type: 'SIGNAL', ... })                  │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Injected Script (Page)                                          │
│                                                                 │
│ window.onmessage:                                              │
│   signalHandlers.forEach(handler => handler(signal))           │
└────────────────────────────────────────────────────────────────┘
```

---

### Publish Flow

```
┌────────────────────────────────────────────────────────────────┐
│ Ribosome Worker                                                 │
│                                                                 │
│ During zome call, host function create() called:               │
│   1. Create Action (with signature via Lair proxy)             │
│   2. Store in SQLite                                            │
│   3. Add to pendingRecords array                                │
│                                                                 │
│ callZome returns { result, pendingRecords }                    │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Offscreen Document                                              │
│                                                                 │
│ For each pending record:                                        │
│   1. Generate DhtOps (StoreEntry, StoreRecord, etc.)           │
│   2. Sign each op                                               │
│   3. HTTP POST /dht/{dna}/publish                              │
│      Body: { ops: [{ op_data: base64, signature: base64 }] }   │
└─────────────────────────────┬──────────────────────────────────┘
                              │ HTTP
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ hc-membrane                                                      │
│                                                                 │
│ POST /dht/{dna}/publish handler:                               │
│   1. Decode SignedDhtOps                                        │
│   2. Verify signatures                                          │
│   3. Store in TempOpStore (60s TTL)                            │
│   4. Call gateway_kitsune.publish_ops(dna, op_ids, basis)      │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ GatewayKitsune                                                  │
│                                                                 │
│ publish_ops():                                                  │
│   1. Find peers near basis location                             │
│   2. Send publish notification via kitsune2                     │
│   3. Peers request ops back from gateway                        │
│   4. TempOpStore.retrieve_ops() serves the data                │
│   5. Peers validate and store in their DHT                     │
└────────────────────────────────────────────────────────────────┘
```

---

### Remote Signing Flow

```
┌────────────────────────────────────────────────────────────────┐
│ GatewayKitsune / ProxyAgent                                     │
│                                                                 │
│ Kitsune2 needs agent signature (e.g., for agent_info):         │
│   ProxyAgent.sign(message_bytes) called                         │
│     │                                                           │
│     ▼                                                           │
│   AgentProxyManager.request_signature(agent, message)          │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ AgentProxyManager                                               │
│                                                                 │
│   1. Generate unique request_id                                 │
│   2. Create oneshot channel for response                        │
│   3. Store in pending_signatures map                            │
│   4. Send WebSocket: SignRequest { request_id, agent, message }│
│   5. Await response (30s timeout)                               │
└─────────────────────────────┬──────────────────────────────────┘
                              │ WebSocket
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Offscreen Document                                              │
│                                                                 │
│   1. Receive sign_request message                               │
│   2. Decode base64 message bytes                                │
│   3. Forward to background via chrome.runtime.sendMessage      │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Background Service Worker                                       │
│                                                                 │
│   1. Look up Lair client for agent                              │
│   2. lairClient.signByPubKey(agent, message)                   │
│   3. Return signature to offscreen                              │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Offscreen → WebSocket → Gateway                                 │
│                                                                 │
│   Send: SignResponse { request_id, signature }                 │
│                                                                 │
│ AgentProxyManager.deliver_signature():                         │
│   1. Find pending request by ID                                 │
│   2. Send signature through oneshot channel                     │
│   3. ProxyAgent.sign() returns signature to kitsune2           │
└────────────────────────────────────────────────────────────────┘
```

---

### Get Flow (Cascade Pattern)

The `get()`, `get_links()`, and `get_details()` host functions use a **cascade pattern** that checks local storage first, then network cache, then makes gateway requests.

```
┌────────────────────────────────────────────────────────────────┐
│ WASM Zome Code                                                  │
│                                                                 │
│ let record = get(entry_hash)?;  // Synchronous host function   │
│   │                                                             │
│   ▼                                                             │
│ Host function: get()                                           │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Cascade (packages/core/src/network/cascade.ts)                  │
│                                                                 │
│ fetchRecord(hash):                                              │
│   │                                                             │
│   ├─► 1. LOCAL: storage.getActionByHash(hash)                  │
│   │      └─► SQLite query (<1ms)                               │
│   │      └─► Found? Return immediately                         │
│   │                                                             │
│   ├─► 2. CACHE: networkCache.get(base64(hash))                 │
│   │      └─► In-memory Map lookup                              │
│   │      └─► TTL: 5 minutes, max 1000 entries                  │
│   │      └─► Found & not expired? Return                       │
│   │                                                             │
│   └─► 3. NETWORK: networkService.getRecordSync(dnaHash, hash)  │
│          └─► Sync XHR to gateway                               │
│          └─► Cache result before returning                     │
└─────────────────────────────┬──────────────────────────────────┘
                              │ If network fetch needed
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ ProxyNetworkService (in Ribosome Worker)                        │
│                                                                 │
│ getRecordSync(dnaHash, hash):                                  │
│   1. Post NETWORK_REQUEST to offscreen                         │
│   2. Atomics.wait(signalBuffer) ◄── BLOCKS worker thread       │
│   3. Read result from SharedArrayBuffer                        │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Offscreen Document (Sync XHR Proxy)                             │
│                                                                 │
│ handleNetworkRequest():                                         │
│   const xhr = new XMLHttpRequest();                            │
│   xhr.open('GET', url, false);  // false = synchronous         │
│   xhr.send();                                                   │
│                                                                 │
│   // Write result to SharedArrayBuffer                         │
│   resultBuffer.set(responseBytes);                             │
│   Atomics.store(signalBuffer, 0, 1);                           │
│   Atomics.notify(signalBuffer, 0);  // Wake worker             │
└─────────────────────────────┬──────────────────────────────────┘
                              │ HTTP GET
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ hc-membrane                                                     │
│                                                                 │
│ GET /dht/{dna_hash}/record/{hash}                              │
│   1. Parse hash from URL (Holochain base64 format)             │
│   2. Query kitsune2 network directly (no conductor needed)     │
│   3. Return { signed_action, entry } as JSON                   │
│                                                                 │
│ Response format: hashes as number arrays, normalized by        │
│ extension via normalizeByteArraysFromJson() to Uint8Array      │
└────────────────────────────────────────────────────────────────┘
```

#### Gateway Endpoints for Get Operations

| Host Function | Gateway Endpoint | Response | Uses Cascade |
|---------------|-----------------|----------|--------------|
| `get()` | `GET /dht/{dna}/record/{hash}` | `{ signed_action, entry }` | Yes |
| `get_links()` | `GET /dht/{dna}/links?base=&type=&zome_index=` | `Vec<Link>` or `WireLinkOps` (dual-format) | Yes (always network) |
| `get_details()` | `GET /dht/{dna}/details/{hash}` | `{ type, content }` | **No** (local only)* |
| `count_links()` | `GET /dht/{dna}/links/count?base=&type=` | `number` | Yes |

*`get_details` currently only queries local storage. See `STEPS/12.2_GET_DETAILS_CASCADE.md` for planned fix.

**Link response dual-format**: hc-membrane can return links as either a flat `Vec<Link>` array (conductor mode) or `WireLinkOps { creates, deletes }` (direct kitsune2 mode). The extension parses both formats -- see `sync-xhr-service.ts` and `ribosome-worker.ts` for the dual-format parsing logic.

#### Hash Encoding in URLs

Hashes use Holochain's base64 format with `u` prefix:
```
Original:     Uint8Array(39) [132, 41, 36, ...]
URL encoded:  uhCQk...  (u + URL-safe base64)
```

#### Response Normalization

Gateway returns JSON with hashes as number arrays:
```json
{
  "signed_action": {
    "hashed": {
      "hash": [132, 41, 36, ...],
      "content": { "type": "Create", ... }
    },
    "signature": [1, 2, 3, ...(64 bytes)]
  },
  "entry": {
    "entry_type": "App",
    "entry": [99, 111, 110, ...]
  }
}
```

`normalizeByteArraysFromJson()` recursively converts all number arrays to `Uint8Array`.

#### get_links() - Always Fetches Network

Unlike `get()`, the `get_links()` function **always queries the network** because links are distributed across the DHT:

```
┌────────────────────────────────────────────────────────────────┐
│ get_links(base_address, link_type)                              │
│                                                                 │
│ 1. Fetch LOCAL links from SQLite                               │
│ 2. Fetch NETWORK links from gateway (always)                   │
│ 3. MERGE results (deduplicate by create_link_hash)             │
│ 4. Return combined link set                                    │
└────────────────────────────────────────────────────────────────┘
```

This ensures the browser agent sees links created by other agents, not just its own.

---

## Key Files Reference

### Browser Extension
| File | Purpose |
|------|---------|
| `packages/extension/src/background/index.ts` | Message router, Lair, authorization |
| `packages/extension/src/background/chrome-offscreen-executor.ts` | Chrome ZomeExecutor (offscreen document management) |
| `packages/extension/src/lib/zome-executor.ts` | ZomeExecutor interface + shared types |
| `packages/extension/src/content/index.ts` | Page ↔ extension bridge |
| `packages/extension/src/inject/index.ts` | window.holochain API |
| `packages/extension/src/offscreen/index.ts` | Sync XHR, WebSocket, worker management |
| `packages/extension/src/offscreen/ribosome-worker.ts` | WASM + SQLite execution |
| `packages/extension/src/lib/messaging.ts` | Message serialization protocol |
| `packages/extension/src/lib/happ-context-manager.ts` | hApp lifecycle |

### Core Libraries
| File | Purpose |
|------|---------|
| `packages/core/src/ribosome/runtime.ts` | WASM runtime, callZome |
| `packages/core/src/ribosome/host-fn/*.ts` | Host function implementations |
| `packages/core/src/ribosome/serialization.ts` | WASM I/O encoding |
| `packages/core/src/storage/sqlite-storage.ts` | SQLite storage provider |
| `packages/core/src/network/sync-xhr-service.ts` | Gateway HTTP client |
| `packages/core/src/network/websocket-service.ts` | Gateway WebSocket client |
| `packages/core/src/utils/bytes.ts` | Uint8Array conversion utilities |

### Gateway (hc-membrane, separate repo)
| File | Purpose |
|------|---------|
| `src/routes.rs` | HTTP route definitions |
| `src/routes/websocket.rs` | WebSocket handler |
| `src/agent_proxy.rs` | AgentProxyManager |
| `src/kitsune_proxy.rs` | KitsuneProxy, ProxySpaceHandler |
| `src/proxy_agent.rs` | ProxyAgent (browser agent in kitsune2) |
| `src/temp_op_store.rs` | TempOpStore for publish flow |

Note: The gateway queries kitsune2 directly for DHT operations -- hc-membrane is itself a kitsune2 peer.

---

## Architectural Decisions and Evolution

This section records *why* key decisions were made and *what's changing*. When the architecture changes, update this section -- it's cheaper than rewriting data flow diagrams.

### Why the Offscreen Document Exists

Chrome MV3 service workers cannot do synchronous XMLHttpRequest or spawn Workers. WASM host functions must be synchronous. The offscreen document is the only extension context with DOM access (sync XHR) and the ability to create a Web Worker.

**Current state:** The `ZomeExecutor` interface has been extracted. `ChromeOffscreenExecutor` implements it for Chrome. The background service worker is now browser-agnostic -- it interacts only with the `ZomeExecutor` interface, not with offscreen document APIs directly.

**Next step (Step 21 - Firefox):** Firefox MV3 uses an event page (with DOM) instead of a service worker, so Workers can be spawned directly from background and sync XHR works in workers. A `FirefoxExecutor` implementation of `ZomeExecutor` will replace the offscreen document layer. See `STEPS/21_PLAN.md`.

### Why SharedArrayBuffer + Atomics

The ribosome worker runs WASM synchronously. When a host function needs network data or a signature, it must block until the result arrives. SharedArrayBuffer with Atomics.wait/notify provides zero-CPU-cost blocking between the worker and offscreen document.

**Next step (Step 21 - Firefox):** Firefox workers can do sync XHR directly. The SharedArrayBuffer coordination is only needed on Chrome. The `ProxyNetworkService` will gain a direct-XHR mode. This is internal to the executor implementation and invisible to the background service worker.

**Future (JSPI):** WebAssembly JavaScript Promise Integration would eliminate the sync constraint entirely by allowing WASM to suspend/resume on async calls. Chrome 137+, Firefox behind flag. Monitor for production readiness.

### Why Uint8Array Normalization Exists

Chrome's message passing (chrome.runtime.sendMessage, chrome.tabs.sendMessage) uses a structured cloning algorithm that converts `Uint8Array` to plain objects `{0: 1, 1: 2, ...}`. Every message boundary between extension contexts must normalize these back.

**Next step (Step 21 - Firefox):** Firefox preserves Uint8Array via structured clone. The normalization functions become no-ops on Firefox but remain in place for Chrome.

**Rule:** All code receiving data across a Chrome message boundary MUST call `normalizeUint8Arrays()` before processing. This is a no-op when data is already Uint8Array, so it's safe to call unconditionally on both browsers.

### Why Op Construction Happens in the Browser (and Why It Should Move)

Currently, the browser extension builds DhtOps from Records using TypeScript ports of Holochain's Rust code (`produceOpsFromRecord`). This is fragile -- serialization must be byte-identical for hash compatibility.

**Planned change (Gateway Architecture):** Delegate op construction to hc-membrane gateway, which uses Holochain's actual Rust code. Browser sends Records, gateway calls `produce_ops_from_record()`. See `STEPS/GATEWAY_ARCHITECTURE_ANALYSIS.md` section 6.

### Why ZomeExecutor Was Extracted

The background service worker previously contained ~500 lines of Chrome-specific offscreen document management interleaved with message handling, Lair operations, and hApp context management. This made the code:
- Chrome-only with no path to Firefox support
- Hard to test (offscreen lifecycle tightly coupled to business logic)
- Hard to reason about (12+ call sites sending to offscreen, scattered state)

The `ZomeExecutor` interface isolates everything the background needs from the execution environment behind a typed contract. The background service worker is now browser-agnostic.

**Key design choices:**
- Interface in `src/lib/` (shared types), Chrome implementation in `src/background/` (Chrome-specific)
- Event callbacks (onRemoteSignal, onSignRequest, onWebSocketStateChange) flow executor → background
- Background keeps its own `gatewayConfig` for status reporting; executor gets its copy via `configureNetwork()` -- no shared mutable state
- Health checks stay in background (monitoring concern, not execution concern)

**Test coverage:** `chrome-offscreen-executor.test.ts` validates lifecycle, message routing, event callbacks, and error handling with Chrome API mocks.

### Why Two Gateway Protocols (HTTP + WebSocket)

HTTP with sync XHR handles DHT queries (get, get_links) -- required by the synchronous WASM constraint. WebSocket handles async operations (signals, remote signing) that need bidirectional push.

**Planned change (Gateway Architecture):** Unify async operations under a single RPC protocol (Cap'n Web or msgpack-rpc). Keep sync XHR for DHT queries. See `STEPS/GATEWAY_ARCHITECTURE_ANALYSIS.md` section 2.

---

## Implementing Host Functions

Host functions bridge WASM zome code to the TypeScript conductor. All follow the same pattern.

### Anatomy

```
Input:  WASM passes (ptr, len) pointing to MessagePack-encoded arguments
Output: Host function returns i64 with (ptr, len) of MessagePack-encoded Result<T, WasmError>
```

### Template

Every host function follows this structure (using `get.ts` as a simpler example than `create.ts`):

```typescript
import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { validateMyInput, type MyInput } from "../wasm-io-types";

export const my_function: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance, callContext } = context;

  // 1. DESERIALIZE: Read msgpack from WASM memory, validate structure
  const input = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateMyInput, 'MyInput'      // TypeValidator + name for errors
  );

  // 2. EXECUTE: Do the work (storage, network, etc.)
  const result = doSomething(input, callContext);

  // 3. SERIALIZE: Wrap in {Ok: data} and write back to WASM memory
  //    CRITICAL: HDK expects Result<T, WasmError>. Never skip the Ok wrapper.
  return serializeResult(instance, result);
};
```

### Key contracts

1. **Always wrap in `{Ok: data}`** -- `serializeResult()` does this. The HDK deserializes the return as `Result<T, WasmError>`. Returning unwrapped data causes a deserialization panic in WASM.

2. **TypeValidators are runtime guards** -- They check that msgpack-decoded data matches the expected TypeScript structure. Define them in `wasm-io-types.ts`. They run when `WASM_INPUT_VALIDATION_ENABLED` is true (development).

3. **Storage access is synchronous** -- `getStorageProvider()` returns a `StorageProvider` with sync methods. All reads/writes buffer in the active transaction and commit after the zome call completes.

4. **Network access blocks** -- Host functions that need network data (e.g., `get()` with cascade) call `networkService.getRecordSync()` which blocks via Atomics until the offscreen document completes a sync XHR.

5. **Signing blocks** -- `signAction()` blocks via the Lair proxy until the background script signs asynchronously.

6. **Register new host functions** in `host-fn/index.ts` -- Map the function name (e.g., `__hc__get_1`) to the implementation.

### Files to modify when adding a host function

| File | What to add |
|------|-------------|
| `host-fn/my_function.ts` | Implementation (new file) |
| `host-fn/index.ts` | Register: `__hc__my_function_1: wrapHostFunction('my_function', my_function)` |
| `wasm-io-types.ts` | Input TypeValidator if the function takes structured input |
| `host-fn/stubs.ts` | Remove from stubs if it was previously stubbed |

---

## Summary

The fishy architecture solves a fundamental impedance mismatch:

**WASM requires synchronous host functions**, but **browsers only provide async APIs**.

The solution distributes responsibilities across multiple contexts:

1. **Ribosome Worker**: Runs WASM with direct SQLite access, blocks via Atomics for I/O
2. **Offscreen Document**: Provides sync XMLHttpRequest, proxies to worker
3. **Background Service Worker**: Coordinates everything, manages keys and state
4. **Content Script + Injected Script**: Bridge the security boundary to web pages
5. **Gateway**: Bridges browser agents to Holochain's kitsune2 network

Each boundary has specific encoding/decoding requirements, primarily driven by:
- Chrome's loss of Uint8Array type information during message passing
- Holochain's MessagePack wire format for WASM
- HTTP/WebSocket's text-based JSON requiring base64 for binary data

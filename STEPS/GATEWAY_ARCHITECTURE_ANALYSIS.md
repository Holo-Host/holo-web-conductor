# Gateway Architecture Analysis: Holochain Membrane and Protocol Unification

> Analysis Date: January 2026
> Related to: Fishy Browser Extension + hc-http-gw-fork

## Executive Summary

This document analyzes a significant architectural shift for the fishy browser extension and gateway:

1. **Unifying communication protocols** - replacing HTTP + WebSocket with a single RPC system
2. **Creating a "Holochain Membrane"** - network edge access to Holochain DHT without a full conductor
3. **Reusing holochain_p2p** - leveraging existing semantic layer instead of building from scratch
4. **Dual API design** - separate Holochain semantic API and Kitsune direct API

**Key Finding**: The `holochain_p2p` crate already provides the semantic translation layer we need. This is a **Holochain Membrane** - a network edge that provides DHT access (get, get_links, publish) without source chains, validation, or storage. Like a cell membrane, it's the selective interface between lightweight browser clients and the Holochain DHT network.

---

## Table of Contents

1. [Current Architecture](#1-current-architecture)
2. [Protocol Unification Options](#2-protocol-unification-options)
3. [RPC Library Comparison](#3-rpc-library-comparison)
4. [The Synchronous Constraint](#4-the-synchronous-constraint)
5. [holochain_p2p as Semantic Layer](#5-holochain_p2p-as-semantic-layer)
6. [Publishing Flow Analysis](#6-publishing-flow-analysis)
7. [Dual API Design](#7-dual-api-design)
8. [Proposed Architecture](#8-proposed-architecture)
9. [Implementation Phases](#9-implementation-phases)
10. [Recommendations](#10-recommendations)

---

## 1. Current Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Browser Extension (Fishy)                        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Offscreen Document                                           │   │
│  │  ├─ Ribosome Worker (WASM + SQLite)                         │   │
│  │  │    └─ Blocks with Atomics.wait() for host function calls │   │
│  │  ├─ SyncXHRNetworkService                                   │   │
│  │  │    └─ Synchronous XMLHttpRequest for DHT operations      │   │
│  │  └─ WebSocketNetworkService                                 │   │
│  │       └─ Async signals + signing handshakes                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────┬───────────────────┬────────────────────────────┘
                     │ HTTP (sync)       │ WebSocket (async)
                     ▼                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Gateway (hc-http-gw-fork)                        │
│  ┌──────────────────────────────────┐  ┌────────────────────────┐  │
│  │ HTTP Endpoints                   │  │ WebSocket Handler      │  │
│  │  ├─ GET /dht/{dna}/record/*      │  │  ├─ Signal forwarding  │  │
│  │  ├─ GET /dht/{dna}/links         │  │  ├─ Sign request/resp  │  │
│  │  ├─ POST /dht/{dna}/publish      │  │  └─ Agent registration │  │
│  │  └─ GET /{dna}/{app}/{z}/{f}     │  │                        │  │
│  └──────────────────────────────────┘  └────────────────────────┘  │
│                     │                          │                    │
│                     ▼                          ▼                    │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │                   AgentProxyManager                            ││
│  │  └─ Routes signals to WebSocket connections by (dna, agent)   ││
│  └────────────────────────────────────────────────────────────────┘│
│                     │                                               │
│    ┌────────────────┼───────────────────────────────────┐          │
│    ▼                ▼                                   ▼          │
│  ┌──────────┐  ┌────────────────┐              ┌──────────────┐   │
│  │ AdminConn│  │ AppConnPool    │              │GatewayKitsune│   │
│  │ (admin ws)│ │ (app ws → zome)│              │ (P2P network)│   │
│  └──────────┘  └────────────────┘              └──────────────┘   │
│                         │                              │           │
└─────────────────────────┼──────────────────────────────┼───────────┘
                          ▼                              │
             ┌────────────────────────┐                  │
             │   Holochain Conductor  │◄─────────────────┘
             │  ├─ dht_util zome      │    (signals via Kitsune2)
             │  ├─ Storage            │
             │  └─ Kitsune2 networking│
             └────────────────────────┘
```

### Current Data Flows

| Operation | Protocol | Path |
|-----------|----------|------|
| DHT get/get_links/details | HTTP (sync XHR) | Extension → Gateway → dht_util zome → Conductor |
| Signals | WebSocket | Kitsune2 → Gateway → WebSocket → Extension |
| Publishing | HTTP POST | Extension → Gateway → TempOpStore → Kitsune2 |
| Remote signing | WebSocket | Gateway needs sig → SignRequest → Extension → SignResponse |

---

## 2. Protocol Unification Options

### Why Unify?

Currently maintaining two protocols:
- **HTTP**: For synchronous DHT operations (required by WASM host functions)
- **WebSocket**: For async signals and signing handshakes

This creates complexity in both the gateway and extension code.

### The Fundamental Constraint

**WASM host functions must be synchronous.** When the ribosome executes coordinator code and calls `host_get(hash)`, Rust expects `ExternIO` back immediately. There's no way to yield, await, or pause WASM execution.

The current solution:
1. Worker posts NETWORK_REQUEST message
2. Worker calls `Atomics.wait()` (blocks thread)
3. Main thread does **synchronous XMLHttpRequest**
4. Main thread writes to SharedArrayBuffer
5. Main thread calls `Atomics.notify()`
6. Worker resumes with result

**Any RPC unification must preserve this sync path for DHT queries.**

---

## 3. RPC Library Comparison

### Evaluated Options

| Library | Transport | Bidirectional | Schema | Bundle Size | Sync Support |
|---------|-----------|---------------|--------|-------------|--------------|
| **Cap'n Web** | WS, HTTP, postMessage | Yes | None (JSON) | <10KB | No (async) |
| **Connect-Web** | HTTP/1.1, HTTP/2 | Server-stream only | Protobuf | Small | No |
| **tRPC** | HTTP | No | TypeScript | Small | No |
| **gRPC-Web** | HTTP (needs proxy) | Server-stream only | Protobuf | Large | No |
| **jsonrpc-bidirectional** | WS, WebRTC, HTTP | Yes | JSON-RPC 2.0 | Medium | No |
| **msgpack-rpc-websockets** | WebSocket | Yes | MessagePack | Medium | No |
| **Hono RPC** | HTTP | No | TypeScript | Small | No |
| **WebTransport** | HTTP/3 (QUIC) | Yes (streams) | None | N/A | No |

### Detailed Analysis

#### Cap'n Web (Cloudflare)
- **Pros**: Object-capability model, bidirectional, <10KB, no dependencies, works over WS/HTTP/postMessage
- **Cons**: New/experimental, JSON-based (not as efficient as binary), async-only
- **Source**: [Cloudflare Blog](https://blog.cloudflare.com/capnweb-javascript-rpc-library/)

#### Connect-Web
- **Pros**: No proxy needed (unlike gRPC-Web), 80% smaller bundles, works with gRPC servers
- **Cons**: Requires Protobuf schemas, code generation, no client-side streaming in browsers
- **Source**: [Connect RPC Docs](https://connectrpc.com/docs/web/getting-started/)

#### tRPC
- **Pros**: Zero code generation, TypeScript-native type safety, simple
- **Cons**: TypeScript only, no bidirectional, not designed for real-time
- **Source**: [tRPC Comparison](https://www.wallarm.com/what/trpc-protocol)

#### jsonrpc-bidirectional
- **Pros**: True bidirectional over single WebSocket, browser tested (IE10+), plugin system
- **Cons**: JSON overhead, less modern API than Cap'n Web
- **Source**: [GitHub](https://github.com/bigstepinc/jsonrpc-bidirectional)

#### msgpack-rpc-websockets
- **Pros**: Binary MessagePack encoding (efficient), browser bundle available, bidirectional
- **Cons**: Less maintained, smaller community
- **Source**: [GitHub](https://github.com/zo-el/msgpack-rpc-websockets)

#### WebTransport
- **Pros**: HTTP/3, multiplexed streams, low latency, unreliable datagrams option
- **Cons**: **Not production ready** (spec still Working Draft), limited server support, Firefox/Safari catching up
- **Source**: [MDN WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API)

### Recommendation: Hybrid Approach

**No single library solves the sync constraint.** The best approach is:

1. **Keep sync XHR for DHT queries** (get, get_links, get_details, count_links)
2. **Use Cap'n Web OR msgpack-rpc-websockets for async operations**:
   - Signal delivery
   - Remote signing
   - Publishing
   - Future subscriptions

#### Why Cap'n Web for Async

Cap'n Web's **object-capability model** is particularly well-suited for the signing handshake:

```typescript
// Gateway can call methods on extension's signer object
interface BrowserSigner extends RpcTarget {
  sign(agentPubkey: AgentPubKey, message: Uint8Array): Promise<Signature>;
}

// Extension registers its signer with gateway
gateway.registerSigner(mySigner);

// Gateway calls directly when Kitsune needs a signature
const sig = await browserSigner.sign(agent, message);
```

#### Why msgpack-rpc-websockets as Alternative

If Cap'n Web proves too experimental, msgpack-rpc-websockets offers:
- Binary encoding (matches Holochain's msgpack usage)
- Bidirectional support
- Browser bundle available
- More mature (forked from well-tested rpc-websockets)

---

## 4. The Synchronous Constraint

### Why Sync XHR Cannot Be Replaced

The WASM execution model is fundamentally synchronous:

```
WASM executing coordinator code
  → calls host_get(hash)
  → Rust expects ExternIO back IMMEDIATELY
  → Cannot yield, await, or pause WASM execution
```

### Possible Future Solutions

1. **Pre-fetching with speculation** - Predict what data WASM needs, fetch async before execution
   - Complex, doesn't work for dynamic access patterns

2. **Async WASM (Component Model)** - Future WASM standards may support async
   - Would require changes to HDK and all coordinator code
   - Beyond scope of fishy project

3. **Keep sync XHR** - Pragmatic choice for now
   - Works reliably
   - Sync XHR is deprecated but still functional in offscreen documents

### Sync/Async Boundary Summary

| Operation | Extension Side | Gateway Side | Notes |
|-----------|---------------|--------------|-------|
| get_record | Sync (Atomics.wait) | Async (network) | Blocks worker thread |
| get_links | Sync (Atomics.wait) | Async (network) | Blocks worker thread |
| get_details | Sync (Atomics.wait) | Async (network) | Blocks worker thread |
| count_links | Sync (Atomics.wait) | Async (network) | Blocks worker thread |
| receive_signal | Async (callback) | Async (Kitsune event) | RPC callback |
| sign | Async (callback) | Async (needs signature) | RPC callback |
| publish | Async (fire-and-forget) | Async (Kitsune publish) | RPC |

---

## 5. holochain_p2p as Semantic Layer

### Key Discovery

**holochain_p2p already IS the semantic layer.** It translates high-level DHT operations into Kitsune2 network operations.

### What holochain_p2p Provides

```rust
// Outgoing semantic operations (HolochainP2pDnaT trait)
trait HolochainP2pDnaT {
    async fn get(&self, dht_hash: AnyDhtHash) -> Vec<WireOps>;
    async fn get_links(&self, link_key: WireLinkKey, options: GetLinksOptions) -> Vec<WireLinkOps>;
    async fn count_links(&self, query: WireLinkQuery) -> CountLinksResponse;
    async fn get_agent_activity(&self, agent: AgentPubKey, ...) -> Vec<AgentActivityResponse>;
    async fn publish(&self, basis_hash: OpBasis, op_hash_list: Vec<DhtOpHash>, ...) -> ();
    async fn send_remote_signal(&self, to_agent_list: Vec<...>) -> ();
    // ... more operations
}

// Incoming request handling (HcP2pHandler trait)
trait HcP2pHandler {
    fn handle_get(&self, dna_hash, to_agent, dht_hash) -> BoxFut<WireOps>;
    fn handle_get_links(&self, dna_hash, to_agent, link_key, options) -> BoxFut<WireLinkOps>;
    fn handle_publish(&self, dna_hash, ops: Vec<DhtOp>) -> BoxFut<()>;
    // ... handlers for incoming peer requests
}
```

### How It Works

```
HolochainP2pDna::get(entry_hash)
  → space = kitsune.space(dna_hash.to_k2_space())
  → agents = get_responsive_remote_agents_near_location(
      space.peer_store(),
      space.local_agent_store(),
      space.peer_meta_store(),
      entry_hash.get_loc()
    )
  → For each of 3 random agents: send WireMessage::GetReq
  → Await WireMessage::GetRes
  → Return first non-empty valid result
```

### Dependencies (Cargo.toml)

```toml
# Core dependencies - manageable
kitsune2 = "0.3.0"
kitsune2_api = "0.3.0"
kitsune2_core = "0.3.0"
kitsune2_gossip = "0.3.0"

# Holochain types - needed for data structures
holochain_types = "0.6.0"
holochain_zome_types = "0.6.0"
holo_hash = "0.6.0"

# Storage - SQLite based
holochain_sqlite = "0.6.0"  # For peer_meta_store, op_store
holochain_state = "0.6.0"

# Signing
holochain_keystore = "0.6.0"  # MetaLairClient trait
```

### What Gateway Needs to Provide

#### 1. Storage Callbacks

```rust
pub struct HolochainP2pConfig {
    pub get_db_peer_meta: GetDbPeerMeta,     // Peer responsiveness tracking
    pub get_db_op_store: GetDbOpStore,       // Op storage (can be minimal for zero-arc)
    pub get_conductor_db: GetDbConductor,    // For blocks
}
```

Gateway already has SQLite (for TempOpStore), can reuse or create minimal impls.

#### 2. HcP2pHandler for Zero-Arc

```rust
impl HcP2pHandler for GatewayZeroArcHandler {
    fn handle_get(&self, dna_hash, to_agent, dht_hash) -> BoxFut<WireOps> {
        // Zero-arc doesn't store data - return empty
        Box::pin(async { Ok(WireOps::Entry(WireEntryOps::default())) })
    }

    fn handle_get_links(&self, ...) -> BoxFut<WireLinkOps> {
        Box::pin(async { Ok(WireLinkOps::default()) })
    }

    fn handle_publish(&self, dna_hash, ops) -> BoxFut<()> {
        // Could cache temporarily for re-serving
        Box::pin(async { Ok(()) })
    }

    // Other handlers return empty/noop
}
```

#### 3. Lair Client for Remote Signing

```rust
struct WebSocketLairClient {
    agent_proxy: AgentProxyManager,
}

impl MetaLairClient for WebSocketLairClient {
    fn sign(&self, agent: AgentPubKey, message: &[u8]) -> BoxFut<Result<Signature>> {
        Box::pin(async {
            self.agent_proxy.request_signature(agent, message).await
        })
    }
}
```

### Benefits of Using holochain_p2p

1. **Battle-tested** - Used by all Holochain conductors
2. **Wire protocol compatibility** - WireMessage encoding guaranteed compatible
3. **Peer selection logic** - `get_responsive_remote_agents_near_location()` included
4. **Retry and timeout handling** - Already implemented
5. **Future-proof** - Evolves with Holochain

---

## 6. Publishing Flow Analysis

### How holochain_p2p.publish() Works

The `publish()` method in holochain_p2p uses a **hint-based model**:

```rust
fn publish(
    &self,
    dna_hash: DnaHash,
    basis_hash: OpBasis,           // DHT location for routing
    source: AgentPubKey,
    op_hash_list: Vec<DhtOpHash>,  // Just hashes, not full ops
    timeout_ms: Option<u64>,
    reflect_ops: Option<Vec<DhtOp>>, // Optional local reflection
) -> BoxFut<'_, HolochainP2pResult<()>>
```

**Key Insight**: holochain_p2p takes **op hashes**, not full ops. The actual data must be stored in an **OpStore** that Kitsune2 can query:

```
1. Caller stores ops in OpStore
2. Caller calls publish(op_hashes)
3. holochain_p2p finds peers near basis_hash location
4. Calls space.publish().publish_ops(op_ids, peer_url) for each peer
   → This is a HINT: "I have these ops, come get them"
5. Peers receive notification, call OpStore::retrieve_ops(op_ids)
6. Peers fetch the actual op bytes
```

### Current Fishy Publishing Flow

Fishy currently bypasses holochain_p2p and goes directly to Kitsune:

```
Browser Extension                    Gateway                         Network
     │                                  │                               │
     │ 1. Build ChainOps from record    │                               │
     │    (produceOpsFromRecord)        │                               │
     │                                  │                               │
     │ 2. Serialize ops (msgpack)       │                               │
     │                                  │                               │
     │ 3. POST /dht/{dna}/publish ─────►│                               │
     │    { ops: [{op_data, signature}] │                               │
     │                                  │                               │
     │                                  │ 4. Store in TempOpStore       │
     │                                  │    (implements OpStore trait) │
     │                                  │                               │
     │                                  │ 5. space.publish().publish_ops()
     │                                  │────────────────────────────────►
     │                                  │                               │
     │                                  │ 6. Peers fetch from TempOpStore
     │                                  │◄────────────────────────────────
     │                                  │                               │
     │◄─────────────────────────────────│ 7. Return success/failure     │
```

### Why This Works for Zero-Arc

The **TempOpStore pattern** fits the Kitsune2 model perfectly:

1. **Zero-arc nodes don't need persistent storage** - ops are held temporarily until authorities fetch them
2. **TempOpStore implements OpStore trait** - Kitsune2 can retrieve ops when peers request
3. **60-second TTL** - ops are deleted after authorities have had time to fetch

### Can holochain_p2p Handle This?

**Yes, with the current TempOpStore approach.** The gateway would:

1. Receive ops from browser via HTTP/RPC
2. Store in TempOpStore (implements `kitsune2_api::OpStore`)
3. Call `holochain_p2p.publish(op_hashes, basis_hash, ...)`
4. holochain_p2p uses Kitsune2's publish module
5. Peers fetch from TempOpStore

The key change is using `holochain_p2p.publish()` instead of directly calling `space.publish().publish_ops()`. This gives us:
- Consistent peer selection logic
- Built-in retry handling
- Wire protocol compatibility
- `reflect_ops` for local processing if needed

### Op Construction: Browser vs Gateway - Risk Analysis

Currently, fishy's browser extension builds DhtOps using `produceOpsFromRecord()` in TypeScript. This is a faithful port of Holochain's Rust implementation:

#### Current TypeScript Implementation

```typescript
// packages/core/src/dht/produce-ops.ts
export function produceOpsFromRecord(record: Record): ChainOp[] {
  const action = getActionFromRecord(record);
  const opTypes = actionToOpTypes(action);  // Matches Rust action_to_op_types()

  for (const opType of opTypes) {
    const op = createOpFromType(opType, action, signature, entry, actionHash);
    // ...
  }
}
```

```typescript
// packages/core/src/dht/dht-op-types.ts
export function actionToOpTypes(action: Action): ChainOpType[] {
  switch (action.type) {
    case "Create":
      return [StoreRecord, RegisterAgentActivity, StoreEntry];
    case "Update":
      return [StoreRecord, RegisterAgentActivity, StoreEntry,
              RegisterUpdatedContent, RegisterUpdatedRecord];
    // ... matches Rust exactly
  }
}
```

#### Corresponding Rust Implementation

```rust
// holochain_types/src/dht_op.rs
pub fn produce_ops_from_record(record: &Record) -> DhtOpResult<Vec<ChainOp>> {
    let op_lites = produce_op_lites_from_records(vec![record])?;
    // Build full ops from lites...
}

pub fn action_to_op_types(action: &Action) -> Vec<ChainOpType> {
    match action {
        Action::Create(_) => vec![StoreRecord, RegisterAgentActivity, StoreEntry],
        Action::Update(_) => vec![StoreRecord, RegisterAgentActivity, StoreEntry,
                                  RegisterUpdatedContent, RegisterUpdatedRecord],
        // ...
    }
}
```

#### Risk Assessment

| Risk Factor | Browser-Side (Current) | Gateway-Side (Proposed) |
|-------------|------------------------|-------------------------|
| **Op type mapping divergence** | MEDIUM: TypeScript must manually track Rust changes | LOW: Uses exact Rust code |
| **Basis computation divergence** | MEDIUM: Manual port of ChainOpUniqueForm::basis() | LOW: Uses exact Rust code |
| **Op hash computation** | HIGH: Not currently implemented; if needed, serialization must be byte-identical | LOW: Uses Holochain's hashable_content() |
| **Serialization format** | HIGH: Any msgpack encoding difference causes incompatible hashes | LOW: Uses holochain_serialized_bytes |
| **New action types** | HIGH: Must manually add support for new Action variants | LOW: Automatic with Holochain updates |
| **RecordEntry handling** | MEDIUM: Edge cases (Private, NA, Hidden, NotStored) | LOW: Exact match |
| **Maintenance burden** | HIGH: Must track Holochain changes manually | LOW: Inherits from dependency |

#### Specific Concerns

1. **Op Hash Computation**: Holochain computes op hashes via `ChainOpUniqueForm::op_hash()` which serializes the op's "unique form" (action without signature) using msgpack and hashes with blake2b. Fishy currently doesn't compute op hashes, but holochain_p2p's hint-based publish model requires matching op hashes. Any serialization difference would cause silent failures.

2. **Serialization Format**: Holochain uses `holochain_serialized_bytes` with msgpack encoding. Even minor differences (field ordering, enum representation) would produce different bytes and thus different hashes. The TypeScript `@msgpack/msgpack` library may not produce byte-identical output.

3. **Action Type Evolution**: Holochain 0.6 introduced new patterns (countersigning, warrants). Future versions may add new action types or modify existing ones. TypeScript port requires manual updates.

4. **RecordEntry Edge Cases**: The handling of `Present`, `Hidden`, `NA`, `NotStored` variants must exactly match Holochain's logic for which ops get produced.

#### Recommendation: Delegate Op Construction to Gateway

**Move op construction to the gateway** using `holochain_types::dht_op::produce_ops_from_record()`:

```
Browser Extension                    Gateway
     │                                  │
     │ 1. Create Record (signed action) │
     │                                  │
     │ 2. POST /hc/{dna}/publish ──────►│
     │    { record: Record }            │
     │                                  │
     │                                  │ 3. produce_ops_from_record()
     │                                  │    (Holochain's Rust code)
     │                                  │
     │                                  │ 4. Store in TempOpStore
     │                                  │
     │                                  │ 5. holochain_p2p.publish()
```

**Benefits**:
- **Single source of truth**: Gateway uses exact same Rust code as Holochain conductors
- **Automatic compatibility**: Op construction evolves with Holochain updates
- **Correct op hashes**: Uses Holochain's hashable_content() and serialization
- **Reduced maintenance**: No TypeScript port to keep in sync
- **Simpler browser code**: Just send the Record, gateway handles op details

**Tradeoffs**:
- Browser loses visibility into individual ops (can be added as response metadata)
- Slightly more data over wire (Record vs ops) - but Record is actually smaller than multiple ops
- Gateway does more work (but it's already doing the heavy lifting)

---

## 7. Dual API Design

### Why Two APIs?

The system has two distinct levels of abstraction:

1. **Holochain Semantic Layer** - DhtOps, entries, links, agent activity
2. **Kitsune Network Layer** - peers, spaces, transport, raw messaging

Different use cases need different levels:

| Use Case | API Level | Example |
|----------|-----------|---------|
| hApp development | Holochain Semantic | `get(entry_hash)`, `get_links(base)` |
| Network debugging | Kitsune Direct | `peer_store.get_all()`, `space.gossip()` |
| Custom protocols | Kitsune Direct | `space.send_notify(peer, data)` |
| DHT inspection | Both | Semantic for data, Kitsune for topology |

### Proposed API Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│                     hc-membrane                                      │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Holochain Semantic API (via holochain_p2p)                    │  │
│  │                                                                │  │
│  │  GET  /hc/{dna}/record/{hash}     → get record by hash        │  │
│  │  GET  /hc/{dna}/entry/{hash}      → get entry by hash         │  │
│  │  GET  /hc/{dna}/links             → get_links(base, type)     │  │
│  │  GET  /hc/{dna}/links/count       → count_links(base, type)   │  │
│  │  GET  /hc/{dna}/agent-activity    → get_agent_activity        │  │
│  │  POST /hc/{dna}/publish           → publish DhtOps            │  │
│  │  POST /hc/{dna}/call-remote       → call_remote(agent, ...)   │  │
│  │  POST /hc/{dna}/signal            → send_remote_signal        │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Kitsune Direct API (optional, for advanced use)               │  │
│  │                                                                │  │
│  │  GET  /k2/{space}/peers           → list known peers          │  │
│  │  GET  /k2/{space}/peer/{agent}    → get agent info            │  │
│  │  GET  /k2/{space}/local-agents    → list local agents         │  │
│  │  GET  /k2/{space}/arcs            → get storage arcs          │  │
│  │  POST /k2/{space}/join            → join space with agent     │  │
│  │  POST /k2/{space}/leave           → leave space               │  │
│  │  POST /k2/{space}/notify          → send raw notify to peer   │  │
│  │  GET  /k2/transport/stats         → network transport stats   │  │
│  │  GET  /k2/metrics                 → Kitsune metrics dump      │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ RPC API (bidirectional, async)                                │  │
│  │                                                                │  │
│  │  Gateway → Browser:                                           │  │
│  │    signal(dna, from_agent, payload)  → deliver signal         │  │
│  │    sign(agent, message)              → request signature      │  │
│  │                                                                │  │
│  │  Browser → Gateway:                                           │  │
│  │    register(dna, agent)              → register for signals   │  │
│  │    unregister(dna, agent)            → stop receiving signals │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Naming: Holochain Membrane (hc-membrane)

**Holochain Membrane** is the chosen name for this architecture. Shorthand: **hc-membrane**.

This is NOT "Holochain Lite" because there is no:
- Source chain (no local chain storage)
- Validation (no validation workflows)
- Full node capabilities (zero-arc, no DHT storage)

Instead, it's a **network edge** - like a cell membrane, it provides selective access between lightweight browser clients and the Holochain DHT network.

Components:
- **hc-membrane** - the server/gateway component
- **hc-membrane-client** - the browser SDK
- **hc-membrane-protocol** - the API specification

---

## 8. Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Browser Extension (Fishy)                        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Ribosome Worker                                              │   │
│  │  ├─ WASM execution                                          │   │
│  │  └─ Host functions → SyncRequestBridge                      │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ SyncRequestBridge                                           │   │
│  │  ├─ Atomics.wait() for sync operations                     │   │
│  │  └─ Posts to main thread for sync XHR                      │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ RPC Client (Cap'n Web or msgpack-rpc)                       │   │
│  │  ├─ receive_signal() ← called by gateway                   │   │
│  │  ├─ sign(agent, message) ← called by gateway               │   │
│  │  └─ publish_result(result) ← called by gateway             │   │
│  └─────────────────────────────────────────────────────────────┘   │
└──────────────┬──────────────────────────────┬───────────────────────┘
               │ Sync XHR                     │ RPC (WebSocket)
               │ (/hc/* endpoints)            │ (signals/signing/publish)
               ▼                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     hc-membrane                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ Holochain Semantic API          Kitsune Direct API (optional) │ │
│  │  GET /hc/{dna}/record/*          GET /k2/{space}/peers       │ │
│  │  GET /hc/{dna}/links             GET /k2/{space}/arcs        │ │
│  │  POST /hc/{dna}/publish          POST /k2/{space}/notify     │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                              │                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ holochain_p2p (Holochain semantic layer)                     │ │
│  │  ├─ HolochainP2pDna::get(hash) → queries network peers       │ │
│  │  ├─ HolochainP2pDna::get_links(key) → queries network peers  │ │
│  │  ├─ HolochainP2pDna::publish(...) → announces to authorities │ │
│  │  └─ Wire protocol (WireMessage) for peer communication       │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                              │                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ TempOpStore (for zero-arc publishing)                        │ │
│  │  ├─ Implements kitsune2_api::OpStore                         │ │
│  │  ├─ Holds ops until authorities fetch (60s TTL)              │ │
│  │  └─ Enables publishing without persistent storage            │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                              │                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ Kitsune2 Core                                                 │ │
│  │  ├─ Spaces (one per DNA)                                     │ │
│  │  ├─ Peer discovery (bootstrap + gossip)                      │ │
│  │  ├─ Op fetch (request from authorities)                      │ │
│  │  └─ Transport (WebRTC/QUIC)                                  │ │
│  └───────────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ Kitsune2 P2P
                               ▼
              ┌────────────────────────────────┐
              │  DHT Authorities / Full Nodes  │
              │  (Holochain conductors)        │
              └────────────────────────────────┘
```

### Key Changes from Current Architecture

1. **Remove conductor dependency for DHT** - Gateway uses holochain_p2p directly
2. **Dual API** - Holochain semantic API + optional Kitsune direct API
3. **Unified async protocol** - Single RPC system for signals/signing/publish
4. **Keep sync XHR** - Required by WASM constraint
5. **TempOpStore for publishing** - Zero-arc nodes publish via temporary storage
6. **Direct Kitsune2 participation** - Gateway is a peer, not a proxy

---

## 9. Implementation Phases

### Phase 1: Kitsune Direct API for Liveness (Low Risk, Immediate Need)

Add Kitsune direct API endpoints needed for Step 14 liveness UI:

```
├── GET /k2/{space}/status          → network connection status
├── GET /k2/{space}/peers           → list known peers
├── GET /k2/{space}/peer/{agent}    → get specific agent info
├── GET /k2/{space}/local-agents    → list local agents
├── GET /k2/transport/stats         → network transport stats
└── No publish or getops needed at this phase
```

**Rationale**: The browser extension's Step 14 liveness UI needs:
- Network connectivity status (connected to bootstrap? peers found?)
- Agent presence information (is my agent visible to the network?)
- Peer count and discovery stats

These are read-only Kitsune2 introspection APIs, independent of the Holochain semantic layer.

**Deliverable**: Liveness UI can display network health and agent status.

### Phase 2: RPC for Async Operations (Low Risk)

Replace WebSocket protocol with Cap'n Web (or msgpack-rpc):

```
├── Add Cap'n Web as dependency
├── Implement bidirectional signal delivery
├── Implement signing as remote method call
├── Implement publish notifications
├── Keep sync XHR for DHT queries (no change)
└── Deprecate custom WebSocket protocol
```

**Deliverable**: Unified async protocol, cleaner code.

### Phase 3: Integrate holochain_p2p (Medium Risk)

Add holochain_p2p as gateway dependency:

```
├── Add holochain_p2p to Cargo.toml
├── Create WebSocketLairClient (delegate signing to browser)
├── Create GatewayZeroArcHandler (return empty for incoming queries)
├── Provide SQLite storage callbacks (reuse existing DB)
├── Wire HTTP endpoints to holochain_p2p methods
├── Migrate op construction to gateway (produce_ops_from_record)
├── Update POST /hc/{dna}/publish to accept Record, not ops
└── Test against existing Holochain network
```

**Key Change**: Publishing now accepts a **Record** instead of pre-built ops. Gateway uses Holochain's `produce_ops_from_record()` to generate ops, ensuring byte-identical serialization and hash computation.

**Deliverable**: Gateway queries and publishes via holochain_p2p with guaranteed compatibility.

### Phase 4: Remove Conductor Dependency (Medium Risk)

Cut over from dht_util zome to holochain_p2p:

```
├── Remove dht_util zome calls from HTTP handlers
├── Remove AppConnPool (no conductor needed for DHT)
├── Remove AdminConn (only if not needed for other features)
├── Gateway participates directly in Kitsune2 network
└── Comprehensive integration testing
```

**Deliverable**: Gateway is standalone Kitsune2 peer.

### Phase 5: Optimization and Modularization

```
├── Profile and optimize performance
├── Document API for other use cases (mobile, CLI)
└── Evaluate WebTransport when production-ready
```

### Repository Migration: hc-http-gw-fork → hc-membrane

The migration from hc-http-gw-fork to a new hc-membrane repository should be done incrementally, maintaining a working connection to the Fishy extension and ziptest test app at each step.

#### Migration Principles

1. **Incremental steps** - Each step should be independently testable
2. **No regressions** - Fishy extension + ziptest must pass at each step
3. **Parallel operation** - Support both old and new during transition
4. **Feature flags** - Use flags to toggle between implementations

#### Migration Steps

```
Step M1: Create hc-membrane repository (skeleton)
├── Initialize new repo with Cargo workspace
├── Copy basic project structure from hc-http-gw-fork
├── Set up CI/CD similar to current setup
├── Fishy extension continues using hc-http-gw-fork
└── TEST: ziptest passes against hc-http-gw-fork

Step M2: Extract core HTTP API layer
├── Copy HTTP endpoint handlers to hc-membrane
├── Maintain identical API surface (/hc/*, /dht/*)
├── hc-membrane can be run as drop-in replacement
├── Update Fishy to support configurable gateway URL
└── TEST: ziptest passes against BOTH gateways

Step M3: Add Kitsune liveness endpoints
├── Implement /k2/* liveness endpoints in hc-membrane
├── These endpoints not in hc-http-gw-fork (new feature)
├── Update Fishy Step 14 UI to use new endpoints
└── TEST: ziptest passes, liveness UI shows data

Step M4: Integrate holochain_p2p
├── Add holochain_p2p dependency to hc-membrane
├── Wire get/get_links through holochain_p2p
├── Keep conductor fallback via feature flag
└── TEST: ziptest passes with both code paths

Step M5: Migrate op construction to gateway
├── Add produce_ops_from_record in hc-membrane
├── Update POST /hc/{dna}/publish to accept Record
├── Fishy extension sends Records instead of ops
├── Keep old ops endpoint for backwards compat
└── TEST: ziptest passes, publishing verified

Step M6: Remove conductor dependency
├── Remove dht_util zome routing
├── Remove AppConnPool
├── hc-membrane is standalone Kitsune2 peer
└── TEST: ziptest passes against hc-membrane only

Step M7: Deprecate hc-http-gw-fork
├── Update Fishy to require hc-membrane
├── Archive hc-http-gw-fork repo
└── TEST: Full integration test suite
```

#### Testing Strategy

Each migration step must pass:
1. **Unit tests** - Individual component tests
2. **Integration tests** - Gateway API contract tests
3. **E2E tests** - Fishy extension + ziptest full flow
4. **Regression check** - Compare behavior with previous step

```
# Test command pattern for each step
cd ../hc-membrane && cargo test
cd ../fishy && npm run test:integration
cd ../fishy && npm run test:ziptest
```

### Phase Summary

**Feature Phases:**

| Phase | Focus | Risk | Blocking |
|-------|-------|------|----------|
| 1 | Kitsune liveness API | Low | Step 14 UI |
| 2 | RPC unification | Low | Cleaner code |
| 3 | holochain_p2p + op delegation | Medium | Full compatibility |
| 4 | Remove conductor | Medium | Standalone node |
| 5 | Optimization | Low | Production readiness |

**Migration Steps (integrated with feature phases):**

| Step | Focus | Corresponds To |
|------|-------|----------------|
| M1 | Create hc-membrane repo | Before Phase 1 |
| M2 | Extract HTTP API | Before Phase 1 |
| M3 | Kitsune liveness endpoints | Phase 1 |
| M4 | Integrate holochain_p2p | Phase 3 |
| M5 | Migrate op construction | Phase 3 |
| M6 | Remove conductor | Phase 4 |
| M7 | Deprecate hc-http-gw-fork | After Phase 4 |

---

## 10. Recommendations

### Protocol Unification

1. **Cap'n Web for async operations** - Best fit for object-capability model (signing)
2. **Keep sync XHR for DHT queries** - No alternative given WASM constraint
3. **Fallback: msgpack-rpc-websockets** - If Cap'n Web proves too experimental

### Semantic Layer

1. **Use holochain_p2p directly** - Don't reinvent the wheel
2. **Provide minimal zero-arc handlers** - Return empty for incoming queries
3. **Reuse SQLite** - Gateway already has it for TempOpStore

### Op Construction (UPDATED)

**Delegate op construction to the gateway**. The original recommendation to keep browser-side op construction was reconsidered after risk analysis:

| Factor | Browser-Side | Gateway-Side |
|--------|-------------|--------------|
| Serialization compatibility | HIGH RISK | LOW RISK |
| Op hash correctness | HIGH RISK | LOW RISK |
| Maintenance burden | HIGH | LOW |
| Holochain evolution tracking | Manual | Automatic |

**Action**: Migrate publishing endpoint to accept `Record` instead of pre-built ops. Gateway uses `holochain_types::dht_op::produce_ops_from_record()` to generate ops with guaranteed byte-identical serialization.

### Kitsune Direct API (Immediate Need)

1. **Phase 1 priority** - Network status/agent info APIs for Step 14 liveness UI
2. **Read-only introspection only** - No publish or getops needed initially
3. **Independent of Holochain semantic layer** - Can be implemented before holochain_p2p integration

### Architecture

1. **Start with Phase 1** - Kitsune liveness API unblocks Step 14 UI
2. **Phase 2-3 can be parallel** - RPC unification and holochain_p2p integration
3. **Defer WebTransport** - Not production ready, revisit in 6-12 months

### Future Considerations

- **WASM Component Model** - May eventually allow async host functions
- **WebTransport** - Monitor spec progress for future adoption
- **holochain_p2p_core** - Could advocate for upstream factoring if dependency weight matters

---

## Appendix: Sources

### RPC Libraries
- [Cap'n Web (Cloudflare)](https://blog.cloudflare.com/capnweb-javascript-rpc-library/)
- [Connect-Web](https://connectrpc.com/docs/web/getting-started/)
- [tRPC Protocol](https://www.wallarm.com/what/trpc-protocol)
- [jsonrpc-bidirectional](https://github.com/bigstepinc/jsonrpc-bidirectional)
- [msgpack-rpc-websockets](https://github.com/zo-el/msgpack-rpc-websockets)
- [Hono RPC](https://hono.dev/docs/guides/rpc)

### WebTransport
- [MDN WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API)
- [W3C WebTransport Spec](https://www.w3.org/TR/webtransport/)
- [Chrome WebTransport Guide](https://developer.chrome.com/docs/capabilities/web-apis/webtransport)

### Comparisons
- [gRPC vs tRPC](https://apipark.com/techblog/en/understanding-the-differences-between-grpc-and-trpc-for-modern-web-applications/)
- [WunderGraph Comparison](https://wundergraph.com/blog/graphql-vs-federation-vs-trpc-vs-rest-vs-grpc-vs-asyncapi-vs-webhooks)

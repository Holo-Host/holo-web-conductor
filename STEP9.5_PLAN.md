# Step 9.5: Gateway Real-Time Connection for Remote Signals

**Created**: 2025-12-30
**Status**: COMPLETE (2025-12-31)

## Problem Statement

Browser extensions cannot maintain direct kitsune2 connections (QUIC/WebRTC transports require persistent network presence). We need the hc-http-gw to act as a **proxy agent** that:
1. Maintains kitsune2 presence on behalf of browser agents
2. Forwards incoming remote signals and calls to the browser
3. Forwards outgoing signals and calls from the browser to the network

## Key Research Findings

### How Remote Signals Work in Holochain

Remote signals are **NOT** gossip operations. They're direct peer-to-peer messages:

1. Sender calls `send_remote_signal(agents, signal_data)`
2. Holochain creates `ZomeCallParams` with `fn_name: "recv_remote_signal"`
3. Signs the params and sends via `network.send_remote_signal()` (fire-and-forget)
4. Target agent receives it as a zome call to `recv_remote_signal` callback
5. That callback typically calls `emit_signal()` to notify local UI

### How Remote Calls Work

Remote calls are synchronous request-response:
1. Caller invokes `call(NetworkAgent(target), zome, fn, payload)`
2. Creates signed `ZomeCallParams`, sends via `network.call_remote()`
3. Target agent receives via `HcP2pHandler.handle_call_remote()`
4. Executes zome function, returns serialized response
5. Caller receives and deserializes response

### Kitsune2 Agent Registration

Agents become "findable" by publishing signed `AgentInfo`:
```rust
AgentInfo {
    agent: AgentId,        // 32-byte Ed25519 pubkey
    space: SpaceId,        // DNA hash
    url: Option<Url>,      // Network address (where to reach this agent)
    storage_arc: DhtArc,   // DHT responsibility (zero for browser = 0 arc)
    created_at, expires_at, is_tombstone
}
```

### hc-http-gw Current State

- Axum HTTP server with single GET endpoint for zome calls
- Connection pool: one AppWebsocket per installed app (not per browser)
- Admin connection with auto-reconnect
- No signal subscription infrastructure yet

---

## Communication Options Analysis

### Option 1: WebSocket (Recommended)

**How it works**: Browser opens persistent WebSocket to gateway. All messages flow bidirectionally.

**Pros**:
- Bidirectional - handles both signals (server→client) AND calls (client→server)
- Low latency for real-time signals
- Built-in connection liveness (ping/pong frames)
- Browser has excellent WebSocket support
- Can also handle publish operations
- Single connection for all message types

**Cons**:
- More complex connection state management
- Need reconnection handling on both sides
- More gateway memory per connected browser

**Liveness**: Excellent - WebSocket has ping/pong heartbeat, immediate disconnect detection

### Option 2: Server-Sent Events (SSE) + HTTP

**How it works**: SSE stream for server→client signals. HTTP POST for client→server calls.

**Pros**:
- SSE is simpler than WebSocket (unidirectional)
- HTTP semantics for calls (familiar, RESTful)
- Auto-reconnect built into EventSource API

**Cons**:
- Two separate channels adds complexity
- SSE is one-way only (still need HTTP for outbound)
- Cannot multiplex outbound calls over same connection

**Liveness**: Good - SSE has automatic reconnection, but separate channels complicate detection

### Option 3: HTTP Long Polling

**How it works**: Browser makes HTTP request that blocks until signal arrives or timeout.

**Pros**:
- Works everywhere (pure HTTP)
- Simplest server implementation

**Cons**:
- Higher latency (poll interval)
- More bandwidth usage
- Connection overhead per poll
- Harder to detect disconnection quickly

**Liveness**: Poor - timeout-based, delayed disconnect detection

### Option 4: HTTP Short Polling

**Rejected**: High latency, wastes resources, poor UX for real-time signals.

---

## Recommendation: WebSocket

Given the constraints:
1. **Simplicity**: WebSocket is one connection handling all message types
2. **Zero-arc**: Perfect - browser only sends/receives signals and calls
3. **Liveness**: WebSocket ping/pong provides sub-second disconnect detection
4. **Publish reuse**: Same channel can handle publish operations (Step 8.5)
5. **Scale**: Works well for dozens of agents (not thousands)

---

## Proposed Architecture

### High-Level Flow

```
┌─────────────────┐     WebSocket      ┌─────────────────┐     Kitsune2     ┌─────────────────┐
│ Browser         │◄──────────────────►│ hc-http-gw      │◄────────────────►│ Holochain       │
│ Extension       │                    │ (Agent Proxy)   │                  │ Network         │
└─────────────────┘                    └─────────────────┘                  └─────────────────┘
     │                                        │
     │ 1. WS Connect + Auth                   │
     │ 2. Register agent with DNA hash        │
     │                                        │
     │ ← Incoming signal from network ←───────│←── recv_remote_signal
     │                                        │
     │ ─ Outgoing signal to network ─────────►│──► send_remote_signal
     │                                        │
     │ ─ call_remote request ────────────────►│──► call_remote
     │ ← call_remote response ←───────────────│
```

### Gateway Components

1. **WebSocket Handler** (`/src/routes/websocket.rs`)
   - Accepts WebSocket upgrades at `/ws`
   - Authenticates browser using existing auth mechanism
   - Manages per-client state machine

2. **Agent Proxy Manager** (`/src/agent_proxy.rs`)
   - Tracks registered browser agents: `Map<AgentPubKey, BrowserConnection>`
   - Registers "proxy AgentInfo" with kitsune2 (URL = gateway address)
   - Routes incoming signals/calls to correct browser connection

3. **Signal Forwarder** (`/src/signal_forwarder.rs`)
   - Subscribes to signals from Holochain AppWebsocket
   - Filters by registered browser agents
   - Forwards to appropriate WebSocket connections

### Message Protocol (WebSocket) - Signals-First

```typescript
// Browser → Gateway
type OutboundMessage =
  | { type: 'auth', session_token: string }                      // Authenticate connection
  | { type: 'register', dna_hash: string, agent_pubkey: string } // Register agent for DNA
  | { type: 'unregister', dna_hash: string, agent_pubkey: string } // Unregister agent
  | { type: 'ping' }

// Gateway → Browser
type InboundMessage =
  | { type: 'auth_ok' }
  | { type: 'auth_error', message: string }
  | { type: 'registered', dna_hash: string, agent_pubkey: string }
  | { type: 'unregistered', dna_hash: string, agent_pubkey: string }
  | { type: 'signal', dna_hash: string, from_agent: string, zome_name: string, signal: string }
  | { type: 'pong' }
  | { type: 'error', message: string }

// Future additions (not in initial scope):
// - { type: 'call_remote', ... }     // Browser initiates remote call
// - { type: 'call_request', ... }    // Gateway forwards incoming call to browser
// - { type: 'call_response', ... }   // Browser responds to call
// - { type: 'send_signal', ... }     // Browser sends signal to other agents
```

### Connection Lifecycle

1. **Connect**: Browser opens WebSocket to `wss://gateway/ws`
2. **Authenticate**: Send auth token (from existing `/auth/verify` flow)
3. **Register**: Send `register` message with DNA hash and agent pubkey
4. **Active**: Bidirectional signal/call flow
5. **Heartbeat**: Ping/pong every 30 seconds
6. **Disconnect**: Close WebSocket, gateway unregisters agent proxy

### Liveness Handling

**Browser side**:
- Send ping every 30s, expect pong within 5s
- If no pong, show "disconnected" in UI
- Auto-reconnect with exponential backoff

**Gateway side**:
- Track last activity per connection
- Close connections inactive >60s
- Unregister agent proxy immediately on close
- This prevents network peers from waiting on timeouts

---

## Implementation Phases (Signals-First Approach)

### Phase 1: WebSocket Infrastructure (Gateway) ✅ COMPLETE
- Add WebSocket route handler with Axum (`/ws` endpoint)
- Implement connection state machine (connect → auth → active → close)
- Add ping/pong heartbeat (30s interval, 5s timeout)
- Wire up authentication using existing session tokens

**Commit**: `a257706` in hc-http-gw-fork branch `fishy-step-9-5`
**Tests**: 20 unit tests

### Phase 2: Agent Proxy Registration (Gateway) ✅ COMPLETE
- Create AgentProxyManager to track: `Map<(DnaHash, AgentPubKey), WebSocketSender>`
- Handle agent lifecycle: register on message, unregister on disconnect
- Route messages to correct WebSocket connections

**Commit**: `b6f193c` in hc-http-gw-fork branch `fishy-step-9-5`
**Tests**: 7 unit tests + 6 integration tests

### Phase 3: Signal Forwarding (Gateway) ✅ COMPLETE
- Subscribe to AppWebsocket signals for registered apps via `app_ws.on_signal()`
- When signal arrives, check if target is a registered proxy agent
- If target is proxy agent, serialize and forward to WebSocket connection
- Handle case where browser is disconnected (drop signal, log warning)

**Commit**: `90de3f4` in hc-http-gw-fork branch `fishy-step-9-5`
**Tests**: 3 unit tests

### Phase 4: Browser Integration (Extension) ✅ COMPLETE
- Add WebSocketNetworkService class with connection lifecycle
- Implement reconnection logic with exponential backoff
- Register agents on connect/reconnect
- Receive signals and dispatch to existing signal infrastructure
- Initialize in offscreen document, forward to background script

**Commits**:
- `5fe366f`: WebSocketNetworkService class (20 tests)
- `2f5f315`: Wire to offscreen document, background signal dispatch (8 tests)

### Future Phases (Not In Initial Scope)
- **Phase 5**: `send_remote_signal` from browser (outbound signals)
- **Phase 6**: `call_remote` bidirectional proxying
- **Phase 7**: Connection status UI in extension popup

---

## Design Decisions

1. **Agent Identity**: Per-browser-agent proxy. Gateway registers a separate AgentInfo for each connected browser agent, allowing network to route directly to specific agents.

2. **Multi-DNA Support**: Single multiplexed WebSocket. One connection handles multiple DNA registrations, with messages tagged by DNA hash.

3. **Initial Scope**: Signals only first. Start with `recv_remote_signal` forwarding. Add `call_remote` and publish in later phases.

4. **Call Timeout**: 30 seconds (configurable) - for future call_remote support.

---

## Files to Create/Modify

### hc-http-gw (Rust) - Phase 1-3

| File | Action | Purpose |
|------|--------|---------|
| `Cargo.toml` | Modify | Add axum WebSocket, tokio-tungstenite deps |
| `src/router.rs` | Modify | Add `/ws` WebSocket route |
| `src/config.rs` | Modify | Add WebSocket config (heartbeat interval, timeout) |
| `src/routes/websocket.rs` | New | WebSocket upgrade handler, connection state machine |
| `src/agent_proxy.rs` | New | AgentProxyManager, agent registration with kitsune |
| `src/signal_forwarder.rs` | New | Signal subscription, filtering, forwarding |
| `src/service.rs` | Modify | Initialize AgentProxyManager, wire up signal handler |

### fishy (TypeScript) - Phase 4

| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/network/websocket-service.ts` | New | WebSocket connection manager, reconnection logic |
| `packages/core/src/network/types.ts` | Modify | Add WebSocket message types |
| `packages/extension/src/background/index.ts` | Modify | Initialize WebSocket on startup, wire to signal dispatch |
| `packages/extension/src/lib/messaging.ts` | Modify | Add connection status message types |

---

## Complexity Estimate (Signals-First Scope)

| Component | Complexity | Notes |
|-----------|------------|-------|
| Gateway WebSocket infrastructure | Medium | Axum has good WebSocket support |
| Agent proxy registration | Medium-High | Need to understand kitsune2 agent join API |
| Signal forwarding | Medium | AppWebsocket signal subscription patterns |
| Extension WebSocket client | Low-Medium | Browser WebSocket is straightforward |
| Testing | Medium | Need mock signal sources |

**Estimated effort**: 2-3 development sessions for initial signals-only implementation.

---

## Key Technical Challenges

1. **Kitsune2 Agent Registration**: Gateway needs to call `space.local_agent_join()` with a properly signed AgentInfo. May need to use browser agent's signature or gateway signs on behalf.

2. **Signal Routing**: AppWebsocket signals come tagged with cell_id. Need to extract agent_pubkey and match against registered proxy agents.

3. **Reconnection State**: When browser reconnects, need to re-register all agents. Gateway should handle duplicate registrations gracefully.

4. **Cross-DNA Signals**: Single WebSocket handles multiple DNAs. Need to correctly tag and route signals by DNA hash.

---

## Reference Files

### Kitsune2
- `../kitsune2/crates/api/src/agent.rs` - AgentInfo, AgentInfoSigned
- `../kitsune2/crates/api/src/space.rs` - Space trait with send_notify, local_agent_join
- `../kitsune2/crates/api/proto/wire.proto` - K2Proto message types

### Holochain
- `../holochain/crates/holochain/src/core/ribosome/host_fn/send_remote_signal.rs` - Remote signal implementation
- `../holochain/crates/holochain/src/core/ribosome/host_fn/call.rs` - Remote call implementation
- `../holochain/crates/holochain_p2p/src/lib.rs` - HolochainP2pDnaT trait
- `../holochain/crates/holochain_p2p/src/types/event.rs` - HcP2pHandler trait

### hc-http-gw
- `../hc-http-gw/src/router.rs` - Route definitions
- `../hc-http-gw/src/holochain/app_conn_pool.rs` - Connection pooling patterns
- `../hc-http-gw/src/routes/zome_call.rs` - Request handling patterns

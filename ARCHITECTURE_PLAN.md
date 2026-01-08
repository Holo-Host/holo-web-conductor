# Architecture Evaluation Plan

## Goal
Create a comprehensive architecture document `ARCHITECTURE.md` that visually and textually represents the fishy project, including all components, communication pathways, and encoding/decoding boundaries.

## Research Completed
Three explore agents analyzed:
1. **Browser Extension** - Background, content script, offscreen, ribosome-worker
2. **Gateway** - HTTP routes, WebSocket, kitsune2, TempOpStore, AgentProxy
3. **Encoding/Decoding** - All serialization boundaries throughout the system

## Output File: ARCHITECTURE.md

### Section 1: High-Level Architecture Diagram
ASCII diagram showing complete data flow from web page through extension to Holochain network.

### Section 2: Browser Components
| Component | Purpose | Why It Exists | Sync Model |
|-----------|---------|---------------|------------|
| Background Service Worker | Central coordinator | Only context that survives navigation | Async |
| Content Script | Page bridge | CSP isolation requires separate context | Async |
| Injected Script | window.holochain API | Page context for hApp access | Async |
| Offscreen Document | Sync XHR + WebSocket | Only DOM context has sync XMLHttpRequest | Mixed |
| Ribosome Worker | WASM + SQLite | Dedicated thread for blocking operations | Sync |

### Section 3: Gateway Components
| Component | Purpose |
|-----------|---------|
| HTTP Routes | Zome calls, DHT queries, publish |
| WebSocket | Real-time signals, remote signing |
| AgentProxyManager | Route signals to browser agents |
| KitsuneProxy | Represent browser agents in kitsune2 |
| TempOpStore | Hold browser ops during publish cycle |
| GatewayKitsune | Manage spaces and agent lifecycle |

### Section 4: Encoding/Decoding Boundaries
| Boundary | Direction | Format | Functions | Why |
|----------|-----------|--------|-----------|-----|
| Page → Content | Out | JSON + markers | serializeMessage() | Chrome loses Uint8Array type |
| Content → Background | In | JSON + markers | deserializeMessage() | Restore Uint8Array |
| Background → Offscreen | Out | Arrays | serializeForTransport() | Clean array format |
| Offscreen → Worker | Both | postMessage | SharedArrayBuffer | Sync blocking via Atomics |
| Worker → WASM | In | MessagePack | @msgpack/msgpack encode() | Holochain wire format |
| WASM → Worker | Out | MessagePack in Result | decode() + unwrap | HDK expects Result<T,E> |
| Extension → Gateway HTTP | Out | JSON + base64 hashes | encodeHashToBase64() | URL-safe hash encoding |
| Gateway → Extension HTTP | In | JSON arrays | normalizeByteArraysFromJson() | Array to Uint8Array |
| Extension ↔ Gateway WS | Both | JSON + base64 | btoa/atob + custom decode | Binary over text protocol |
| Worker → SQLite | Both | MessagePack blobs | encode/decode | Efficient binary storage |

### Section 5: Data Flow Diagrams
1. **Zome Call Flow** - Page to WASM and back
2. **Signal Flow** - Holochain → Browser and Browser → Holochain
3. **Publish Flow** - Extension creates record → Gateway → DHT
4. **Remote Signing Flow** - Kitsune2 needs signature → Browser → Response

### Section 6: Why This Complexity?

#### The Core Problem
WASM host functions **must be synchronous**. When WASM calls `get_entry(hash)`, it cannot wait for a Promise.

#### Browser Limitations
- Service workers: No sync XHR, no SharedArrayBuffer (in some contexts)
- Web workers: Can run WASM, but can't make sync HTTP calls
- Offscreen documents: Have DOM access including sync XMLHttpRequest

#### The Solution
```
Ribosome Worker (WASM + SQLite)
    │
    ├── SQLite: Sync directly in worker
    │
    ├── Network: Atomics.wait() blocks worker
    │           while offscreen does sync XHR
    │
    └── Lair: Atomics.wait() blocks worker
              while background signs async
```

## Implementation Steps
1. Create ARCHITECTURE.md
2. Add high-level ASCII diagram
3. Document each browser component with justification
4. Document each gateway component
5. Create encoding/decoding boundary table
6. Add data flow diagrams for key operations
7. Document the synchronicity reasoning

## Verification
- Review against actual code structure
- Ensure all CLAUDE.md mentioned components are covered
- Verify encoding/decoding matches implementation

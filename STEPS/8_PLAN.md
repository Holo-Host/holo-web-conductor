# Step 8: DHT Publishing for Zero-Arc Browser Extension

## Overview

Implement publishing of source chain data to the DHT via the gateway's kitsune2 node, enabling other Holochain nodes to receive and validate data authored by browser extension agents.

## Background

### How Publishing Works in Holochain

1. **After local commit**: `trigger_publish_dht_ops` workflow runs
2. **DhtOps created**: Each action generates multiple DhtOps based on type
3. **Grouped by basis**: Ops are grouped by `OpBasis` (determines DHT authorities)
4. **Published via kitsune2**: `space.publish().publish_ops(op_ids, peer_url)` called for each peer near the basis location

### DhtOp Types by Action

| Action Type | DhtOps Generated |
|------------|------------------|
| Create | StoreRecord, RegisterAgentActivity, StoreEntry |
| Update | StoreRecord, RegisterAgentActivity, StoreEntry, RegisterUpdatedContent, RegisterUpdatedRecord |
| Delete | StoreRecord, RegisterAgentActivity, RegisterDeletedBy, RegisterDeletedEntryAction |
| CreateLink | StoreRecord, RegisterAgentActivity, RegisterAddLink |
| DeleteLink | StoreRecord, RegisterAgentActivity, RegisterRemoveLink |

### Zero-Arc Node Constraints

- Browser extension has no direct kitsune2 connection
- All DHT operations go through the gateway
- Private keys are in the browser (Lair), not gateway
- Must track publish success to ensure data reaches DHT

---

## Key Technical Decisions (CONFIRMED)

### 1. Signing Location: Browser Signs
- Browser extension uses Lair to sign ops before sending to gateway
- Private key never leaves browser
- Gateway validates signatures but doesn't sign

### 2. Publish Confirmation: Gateway ACK Only
- Gateway confirms receipt and successful kitsune2 publish
- Skip validation receipts for MVP (can add later)
- Simple HTTP response with success/failure

### 3. Retry Strategy: Background Queue
- Store pending publishes in IndexedDB
- Retry with exponential backoff
- Mark as published after gateway ACK

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    BROWSER EXTENSION                                 │
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │  Zome Call   │───►│ Host Function│───►│ Storage (IndexedDB)  │  │
│  │  (create)    │    │ (create.ts)  │    │ - Actions, Entries   │  │
│  └──────────────┘    └──────────────┘    │ - Pending Publishes  │  │
│                             │            └──────────────────────┘  │
│                             ▼                                       │
│                      ┌──────────────┐                               │
│                      │ Create DhtOps│                               │
│                      │ & Sign them  │                               │
│                      └──────┬───────┘                               │
│                             │                                       │
└─────────────────────────────┼───────────────────────────────────────┘
                              │ WebSocket/HTTP
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         GATEWAY                                      │
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ POST /publish│───►│ Validate Sig │───►│ OpStore.process_     │  │
│  │              │    │ & Decode Ops │    │ incoming_ops()       │  │
│  └──────────────┘    └──────────────┘    └──────────┬───────────┘  │
│                                                      │              │
│                                          ┌───────────▼───────────┐  │
│                                          │ kitsune2.publish()    │  │
│                                          │ to DHT authorities    │  │
│                                          └───────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Sub-Steps

- [Step 8.0: Hash Computation](./8.0_PLAN.md) - FIRST PRIORITY
- [Step 8.1: DhtOp Generation](./8.1_PLAN.md)
- [Step 8.2: Op Signing Protocol](./8.2_PLAN.md)
- [Step 8.3: Gateway Publish Endpoint](./8.3_PLAN.md)
- [Step 8.4: Publish Tracking](./8.4_PLAN.md)
- [Step 8.5: Integration & Publish Workflow](./8.5_PLAN.md)

---

## Success Criteria

1. Entry/action hashes are deterministic and match Holochain's computation
2. DhtOps are correctly generated for all action types
3. Ops are signed by browser extension's agent key
4. Gateway accepts and forwards published ops to DHT
5. Other Holochain nodes can retrieve and validate the published data
6. Extension tracks publish status and retries on failure

---

## References

- Holochain publish workflow: `holochain/crates/holochain/src/core/workflow/publish_dht_ops_workflow.rs`
- DhtOp types: `holochain/crates/holochain_types/src/dht_op.rs`
- Kitsune2 publish API: `holochain/kitsune2/crates/api/src/publish.rs`
- HoloP2P publish integration: `holochain/crates/holochain_p2p/src/spawn/actor.rs:1487-1544`

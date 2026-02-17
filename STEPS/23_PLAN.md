# Plan: Step 23 - Agent Activity Network Integration

## Overview

Implement `get_agent_activity` and `must_get_agent_activity` as full network-backed host functions. Agent activity is primarily useful for querying **other agents' chains** (e.g., during validation). Since fishy is a zero-arc node, all agent activity data must come from the network via the hc-membrane gateway.

**Branch**: `agent-activity` (both repos)

## Phase 1: Gateway Endpoints (hc-membrane)

The gateway needs two new DHT endpoints that follow the existing pattern in `routes/dht.rs` + `dht_query.rs`. The wire protocol messages already exist (`GetAgentActivityReq/Res`, `MustGetAgentActivityReq/Res`).

### 1A. `get_agent_activity` endpoint

**Endpoint**: `GET /dht/{dna_hash}/agent_activity/{agent_hash}?request={status|full}`

**Implementation** (follows existing `dht_get_record` pattern):

1. **`src/routes/dht.rs`** - Add `dht_get_agent_activity` handler:
   - Parse `dna_hash`, `agent_hash` from path
   - Parse `request` query param (default: `full`)
   - Map `request` to `GetActivityOptions { include_valid_activity, include_rejected_activity }`
   - Build `ChainQueryFilter::new()` (no filtering, return all)
   - Call `dht_query.get_agent_activity(dna_hash, agent_hash, query, options)`
   - Convert `AgentActivityResponse` to JSON

2. **`src/dht_query.rs`** - Add `get_agent_activity` method + `send_get_agent_activity_request`:
   - Same pattern as `send_get_request()`: create `WireMessage::get_agent_activity_req()`, register oneshot, send via space, await with timeout
   - Fan out to `PARALLEL_GET_AGENTS_COUNT` peers near `agent_hash.get_loc()`
   - Return first non-empty `AgentActivityResponse`

3. **`src/gateway_kitsune.rs`** - Route `GetAgentActivityRes` in `handle_wire_message()`:
   - Add `WireMessage::GetAgentActivityRes { .. }` to the existing response routing match arm

4. **`src/router.rs`** - Register route in both open and authenticated routers

### 1B. `must_get_agent_activity` endpoint

**Endpoint**: `POST /dht/{dna_hash}/must_get_agent_activity`

**Request body**:
```json
{
  "agent": "<base64-encoded AgentPubKey>",
  "chain_filter": {
    "chain_top": "<base64-encoded ActionHash>",
    "limit_conditions": "ToGenesis",
    "include_cached_entries": false
  }
}
```

**Implementation**:

1. **`src/routes/dht.rs`** - Add `dht_must_get_agent_activity` handler:
   - Parse `dna_hash` from path
   - Deserialize body into `MustGetAgentActivityRequestBody`
   - Parse agent and chain_filter hashes from base64
   - Call `dht_query.must_get_agent_activity(dna_hash, agent, filter)`
   - Convert `MustGetAgentActivityResponse` to JSON

2. **`src/dht_query.rs`** - Add `must_get_agent_activity` method + `send_must_get_agent_activity_request`:
   - Same oneshot pattern
   - Use `WireMessage::must_get_agent_activity_req()`
   - Await `MustGetAgentActivityRes`

3. **`src/gateway_kitsune.rs`** - Route `MustGetAgentActivityRes` (same as 1A.3)

4. **`src/router.rs`** - Register POST route

### Phase 1 Tests (hc-membrane)

Tests follow the existing pattern in `routes/dht.rs` (unit tests on conversion functions) and `dht_query.rs` (pending responses).

**Unit tests** (`src/routes/dht.rs`):
- `test_agent_activity_response_to_json` - Verify `AgentActivityResponse` serializes correctly with `ChainStatus::Valid`, `ChainItems::Hashes`, etc.
- `test_agent_activity_empty_response` - Empty/status-only response
- `test_must_get_agent_activity_response_to_json` - `Activity` variant with `RegisterAgentActivity` items
- `test_must_get_agent_activity_incomplete` - `IncompleteChain` and `ChainTopNotFound` error responses

**Unit tests** (`src/dht_query.rs`):
- `test_pending_agent_activity_response` - Register sender, route response by msg_id

**Integration test** (requires running conductor):
- `test_get_agent_activity_from_conductor` - Start conductor, create entries, query agent activity through gateway, verify chain hashes returned
- `test_must_get_agent_activity_from_conductor` - Same but with chain filter

## Phase 2: Fishy Host Functions

Once the gateway endpoints work, update the fishy host functions to use them.

### 2A. NetworkService interface extension

**`packages/core/src/network/types.ts`** - Add two new methods:

```typescript
interface NetworkService {
  // ... existing methods ...

  getAgentActivitySync(
    dnaHash: DnaHash,
    agentPubKey: AgentPubKey,
    activityRequest: 'status' | 'full',
    options?: NetworkFetchOptions
  ): AgentActivityResponse | null;

  mustGetAgentActivitySync(
    dnaHash: DnaHash,
    agent: AgentPubKey,
    chainFilter: ChainFilter,
    options?: NetworkFetchOptions
  ): MustGetAgentActivityResponse | null;
}
```

### 2B. SyncXHR implementation

**`packages/core/src/network/sync-xhr-service.ts`** - Implement the two new methods:
- `getAgentActivitySync`: `GET /dht/{dna}/agent_activity/{agent}?request={status|full}`
- `mustGetAgentActivitySync`: `POST /dht/{dna}/must_get_agent_activity` with JSON body

### 2C. MockNetworkService

**`packages/core/src/network/mock-service.ts`** - Add mock implementations for testing.

### 2D. `get_agent_activity` host function rewrite

**`packages/core/src/ribosome/host-fn/get_agent_activity.ts`**:
1. Deserialize `GetAgentActivityInput` from WASM (add TypeValidator)
2. Call `networkService.getAgentActivitySync(dnaHash, input.agent_pubkey, input.activity_request)`
3. Convert `AgentActivityResponse` (wire format with `ChainItems`) to `AgentActivity` (zome format with `Vec<(u32, ActionHash)>`)
4. Return via `serializeResult()`

### 2E. `must_get_agent_activity` host function rewrite

**`packages/core/src/ribosome/host-fn/must_get_agent_activity.ts`**:
1. Keep existing input deserialization
2. Call `networkService.mustGetAgentActivitySync(dnaHash, input.author, input.chain_filter)`
3. Handle response variants:
   - `Activity`: return `Vec<RegisterAgentActivity>`
   - `IncompleteChain` / `ChainTopNotFound`: throw `UnresolvedDependenciesError` in validation context with `AgentActivity(author, filter)` format
   - `EmptyRange`: throw error
4. Return via `serializeResult()`

### 2F. Types

**`packages/core/src/ribosome/wasm-io-types.ts`** - Add TypeValidators:
- `validateWasmGetAgentActivityInput`
- Types: `ChainFilter`, `LimitConditions`, `ChainStatus`, `HighestObserved`, `AgentActivityResponse`, `MustGetAgentActivityResponse`

### Phase 2 Tests (fishy)

**Unit tests** (`packages/core/src/ribosome/host-fn/`):
- `get_agent_activity.test.ts` (new):
  - Deserializes `GetAgentActivityInput` correctly
  - Calls network service with correct params
  - Converts `AgentActivityResponse` to `AgentActivity` format
  - Handles null/error responses
- `must_get_agent_activity.test.ts` (update existing):
  - Calls network service with chain filter
  - Handles `Activity` response - returns `RegisterAgentActivity[]`
  - Handles `IncompleteChain` - throws `UnresolvedDependenciesError` in validation context
  - Handles `ChainTopNotFound` - throws with correct format

**E2E tests** (`packages/e2e/`):
- Test that calls a zome function which internally calls `get_agent_activity` with a real conductor's agent on the network
- Requires gateway running with a conductor that has authored actions

## Agent Assignments

| Task | Agent | Scope |
|------|-------|-------|
| Phase 1: Gateway endpoints + Rust tests | **core** | hc-membrane repo |
| Phase 2A-C: NetworkService types + impl | **core** | packages/core/src/network/ |
| Phase 2D-F: Host function rewrites + types | **core** | packages/core/src/ribosome/ |
| Phase 2 unit tests | **testing** | packages/core/ test files |
| E2E tests | **testing** | packages/e2e/ |

## Ordering

```
Phase 1 (gateway, testable independently)
  ├── 1A: get_agent_activity endpoint + tests
  └── 1B: must_get_agent_activity endpoint + tests
       │
Phase 2 (fishy, depends on Phase 1)
  ├── 2A-C: NetworkService interface + implementations
  ├── 2D: get_agent_activity host fn rewrite
  ├── 2E: must_get_agent_activity host fn rewrite
  └── 2F: Types + unit tests
       │
E2E tests (depends on both phases)
```

## Success Criteria

1. Gateway endpoints return correct `AgentActivityResponse` / `MustGetAgentActivityResponse` from conductor peers
2. Gateway unit tests pass
3. Fishy host functions fetch agent activity from gateway
4. Fishy unit tests pass with mock network service
5. E2E test demonstrates cross-agent activity query through the full stack

# Step 8: Gateway Architecture Research

## Research Question

Is extending hc-http-gw the correct approach for servicing direct DHT requests (rather than zome calls), with focus on:
- Authentication using Lair signing
- Agent pre-registration/access control via out-of-band means

---

## Research Findings

### 1. Current hc-http-gw Architecture

**What it does:**
- Single endpoint pattern: `GET /{dna-hash}/{coordinator-id}/{zome-name}/{fn-name}?payload={base64}`
- Connects to Holochain conductor via Admin + App WebSockets
- The gateway itself IS the agent (uses `ClientAgentSigner`)
- App-level access control via config (`allowed_app_ids`, `allowed_fns`)

**What it doesn't do:**
- No per-agent authentication from HTTP clients
- No direct DHT operations (get, get_links) - only zome calls
- No concept of "registered agents" at gateway level

**Key insight:** The gateway's identity is used for ALL operations. External clients are anonymous to the gateway.

### 2. Holochain DHT Access

**Critical constraint:** Holochain's App WebSocket doesn't expose DHT operations directly.

All data access goes through:
1. Zome functions (which internally call `get`, `get_links`, etc.)
2. The Cascade pattern: local → cache → network

**To add direct DHT endpoints, the gateway would need to:**
- Option A: Install a "utility zome" that wraps `get`/`get_links` host functions
- Option B: Use Admin API for direct DHT queries (not currently supported)
- Option C: Modify Holochain to expose DHT ops on App WebSocket

### 3. Zero-Arc Node Model

The fishy extension operates as a **zero-arc node**:
- Stores only its own source chain (authored data)
- Never an authority for DHT hashes
- Always requests data from network (never serves)
- Disabled gossip and publish

**Implication:** The extension needs to fetch remote data but doesn't store others' data.

### 4. Extension's Lair Signing Capability

**Available operations:**
- `signByPubKey(pubKey, data)` → Ed25519 signature (64 bytes)
- Verification via `crypto_sign_verify_detached`
- All using libsodium-wrappers in browser

**Possible auth patterns:**
1. **Signed challenges:** Gateway sends nonce, extension signs it
2. **Request signing:** Every request includes `signature(path|nonce|timestamp)`
3. **Encrypted payloads:** Use X25519 key exchange for payload encryption

---

## Key Architecture Questions

### Question 1: Who is the Agent?

**Current hc-http-gw model:** The gateway is the agent for all operations.

**Alternative for fishy:** Each browser extension could be its own agent.

| Approach | Gateway as Agent | Extension as Agent |
|----------|------------------|-------------------|
| Signing | Gateway signs all | Extension signs, gateway relays |
| Source chain | Single chain at gateway | Each extension has own chain |
| Identity | All clients share identity | Per-user identity |
| Complexity | Simpler | More complex auth |

### Question 2: DHT Query Routing

**Option A: Zome wrapper approach**
```
Extension → Gateway → Zome Call → get() host function → DHT
```
- Install a utility zome with `get_record(hash)` function
- Works with current hc-http-gw architecture
- No gateway modifications needed

**Option B: Direct DHT endpoints**
```
Extension → Gateway → New /dht/record/{hash} endpoint → Conductor DHT query
```
- Requires extending hc-http-gw with new routes
- Requires Holochain to expose DHT ops (not currently available)
- More efficient but more invasive

### Question 3: Agent Pre-Registration

For the gateway to accept requests from specific agents:

**Option A: Configuration-based**
```toml
# Gateway config
allowed_agents = ["uhCAk...", "uhCAk..."]
```

**Option B: Capability-based**
- Agent creates CapGrant on its chain granting gateway access
- Gateway verifies grant before accepting requests

**Option C: Out-of-band registration**
- Admin API or database stores authorized agents
- Extension registers via separate flow (e.g., OAuth-style)

---

## Decisions

1. **Per-user agent identity** - Each extension instance has its own keypair in Lair
2. **Read now, Write later** - This step (7.2) is READ only. Step 8 handles publish/write.
3. **Hybrid DHT access approach:**
   - Create utility zome wrapper as interim requirement for "browser-enabled hApps"
   - Create DHT endpoints in hc-http-gw that use the wrapper
   - Future-proof: when Holochain exposes direct DHT ops, gateway implementation changes but API stays same

---

## Implementation Plan: Step 7.2 - Network Fetch via hc-http-gw

### Part A: Utility Zome (interim requirement for browser-enabled hApps)

Create a minimal "dht_util" zome that wraps DHT host functions:

```rust
// dht_util zome functions - Step 7.2 scope
#[hdk_extern]
pub fn get_record(hash: AnyDhtHash) -> ExternResult<Option<Record>> {
    get(hash, GetOptions::default())
}

#[hdk_extern]
pub fn get_details(hash: AnyDhtHash) -> ExternResult<Option<Details>> {
    get_details(hash, GetOptions::default())
}

#[hdk_extern]
pub fn get_links_by_base(input: GetLinksInput) -> ExternResult<Vec<Link>> {
    get_links(input.base, input.link_type, input.tag_prefix)
}

#[hdk_extern]
pub fn count_links(input: CountLinksInput) -> ExternResult<usize> {
    count_links(input)
}
```

**Future additions (not in Step 7.2):**
- `get_agent_activity` - deferred to Step 9
- `must_get_entry` / `must_get_action` / `must_get_valid_record`
- `get_link_details`

**Location:** Each hApp must include this zome for now. Later: gateway could inject it automatically.

### Part B: hc-http-gw DHT Endpoints

Extend hc-http-gw with new routes that call the utility zome:

**Step 7.2 scope:**
```
GET /dht/{dna-hash}/record/{hash}
    → calls dht_util::get_record(hash)

GET /dht/{dna-hash}/details/{hash}
    → calls dht_util::get_details(hash)

GET /dht/{dna-hash}/links?base={base}&type={type}&tag={tag}
    → calls dht_util::get_links_by_base(...)

GET /dht/{dna-hash}/links/count?base={base}&type={type}&tag={tag}
    → calls dht_util::count_links(...)
```

**Future endpoints (not in Step 7.2):**
- `GET /dht/{dna-hash}/agent-activity?agent={agent}` - Step 9

**Files to modify:**
- `hc-http-gw/src/router.rs` - Add new routes
- `hc-http-gw/src/routes/dht.rs` - New file for DHT handlers
- `hc-http-gw/src/routes/mod.rs` - Export new module

### Part C: Extension Authentication

**Design: Trait/Interface with Session Cookies**

Create an authentication trait that abstracts agent verification:

```rust
// In hc-http-gw
#[async_trait]
pub trait AgentAuthenticator: Send + Sync {
    /// Verify a signed challenge and return a session token if valid
    async fn authenticate(&self, agent_pub_key: &AgentPubKey, signature: &Signature, nonce: &[u8]) -> Result<SessionToken, AuthError>;

    /// Verify a session token is still valid
    async fn verify_session(&self, token: &SessionToken) -> Result<AgentPubKey, AuthError>;
}

pub struct SessionToken {
    pub token: String,
    pub expires_at: Timestamp,
}
```

**Authentication flow:**
1. Extension requests auth: `POST /auth/challenge` → returns `{ nonce: "..." }`
2. Extension signs nonce with Lair, sends: `POST /auth/verify { agent_pub_key, signature, nonce }`
3. Gateway verifies and returns session cookie (configurable TTL)
4. Subsequent requests include session cookie - no per-request signing needed

**First implementation: ConfigListAuthenticator**
- Checks agent pubkey against `allowed_agents` list in gateway config
- Session TTL configurable (e.g., `session_ttl_secs = 3600`)

```toml
# hc-http-gw config
[auth]
session_ttl_secs = 3600  # 1 hour sessions
allowed_agents = ["uhCAk...", "uhCAk..."]
```

**Future implementations:**
- DatabaseAuthenticator - store agents in SQLite/Postgres
- CapabilityAuthenticator - verify CapGrant on agent's chain
- TrustOnFirstUseAuthenticator - auto-register with rate limiting

### Part D: Extension SyncXHRNetworkService Integration

Update `packages/core/src/network/sync-xhr-service.ts` to:
1. Build signed requests using Lair
2. Call new hc-http-gw DHT endpoints
3. Parse responses back to NetworkRecord/NetworkLink format

**Flow:**
```
Offscreen Document          Background Service         Gateway
      |                           |                       |
      | need to sign request      |                       |
      |-------------------------->|                       |
      |                           | lairClient.sign()     |
      |<---- signature -----------|                       |
      |                                                   |
      | XHR GET /dht/{dna}/record/{hash} + auth headers   |
      |-------------------------------------------------->|
      |                                                   | verify sig
      |                                                   | call utility zome
      |<-------------------- JSON response ---------------|
```

---

## Decisions Made

1. **Where does the utility zome live?**
   - **Decision:** Each hApp must include it for now
   - **Future:** Gateway could inject it automatically

2. **Agent registration mechanism?**
   - **Decision:** Trait/interface with session cookies
   - **First impl:** ConfigListAuthenticator checking against `allowed_agents` config list

3. **Testing approach?**
   - Mock gateway for unit tests (existing MockNetworkService)
   - Integration tests with local Holochain sandbox + utility zome

---

## Step 7.2 Implementation Checklist

### Phase 1: Utility Zome
- [x] Create dht_util zome with get_record, get_details, get_links_by_base, count_links
- [ ] Test with hc sandbox

### Phase 2: Gateway Extensions
- [x] Add AgentAuthenticator trait
- [x] Implement ConfigListAuthenticator
- [x] Add /auth/challenge and /auth/verify endpoints
- [x] Add /dht/* endpoints calling utility zome
- [x] Session verification middleware (via verify_session in route handlers)

### Phase 3: Extension Integration
- [x] Update SyncXHRNetworkService with auth flow
- [x] Handle session token storage (via setSessionToken/getSessionToken)
- [x] Parse gateway responses to NetworkRecord/NetworkLink

### Phase 4: Testing
- [x] Unit tests with MockNetworkService (already exist)
- [ ] Integration test with real gateway + sandbox

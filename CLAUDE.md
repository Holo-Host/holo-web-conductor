# Fishy

> Browser extension-based Holochain conductor for zero-arc nodes.

## Quick Context (READ FIRST)

**Current Step**: See [STEPS/index.md](./STEPS/index.md) for status registry

**Critical Contracts (DO NOT VIOLATE)**:
1. Host functions MUST return `{Ok: data}` - HDK requires Result<T, WasmError>
2. Hashes are 39 bytes (32 core + 3 type prefix + 4 location)
3. Chrome message passing converts Uint8Array to objects - always convert at boundaries
4. Use @holochain/client types, not custom equivalents

**WASM Boundary Invariants (DO NOT BYPASS)**:
1. All data INTO WASM → `serializeToWasm()`. Never bypass with `wasmAllocate`+`writeToWasmMemory`. The "double encoding" IS the ExternIO contract -- it wraps msgpack bytes as binary, which WASM's `host_args::<ExternIO>` requires.
2. All data FROM WASM → `deserializeFromWasm()`.
3. All host function returns → `serializeResult()` (wraps in `{Ok: data}` automatically).
4. These apply to ALL WASM calls: zome functions, validation callbacks, host functions. No exceptions.

**Error Diagnostic Table** (when you see these errors, the cause is known):

| Error message | Cause | Fix |
|---|---|---|
| `"expected byte array, got map"` | Missing ExternIO binary wrapper | Use `serializeToWasm()`, not raw memory write |
| `"expected Ok or Err"` | Missing Result wrapper | Use `serializeResult()`, not `serializeToWasm()` |
| `"Offset outside DataView bounds"` | Wrong encoding format entirely | You're double-encoding when single is needed, or vice versa |
| `"BadSize"` / hash length mismatch | 32-byte raw key vs 39-byte HoloHash | Use `hashFrom32AndType()` or `ensureAgentPubKey()` |

**Before Coding**:
1. Check [LESSONS_LEARNED.md](./LESSONS_LEARNED.md) for failed approaches on this topic
2. Research in `../holochain/` first (not web searches)
3. Write test before implementation
4. If touching ANY code that imports from `serialization.ts`, calls encode/decode, or modifies how data enters/exits WASM memory (including validation, host functions, zome calls): verify against WASM Boundary Invariants above

---

## Critical Rules

- **Use @holochain/client types**: ALWAYS check for existing types before defining new ones:
  - Hash types: `EntryHash`, `ActionHash`, `AgentPubKey`, `DnaHash`
  - Enums: `ActionType`, `HoloHashType`
  - Utilities: `HASH_TYPE_PREFIX`, `hashFrom32AndType`, `dhtLocationFrom32`, `encodeHashToBase64`
  - Return typed hashes (e.g., `EntryHash`) not `Uint8Array`

- **Strong typing**: Use TypeScript types for WASM boundaries. Match Holochain's serde format (internally tagged enums: `{"type": "create", ...}`)

- **Reference sources** (all local, no web searches):
  1. Holochain 0.6: `../holochain`
  2. @holochain/client: `../holochain-client-js`
  3. Gateway: `../hc-http-gw-fork`

- **Commit hygiene**: No claude co-authored messages. Use `npm` for builds. 

- **Dependencies** Run `nix develop -c` to get correct dependencies, i.e for all `cargo` build/test commands and for all `npm run` and all scripts.

- **Communication style**: No emotional tags or exclamation points. Just code-related information.

---

## Development Strategy

- **Trace full data flow** before deep-diving (Input → Encode → WASM → Decode → Transport → UI)
- **Check LESSONS_LEARNED.md** before any work touching WASM boundaries, encode/decode, serialization, hash formatting, or Chrome message passing -- not just "serialization work." Merge-induced test failures at these boundaries count.
- **Measure first, code second** - capture byte-level output before making changes
- **Automated tests first**, manual browser testing only for final verification
- **Chrome message passing** loses Uint8Array types - convert to/from Array at boundaries
- **Perfect is enemy of good** - reach functionality goals, iterate on quality

---

## Project Overview

Browser extension Holochain conductor. Zero-arc nodes that don't gossip - all data from network via hc-http-gw.

**Key Assumptions**:
1. Zero-arc: no gossip, fetch all data from network (may cache content-addressable data)
2. hApp context from domain name serving the UI/WASM
3. Agency (keypairs) stored locally via Lair-like IndexedDB storage
4. Nodes are not progenitors - always-on nodes exist elsewhere

---

## Project Structure

```
packages/
├── extension/     # Chrome/Firefox browser extension (MV3)
│   └── src/
│       ├── background/  # Service worker
│       ├── content/     # Content scripts (page bridge)
│       ├── offscreen/   # Offscreen document (WASM + SQLite)
│       └── popup/       # Extension popup UI
├── core/          # Core conductor functionality
│   └── src/
│       ├── ribosome/    # Host function implementations
│       ├── storage/     # SQLite storage layer
│       ├── network/     # Gateway network services
│       └── dht/         # DhtOp generation and publishing
├── lair/          # Browser-based Lair keystore
└── shared/        # Shared types and utilities
```

---

## Holochain Client Compatibility

Web-apps use standard `@holochain/client`. This project MUST maintain compatibility.

**Key Types** (39-byte Uint8Array):
- `AgentPubKey`, `ActionHash`, `EntryHash`, `DnaHash`
- `CellId` = `[DnaHash, AgentPubKey]`

**Serialization Contract**:
- Chrome messaging converts Uint8Array to `{0: 1, 1: 2, ...}` objects
- Extension must normalize back to Uint8Array before processing
- WASM expects msgpack format matching `holochain_serialized_bytes`

**Serialization Rules** (checklist when touching data boundaries):
1. Receiving data from Chrome message port: call `normalizeUint8Arrays()` (no-op if already Uint8Array)
2. Sending data across Chrome message port: call `serializeForTransport()` to convert Uint8Array to Array
3. Reading from WASM memory: use `deserializeTypedFromWasm()` with a TypeValidator
4. Writing results to WASM: use `serializeResult()` -- it wraps in `{Ok: data}` automatically
5. Gateway HTTP responses: call `normalizeByteArraysFromJson()` to convert number arrays to Uint8Array
6. Gateway HTTP requests: use `encodeHashToBase64()` for hashes in URLs (adds `u` prefix)
7. See `ARCHITECTURE.md` "Encoding/Decoding Boundaries" table for the full map

---

## Documentation Structure

| File | Purpose |
|------|---------|
| `CLAUDE.md` | This file - core rules and quick context |
| `ARCHITECTURE.md` | System architecture, data flows, encoding boundaries, decision records, host function guide |
| `STEPS/GATEWAY_ARCHITECTURE_ANALYSIS.md` | Gateway evolution plan (hc-membrane), protocol unification, holochain_p2p integration |
| `LESSONS_LEARNED.md` | Failed approaches archive (serialization debugging) |
| `DEVELOPMENT.md` | Build, test, and development workflow |
| `TESTING.md` | Testing guide (unit, integration, e2e with gateway) |
| `SESSION.md` | Current step focus |
| `STEPS/index.md` | Step status registry |
| `STEPS/X_PLAN.md` | Detailed plan for step X |
| `STEPS/X_COMPLETION.md` | Completion notes for step X |

---

## Workflow

### Starting a New Step
1. Create `STEPS/X_PLAN.md` with detailed sub-tasks
2. Update `SESSION.md` to show current step
3. Update `STEPS/index.md` status

### Completing a Step
1. Create `STEPS/X_COMPLETION.md` with summary, test results, issues fixed
2. Update `SESSION.md` to next step
3. Update `STEPS/index.md` status
4. Commit: `docs: Step X complete`

### Periodic Process Review
Run [STEPS/META_1_PROCESS_REVIEW.md](./STEPS/META_1_PROCESS_REVIEW.md) every 2-3 major steps to:
- Check fix commit ratio
- Update failed approaches documentation
- Verify context files are concise
- Assess upcoming step granularity

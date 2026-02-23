# Step 25: Linker Record Response Format Fix

## Status: Investigation

## Problem

`get_thing(actionHash)` returns null for records created by another agent. Cross-agent record fetches via the linker fail, while link fetches work correctly.

## Root Cause (from prior investigation)

The linker's `GET /dht/{dna}/record/{hash}` endpoint returns **WireOps** format (Holochain's wire protocol), but the extension's `parseRecordResponse` expects a flat **Record** format.

**Linker returns** (`h2hc-linker/src/routes/dht.rs:122`):
```json
{ "Record": { "action": { "data": [...], "status": "Valid" }, "deletes": [], "updates": [], "entry": ... } }
```

**Extension expects** (`ribosome-worker.ts:1046`):
```json
{ "signed_action": { "hashed": { "content": ..., "hash": ... }, "signature": ... }, "entry": ... }
```

The check `if (!data || !data.signed_action)` fails because the response has a `Record` key, not `signed_action`. Returns null.

### Why Links Work But Records Don't

The linker handles links differently. In `dht.rs:227`, `wire_link_ops_to_links()` converts `WireLinkOps` into a flat `Vec<Link>` before returning JSON. For records, `wire_ops_to_json()` (line 426) serializes `WireOps` directly via serde -- no conversion to flat Record format.

### Evidence

- Linker logs show `dht_get_record` requests arriving and completing (HTTP 200 with JSON body)
- Extension's `parseRecordResponse` returns null because `data.signed_action` is undefined
- `callZome('get_thing', hash)` returns null after 10+ retries over 10 seconds
- Links (`get_things`/`get_links`) work correctly through the same linker

## Investigation Plan

### Phase 1: Verify the problem still exists on current main

1. Check `parseRecordResponse` in extension code -- confirm it still expects `signed_action`
2. Check linker's `dht.rs` -- confirm it still returns WireOps format for records
3. Check if any recent commits (step 20-24, CI, rename) touched this code path
4. Run the multi-agent ziptest e2e test to confirm the failure

### Phase 2: Understand the exact wire format

5. Inspect the Rust types: `WireOps`, `WireRecordOps` in holochain source
6. Capture actual JSON response from linker (add logging or use curl against running linker)
7. Map WireOps fields to the flat Record fields the extension needs

### Phase 3: Determine fix location

8. Evaluate option A: Extension-side parse WireOps (simpler, no linker change)
9. Evaluate option B: Linker-side conversion like `wire_link_ops_to_links` (cleaner contract)
10. Check if linker already has `wire_record_ops_to_details` or similar conversion code to reuse

### Phase 4: Implement and test

11. Implement chosen approach
12. Add unit test for the new parsing/conversion
13. Run multi-agent e2e test to verify cross-agent record fetch works

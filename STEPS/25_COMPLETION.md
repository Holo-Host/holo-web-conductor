# Step 25: Linker Record Response Format Fix - Completion Notes

**Status**: Complete

## Problem

`get_thing(actionHash)` returned null for records created by another agent. The linker's `GET /dht/{dna}/record/{hash}` endpoint returned WireOps format (`{ "Record": { "action": { "data": [...], "status": "Valid" }, ... } }`) but the extension's `parseRecordResponse` expected flat Record format (`{ "signed_action": ..., "entry": ... }`).

Links worked because the linker already had `wire_link_ops_to_links()` converting WireLinkOps to flat format. Records had no equivalent conversion.

## Fix

**Linker side** (h2hc-linker commit `d4e8e52`, 2026-02-23):

Added two conversion functions in `src/routes/dht.rs`:
- `wire_ops_to_record_json()` (line 427) — entry point called by the GET endpoint
- `wire_record_ops_to_record()` (line 439) — extracts SignedActionHashed and Entry from WireRecordOps, returns flat Record struct

The GET endpoint now calls `wire_ops_to_record_json(&wire_ops)` before returning JSON.

**Extension side**: No changes needed. `parseRecordResponse()` in `packages/extension/src/offscreen/ribosome-worker.ts:1086` already expected the correct flat format.

## Test Coverage

- Unit tests in `h2hc-linker/src/routes/dht.rs` (lines 930-974):
  - `test_wire_record_ops_to_record_basic` — verifies flat Record structure
  - `test_wire_record_ops_to_record_no_action_returns_null` — edge case
- Multi-agent ziptest e2e confirmed cross-agent record fetches work

## Files Modified

| Repo | File | Change |
|------|------|--------|
| h2hc-linker | `src/routes/dht.rs` | Added `wire_ops_to_record_json()`, `wire_record_ops_to_record()`, unit tests |

# ROOT CAUSE HYPOTHESIS

## The Bug

**Location**: `packages/extension/src/background/index.ts` lines 390-394

```typescript
// Encode the arguments to msgpack bytes
const argBytes = new Uint8Array(encode(normalizedPayload));

// ExternIO expects the payload as a byte array, so encode the bytes again as Uint8Array
const payloadBytes = new Uint8Array(encode(argBytes));  // ← BUG: DOUBLE ENCODING
```

## The Problem

We're **double-encoding the zome call payload** when we should only encode it once.

### What Happens Now (BROKEN)

For `get_test_entry(actionHash)` where actionHash is Uint8Array(39):

1. Web page sends: `Uint8Array(39)` - the hash bytes
2. Chrome converts to object: `{"0": 132, "1": 41, ...}`
3. `normalizeUint8Arrays()` → `Uint8Array(39)` ✅ (correct)
4. **First encode**: `encode(Uint8Array(39))` → 41 bytes: `[196, 39, 132, 41, ...]`
   - `196, 39` = bin8 marker + length
   - Next 39 bytes = hash data
5. **Second encode** ❌ (BUG!): `encode(Uint8Array(41))` → 43 bytes: `[196, 41, 196, 39, 132, 41, ...]`
   - Wraps the already-encoded data in ANOTHER bin8!
6. WASM receives 43 bytes
7. HDK #[hdk_extern] macro:
   - Expects bytes to be ExternIO-wrapped msgpack
   - Deserializes outer layer → gets `Uint8Array(41)` containing `[196, 39, 132, 41, ...]`
   - Tries to deserialize THAT as `ActionHash`
   - ActionHash expects raw 39 bytes, but gets 41 bytes starting with bin8 marker!
8. **Error**: `HoloHash error: BadSize(expected 39 got 41)`

### What Should Happen (CORRECT)

1. Web page sends: `Uint8Array(39)` - the hash bytes
2. Chrome converts to object (unavoidable)
3. `normalizeUint8Arrays()` → `Uint8Array(39)`
4. **Single encode**: `encode(Uint8Array(39))` → 41 bytes
5. WASM receives 41 bytes
6. HDK #[hdk_extern] macro:
   - Deserializes as ExternIO → gets the msgpack bytes
   - Deserializes THOSE as `ActionHash`
   - Gets `Uint8Array(39)` from the bin8 format ✅
7. **Success**: ActionHash is exactly 39 bytes!

## Why This Confusion Happened

**ExternIO double-encoding is needed for HOST FUNCTION RETURNS, not ZOME CALL INPUTS!**

### Host Function Returns (Needs Double Encoding)
1. Host function has: `{Ok: ActionHash}`
2. We serialize: `encode({Ok: ActionHash})` → 45 bytes
3. We write to WASM memory
4. WASM reads and processes
5. WASM returns via ExternIO → adds outer wrapper → 47 bytes
6. **This is correct!**

### Zome Call Inputs (Needs Single Encoding)
1. Web page has: `ActionHash` (parameter value)
2. We should: `encode(ActionHash)` → 41 bytes (ONE encoding)
3. Write to WASM memory
4. WASM's ExternIO wrapper is implicit (the bytes ARE the ExternIO payload)
5. HDK deserializes the msgpack bytes
6. **This is what we should do!**

## The Fix

**File**: `packages/extension/src/background/index.ts`

**Change**:
```typescript
// BEFORE (double encoding):
const normalizedPayload = normalizeUint8Arrays(payload);
const argBytes = new Uint8Array(encode(normalizedPayload));
const payloadBytes = new Uint8Array(encode(argBytes));  // REMOVE THIS LINE

// AFTER (single encoding):
const normalizedPayload = normalizeUint8Arrays(payload);
const payloadBytes = new Uint8Array(encode(normalizedPayload));  // Just one encode!
console.log(`[CallZome] Encoded payload: ${payloadBytes.length} bytes`);
```

## Why @msgpack/msgpack Was Never The Problem

Our byte-level comparison proved that @msgpack/msgpack produces IDENTICAL bytes to holochain_serialized_bytes.

The issue was never the encoding library - it was using the encoding correctly!

## Expected Outcome After Fix

✅ `create_test_entry("test")` will work - string encodes correctly
✅ `get_test_entry(actionHash)` will work - ActionHash is exactly 39 bytes
✅ All 7 test zome functions will pass
✅ No more "BadSize" errors

## Verification

After fix, the logs should show:
- **Before**: `get_test_entry` receives Uint8Array(41) starting with `[196, 39, ...]`
- **After**: `get_test_entry` receives Uint8Array(39) starting with `[132, 41, 36, ...]` (the actual hash)

## Related Documentation

This matches exactly what the "Failed Solutions Archive" said NOT to do:
- ❌ "Failed Solution #2: Removing Double-Encoding" - Because we were removing it from the WRONG place!

The double-encoding should be removed from ZOME CALL INPUTS, but kept for HOST FUNCTION RETURNS!

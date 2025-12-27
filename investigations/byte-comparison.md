# Byte-Level Comparison - Holochain vs Fishy

## Executive Summary

✅ **@msgpack/msgpack produces IDENTICAL bytes to holochain_serialized_bytes**
✅ **Library compatibility is NOT the issue**
⚠️ **The bug must be in how we use the encoding, not the encoding itself**

## Test Case 1: Result<ActionHash>

### Holochain Reference (Rust)
```
Length: 45 bytes
Hex: 81a24f6bc427842924810a8c974214c66be3f4dcaf85f470e9708cd391b0b68d4d89d5a01a7a2352e89fb24de3
Dec: [129, 162, 79, 107, 196, 39, 132, 41, 36, 129, 10, 140, 151, 66, 20, 198, 107, 227, 244, 220, 175, 133, 244, 112, 233, 112, 140, 211, 145, 176, 182, 141, 77, 137, 213, 160, 26, 122, 35, 82, 232, 159, 178, 77, 227]
```

### Fishy Current (TypeScript)
```
Length: 45 bytes
Hex: 81a24f6bc427842924810a8c974214c66be3f4dcaf85f470e9708cd391b0b68d4d89d5a01a7a2352e89fb24de3
Dec: [129, 162, 79, 107, 196, 39, 132, 41, 36, 129, 10, 140, 151, 66, 20, 198, 107, 227, 244, 220, 175, 133, 244, 112, 233, 112, 140, 211, 145, 176, 182, 141, 77, 137, 213, 160, 26, 122, 35, 82, 232, 159, 178, 77, 227]
```

### Analysis
✅ **PERFECT BYTE-FOR-BYTE MATCH**

Structure breakdown:
- `129` (0x81) = fixmap with 1 element
- `162, 79, 107` (0xa2, 'O', 'k') = fixstr "Ok"
- `196, 39` (0xc4, 0x27) = bin8 format, 39 bytes
- Next 39 bytes = ActionHash data

**Conclusion**: @msgpack/msgpack encodes `{Ok: Uint8Array(39)}` IDENTICALLY to holochain_serialized_bytes

## Test Case 2: ExternIO Format (Double Encoding)

### Holochain Reference (Rust)
ExternIO serialized:
```
Length: 47 bytes
Hex: c42d81a24f6bc427842924810a8c974214c66be3f4dcaf85f470e9708cd391b0b68d4d89d5a01a7a2352e89fb24de3
Dec: [196, 45, 129, 162, 79, 107, 196, 39, 132, 41, 36, 129, 10, 140, 151, 66, 20, 198, 107, 227, 244, 220, 175, 133, 244, 112, 233, 112, 140, 211, 145, 176, 182, 141, 77, 137, 213, 160, 26, 122, 35, 82, 232, 159, 178, 77, 227]
```

### Fishy Current (TypeScript)
Second encoding:
```
Length: 47 bytes
Hex: c42d81a24f6bc427842924810a8c974214c66be3f4dcaf85f470e9708cd391b0b68d4d89d5a01a7a2352e89fb24de3
Dec: [196, 45, 129, 162, 79, 107, 196, 39, 132, 41, 36, 129, 10, 140, 151, 66, 20, 198, 107, 227, 244, 220, 175, 133, 244, 112, 233, 112, 140, 211, 145, 176, 182, 141, 77, 137, 213, 160, 26, 122, 35, 82, 232, 159, 178, 77, 227]
```

### Analysis
✅ **PERFECT BYTE-FOR-BYTE MATCH**

Structure breakdown:
- `196, 45` (0xc4, 0x2d) = bin8 format, 45 bytes
- Next 45 bytes = the entire Result<ActionHash> encoding

**Conclusion**: The ExternIO double-encoding pattern is IDENTICAL between Rust and TypeScript

## Test Case 3: Raw ActionHash (No Result Wrapper)

### Holochain Reference (Rust)
```
Length: 41 bytes
Hex: c427842924810a8c974214c66be3f4dcaf85f470e9708cd391b0b68d4d89d5a01a7a2352e89fb24de3
Dec: [196, 39, 132, 41, 36, 129, 10, 140, 151, 66, 20, 198, 107, 227, 244, 220, 175, 133, 244, 112, 233, 112, 140, 211, 145, 176, 182, 141, 77, 137, 213, 160, 26, 122, 35, 82, 232, 159, 178, 77, 227]
```

### Fishy Current (TypeScript)
```
Length: 41 bytes
Hex: c427842924810a8c974214c66be3f4dcaf85f470e9708cd391b0b68d4d89d5a01a7a2352e89fb24de3
Dec: [196, 39, 132, 41, 36, 129, 10, 140, 151, 66, 20, 198, 107, 227, 244, 220, 175, 133, 244, 112, 233, 112, 140, 211, 145, 176, 182, 141, 77, 137, 213, 160, 26, 122, 35, 82, 232, 159, 178, 77, 227]
```

### Analysis
✅ **PERFECT BYTE-FOR-BYTE MATCH**

Structure breakdown:
- `196, 39` (0xc4, 0x27) = bin8 format, 39 bytes
- Next 39 bytes = ActionHash data

**Note**: ActionHash WITH `#[serde(with = "serde_bytes")]` serializes to 41 bytes (bin8 marker + length + data)

## Key Findings

1. **@msgpack/msgpack is 100% compatible with holochain_serialized_bytes**
   - All byte sequences match exactly
   - Both handle Uint8Array as msgpack bin8 format correctly
   - No codec differences whatsoever

2. **Double-encoding pattern is correct**
   - ExternIO requires wrapping msgpack bytes in another bin8 wrapper
   - This is the expected behavior, not a bug

3. **msgpack-bridge WASM module is NOT necessary**
   - @msgpack/msgpack produces identical results
   - No need for the complexity of Rust-based encoder

4. **The bug is NOT in encoding libraries**
   - Must be in HOW we apply encoding/decoding
   - Either wrong data structure or wrong encoding flow

## Problem Reframing

Original hypothesis: "Double-encoding causes issues"
**DISPROVEN**: Double-encoding produces correct 47-byte ExternIO format

Original hypothesis: "@msgpack/msgpack incompatible with rmp-serde"
**DISPROVEN**: Produces identical bytes for all test cases

**New question**: If our encoding libraries are correct, where is the actual bug?

Observations from test runs:
- We send 45 bytes to WASM (host function return)
- WASM returns 47 bytes (zome function result)
- Result contains `{Ok: Uint8Array(41)}` instead of `{Ok: Uint8Array(39)}`

**Hypothesis to investigate**:
The issue may be in:
1. How we construct the payload for zome calls (calling INTO wasm)
2. How WASM deserializes/re-serializes on return
3. Some mismatch in the ExternIO double-encoding between direction flows

## Next Steps

1. Add detailed logging to see EXACT bytes at each step
2. Compare zome call INPUT encoding vs host function RETURN encoding
3. Investigate if there's an asymmetry in our encoding/decoding pipeline
4. Check if the issue is specific to binary data in parameters vs return values

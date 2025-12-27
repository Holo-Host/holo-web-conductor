# Serialization Investigation

## Purpose

This directory contains byte-level investigation into MessagePack serialization compatibility between Fishy's TypeScript implementation and Holochain's Rust implementation.

## Problem Being Investigated

- **Symptom**: Binary data (ActionHash) appearing as 41 bytes instead of 39 bytes
- **Root Cause**: Unknown - investigating if it's library incompatibility or usage error

## Investigation Methodology

1. **Create Rust Reference** (`serialization-test-rust/`) - Generate exact byte sequences that Holochain produces
2. **Create TypeScript Test** (`serialization-test-ts.ts`) - Generate byte sequences from our implementation
3. **Byte-Level Comparison** (`byte-comparison.md`) - Compare outputs byte-for-byte
4. **Form Hypothesis** - Based on actual data, not assumptions
5. **Implement Fix** - Targeted change based on evidence

## Key Findings

### ✅ @msgpack/msgpack is 100% Compatible

Byte-for-byte comparison shows **PERFECT MATCH** between:
- `@msgpack/msgpack` v3.0.0 (TypeScript)
- `holochain_serialized_bytes` v0.0.56 (Rust/rmp-serde)

Test Cases:
- ✅ `Result<ActionHash>` - 45 bytes - IDENTICAL
- ✅ `ExternIO format` (double encoding) - 47 bytes - IDENTICAL
- ✅ `Raw ActionHash` - 41 bytes - IDENTICAL

**Conclusion**: Library compatibility is NOT the issue.

###  Double-Encoding is Correct

ExternIO format requires wrapping msgpack bytes in another msgpack bin8 wrapper:
1. Encode data → msgpack bytes (e.g., 45 bytes)
2. Wrap in ExternIO → adds bin8 marker (→ 47 bytes)

This is the EXPECTED behavior, not a bug.

### ❌ msgpack-bridge WASM Module Not Necessary

Since @msgpack/msgpack produces identical results to holochain_serialized_bytes, the Rust-based WASM encoder adds unnecessary complexity without benefit.

## Next Steps

1. **Switch back to @msgpack/msgpack** - Simpler, proven to work
2. **Investigate usage patterns** - The bug is in HOW we encode/decode, not WHAT library we use
3. **Add comprehensive logging** - Trace exact byte flow through the system
4. **Fix the actual issue** - Based on logging evidence

## Files in This Directory

- `serialization-test-rust/` - Rust reference program using Holochain crates
- `serialization-test-ts.ts` - TypeScript test using @msgpack/msgpack
- `rust-reference-bytes.txt` - Output from Rust program
- `typescript-current-bytes.txt` - Output from TypeScript program
- `byte-comparison.md` - Detailed analysis and findings
- `README.md` - This file

## Reproducing the Investigation

### Rust Reference
```bash
cd serialization-test-rust
cargo run > ../rust-reference-bytes.txt
```

### TypeScript Test
```bash
npx tsx serialization-test-ts.ts > typescript-current-bytes.txt
```

## Lessons Learned

1. **Measure before assuming** - We assumed library incompatibility without proof
2. **Byte-level comparison is essential** - Only way to know for certain
3. **Simplicity wins** - @msgpack/msgpack works perfectly, no need for WASM bridge
4. **Failed solutions documented** - See `../../claude.md` Failed Solutions Archive

## Date

Investigation conducted: December 27, 2025

# Lessons Learned: Serialization Debugging

> **Purpose**: This document captures hard-won lessons from debugging serialization issues in the Fishy project. It documents failed approaches, root cause analysis, and testing strategies to prevent repeating mistakes across sessions.

---

## Table of Contents

- [Meta-Lesson: Debugging the Wrong Layer](#meta-lesson-debugging-the-wrong-layer)
- [Failed Solutions Archive](#failed-solutions-archive)
- [Serialization Testing Strategy](#serialization-testing-strategy)
- [Development Patterns Analysis](#development-patterns-analysis)

---

## Meta-Lesson: Debugging the Wrong Layer

### The Fundamental Error

**What I Did Wrong**: Spent hours debugging serialization **at the WASM boundary** (ExternIO, msgpack encoding, codec compatibility) when the actual problem was **deserialization at the UI boundary** (msgpack decoding, Chrome message passing).

### The Symptom

Binary data (Uint8Array/ActionHash) appeared to be "double-encoded" - wrapped in extra bin8 layers, causing deserialization failures in WASM.

### Failed Approaches (Hours Wasted)

1. **Built msgpack-bridge WASM module** - Thought the issue was @msgpack/msgpack vs rmp-serde incompatibility
2. **Tried ExternIO double-encoding patterns** - Assumed we needed to match Holochain's ExternIO wrapper format
3. **Removed Result wrappers** - Thought the `{Ok: data}` wrapper was causing double-encoding
4. **Added double-decode workarounds** - Band-aid solutions that didn't address root cause
5. **Focused on encoding parameters** - Spent time on data going INTO WASM, ignored results coming OUT

### The Actual Fix (Commit 5cfe67e)

Added **msgpack decoding in the background script** before sending results to UI:

```typescript
// Before: Send raw msgpack bytes (or improperly decoded data)
return createSuccessResponse(message.id, unwrappedResult);

// After: Decode msgpack THEN send
const decodedResult = decodeResult(unwrappedResult);  // ← THIS WAS MISSING
const transportSafeResult = serializeForTransport(decodedResult);
return createSuccessResponse(message.id, transportSafeResult);
```

### Root Cause

**WASM returns msgpack-encoded bytes**. Without explicit decoding in the background script:
- The UI received raw bytes that couldn't be used
- Chrome's message passing objectified the bytes unpredictably
- Type information was lost
- The data pipeline was broken before it ever reached the encoding side I was debugging

### The Lesson

**I was debugging the wrong layer entirely.**

I was fixated on:
- ❌ How to encode parameters going TO WASM
- ❌ ExternIO format contracts
- ❌ Codec compatibility (JavaScript msgpack vs Rust rmp-serde)

I completely missed:
- ✅ Results from WASM needed explicit msgpack decoding
- ✅ The UI boundary was where the problem manifested
- ✅ Chrome message passing required special handling (Uint8Array → Array)

### Key Insight

**Encoding Tunnel Vision**: When debugging serialization, it's easy to focus exclusively on the encoding side (how data is prepared) while ignoring the decoding side (how data is processed after receipt). The bug was not in how we encoded data, but in **failing to decode results before forwarding them**.

### Prevention

Before spending hours on encoding debugging:

1. **Trace the full data flow**: Input → Encode → WASM → Decode → Transport → UI
2. **Verify each boundary**: Is data properly decoded at each step?
3. **Check the simple stuff first**: Are we calling decode() where needed?
4. **Don't assume complexity**: The fix might be adding one missing function call

---

## Failed Solutions Archive

> **Purpose**: Documents serialization solutions that have been attempted and FAILED. Do NOT retry these approaches without a fundamentally different understanding of the root cause.

### Problem Statement

**Symptom**: Binary data (Uint8Array/ActionHash) returned from host functions gets double-encoded:
- Input: `{Ok: Uint8Array(39)}` → Serialized to 45 bytes with format `bin8(39, [hash])`
- WASM output: 47 bytes with format `bin8(41, bin8(39, [hash]))`
- The inner `bin8(39)` wrapper gets re-wrapped in `bin8(41)`
- Rust receives `[196, 39, ...]` (msgpack bin8 marker) instead of hash bytes

**Root Cause (Current Understanding)**: The ExternIO double-encoding pattern in background/index.ts:
```javascript
// First encode: parameter → msgpack bytes
const paramBytes = new Uint8Array(encode(normalizedPayload));
// Second encode: bytes → msgpack binary (wraps in another bin8)
const payloadBytes = new Uint8Array(encode(paramBytes));
```

### ❌ Failed Solution #1: msgpack-bridge WASM Module

**Attempted**: Built a separate WASM-based serialization bridge using Rust's `rmpv` library to ensure bit-for-bit compatibility with Holochain's msgpack encoding.

**Why It Failed**:
- Created `packages/msgpack-bridge/` with Rust codec using `rmpv` 1.3 (same version as Holochain)
- Compiled to WASM with wasm-pack
- Added initialization complexity for service workers
- **Result**: The double-encoding issue persisted even with Rust codec
- **Root Cause Not Addressed**: Using the same codec doesn't solve the ExternIO wrapping pattern issue

**Commit**: 77fab6a - "feat: add serialization bridge solutions (broken)"

**Lessons Learned**:
- The issue is NOT codec incompatibility between @msgpack/msgpack and rmp-serde
- The issue is NOT about which library does the encoding
- The issue IS about how data is wrapped/unwrapped for ExternIO format

### ❌ Failed Solution #2: Removing Double-Encoding

**Attempted**: Removed the second `encode()` call to eliminate double-wrapping.

**Why It Failed**:
- WASM expects ExternIO format which requires specific byte wrapping
- Removing the wrapper breaks the calling convention
- HDK on the WASM side expects a specific format

**Lessons Learned**:
- Cannot arbitrarily change the ExternIO format without coordinating with WASM-side expectations
- The HDK and host function interface has a contract that must be honored

### ❌ Failed Solution #3: Converting Uint8Arrays to Plain Arrays

**Attempted**: Convert Uint8Array to regular JavaScript arrays before encoding to avoid msgpack binary type.

**Why It Failed**:
- msgpack treats arrays differently than binary data
- Resulted in different encoding format that WASM couldn't parse
- Lost semantic meaning of "this is binary data"

**Lessons Learned**:
- Type semantics matter - binary data vs array of numbers are different
- msgpack format must match what Rust's serde expects

### ❌ Failed Solution #4: Double-Decode Workaround

**Attempted**: Add extra decode step on the receiving end to unwrap double-encoded data.

**Why It Failed**:
- Band-aid solution that doesn't address root cause
- Breaks for data that's correctly single-encoded
- Creates asymmetry in the serialization pipeline

**Lessons Learned**:
- Workarounds create more complexity than they solve
- Need to fix the encoding side, not add hacks on decoding side

### ❌ Failed Solution #5: Removing Result Wrapper from serializeResult (Attempted 3+ Times)

**Attempted**: Modified `serializeResult()` in `packages/core/src/ribosome/serialization.ts` to return raw data instead of wrapping in `{Ok: data}`.

**Original code**:
```typescript
export function serializeResult(
  instance: WebAssembly.Instance,
  data: unknown
): bigint {
  // Wrap in Result::Ok - HDK expects Result<T, WasmError>
  const result = { Ok: data };
  const { ptr, len } = serializeToWasm(instance, result);
  return createI64Result(ptr, len);
}
```

**Failed change**:
```typescript
export function serializeResult(
  instance: WebAssembly.Instance,
  data: unknown
): bigint {
  // WRONG: Removed wrapper, serialized raw data
  const { ptr, len } = serializeToWasm(instance, data);
  return createI64Result(ptr, len);
}
```

**Why It Was Proposed**:
- Byte-level analysis (investigations/byte-comparison.md) showed double-wrapping occurs: `bin8(41, bin8(39, hash))`
- Logical reasoning: "If data gets double-wrapped, remove one wrapper layer"
- Observation: Host function returns `{Ok: Uint8Array(39)}` → 45 bytes, but WASM outputs 47 bytes with extra wrapper
- Assumption: The {Ok: ...} wrapper at the host function level causes the double-wrapping

**Why It Failed**:
- **HDK explicitly requires Result<T, WasmError> from host functions**
- Error message when attempted: `"invalid type: sequence, expected \`Ok\` or \`Err\`"`
- ALL 7 zome test functions fail immediately with deserialization errors
- The WASM guest code expects to deserialize Result types from host function returns
- This is part of the Holochain host function contract - host functions MUST return Result

**Evidence from Holochain Source**:
- Host functions in Holochain conductor return `Result<T, WasmError>`
- HDK's host function imports expect Result wrapper
- The ribosome deserializes host function returns as Result types

**Commit (Reverted)**: cb0776c - "WIP: Step 5.5 - msgpack serialization double-encoding issue"

**Lessons Learned**:
- **The {Ok: ...} wrapper is NOT optional** - it's a required part of the host function contract
- Logical reasoning about "remove one wrapper" fails because it ignores protocol requirements
- The double-wrapping issue must be solved WHILE maintaining the Result wrapper
- This solution has been attempted **at least 3 times** across multiple sessions, proving the need for this archive
- The byte-level analysis proved the encoding libraries are correct, so the issue is in the data flow, not the wrapper itself

### ❌ Failed Solution #6: ExternIO Double-Encoding for WASM Boundary

**Attempted**: Implemented ExternIO-style double-encoding/decoding based on Holochain's ExternIO type:
- Added `serializeExternIO()` and `deserializeExternIO()` helper functions
- Double-encode: `encode(encode(data))` to create `bin8([msgpack bytes])`
- Double-decode: `decode(decode(bytes))` to unwrap `bin8` then decode inner msgpack
- Applied to various WASM boundary crossings (zome inputs, outputs, host function returns)

**Why It Was Proposed**:
- Found ExternIO in Holochain source: `#[serde(with = "serde_bytes")]` wraps Vec<u8> in msgpack bin8
- ExternIO::encode() does: data → msgpack → Vec<u8> → serialize → bin8 wrapper
- Assumed this pattern applied to all WASM boundary crossings
- Logs showed zome functions returning 47 bytes (potential bin8 wrapper)

**Why It Failed**:
1. **Zome function inputs**: Applied ExternIO double-encoding, got "Offset is outside the bounds of the DataView"
   - Error indicated WASM not expecting double-encoded input
   - Reverted to single encoding (plain msgpack)

2. **Host function returns**: Applied ExternIO double-encoding, got WASM error:
   ```
   bytes = [196, 98, 129, 162, 79, 107, ...]
   Deserialize("invalid value: byte array, expected `Ok` or `Err`")
   ```
   - WASM saw bin8 (byte array) when expecting map (Result type)
   - HDK expects to deserialize Result directly, not unwrap bin8 first
   - Reverted to single encoding

3. **Zome function outputs**: Applied ExternIO double-decoding, got "Offset is outside the bounds of the DataView"
   - Indicates zome functions NOT returning ExternIO-wrapped data
   - Reverted to single decoding

**Evidence**:
- Testing showed only plain msgpack works (no ExternIO at any boundary)
- 6/7 test functions work with plain msgpack
- Only `get_test_entry` fails, but with different error (BadSize, not ExternIO-related)

**Commits**:
- ExternIO implementation: (uncommitted, reverted)
- Helper functions remain in serialization.ts but unused

**Lessons Learned**:
- ExternIO is NOT used at the WASM boundaries we're implementing
- ExternIO may be specific to certain Holochain contexts (conductor ↔ WASM) not applicable here
- The test zome may be compiled without ExternIO expectations
- Cannot assume Holochain source code patterns apply without testing
- "Offset is outside the bounds of the DataView" = strong signal of wrong encoding approach
- WASM error messages about deserialize types are diagnostic: "expected X, got Y" reveals format mismatch

**Correct Approach**:
- Zome inputs: Plain msgpack (single encode)
- Zome outputs: Plain msgpack (single decode)
- Host function inputs: Plain msgpack (single decode)
- Host function returns: Plain msgpack {Ok: data} (single encode)

**Remaining Issue**:
The original double-wrapping problem persists - `create_test_entry` returns Uint8Array(41) with bin8 wrapper instead of Uint8Array(39) raw hash. This is NOT solved by ExternIO approach.

### 🔍 What We Know Works

1. **Simple types** (numbers, strings, booleans, objects with primitives) serialize correctly
2. **Chrome message passing normalization** (normalizeUint8Arrays) correctly handles Uint8Array → object conversion
3. **msgpack round-trip** for non-binary data works fine
4. **WASM compilation and execution** works correctly
5. **Host function registry** and calling mechanism works

### 🔍 What Doesn't Work

1. **Binary data in host function returns** - Gets double-encoded when returning ActionHash/EntryHash
2. **Nested Uint8Arrays** - When wrapped in Result types like `{Ok: Uint8Array}`

### 📚 ExternIO Deep Dive - THE ACTUAL CONTRACT

**Source**: `/home/eric/code/metacurrency/holochain/holochain/crates/holochain_integrity_types/src/zome_io.rs`

ExternIO is Holochain's boundary type for all data crossing the WASM boundary:

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(transparent)]
#[repr(transparent)]
pub struct ExternIO(#[serde(with = "serde_bytes")] pub Vec<u8>);

impl ExternIO {
    pub fn encode<I>(input: I) -> Result<Self, SerializedBytesError>
    where I: serde::Serialize + std::fmt::Debug,
    {
        Ok(Self(holochain_serialized_bytes::encode(&input)?))
    }

    pub fn decode<O>(&self) -> Result<O, SerializedBytesError>
    where O: serde::de::DeserializeOwned + std::fmt::Debug,
    {
        holochain_serialized_bytes::decode(&self.0)
    }
}
```

**KEY INSIGHTS**:

1. **`#[serde(with = "serde_bytes")]`** - This annotation tells serde to treat the Vec<u8> as raw bytes, NOT as a sequence
   - When serialized with msgpack, it becomes `bin8`/`bin16`/`bin32` format
   - When deserialized, it expects msgpack binary format

2. **ExternIO.encode() ALREADY does msgpack encoding** - The input data gets msgpack-encoded into bytes, then wrapped in ExternIO

3. **The Double-Encoding Pattern IS INTENTIONAL**:
   ```
   Data (e.g., ActionHash)
     → msgpack encode (inside ExternIO.encode())
     → Vec<u8> bytes
     → ExternIO(Vec<u8>)
     → msgpack encode again (when ExternIO itself is serialized)
     → msgpack bin8 wrapper around the inner msgpack bytes
   ```

4. **On the WASM side**, when a function returns `ExternIO`:
   - The return value is ALREADY msgpack-encoded data wrapped in ExternIO
   - The ExternIO itself gets serialized as msgpack binary
   - The host receives: `bin8(length, [inner_msgpack_bytes])`

5. **For zome calls INPUT**:
   - Web-page calls with payload (e.g., `{foo: "bar"}`)
   - Extension should: `ExternIO.encode(payload)` equivalent in TypeScript
   - This means: `encode(payload)` → bytes → then wrap those bytes as msgpack binary

6. **For host function RETURN values**:
   - Host function has data (e.g., `{Ok: ActionHash}`)
   - Host must: `ExternIO.encode(data)` equivalent
   - Return to WASM as i64 (pointer + length)
   - WASM receives msgpack bytes that it can decode

**THE CRITICAL QUESTION**: Is our TypeScript implementation correctly mimicking ExternIO's double-encoding?

Current implementation in `background/index.ts`:
```javascript
// Encode the zome parameter
const paramBytes = new Uint8Array(encode(normalizedPayload));
// Wrap in ExternIO format by encoding the bytes again
const payloadBytes = new Uint8Array(encode(paramBytes));
```

**Potential Issue**: The second `encode(paramBytes)` treats the Uint8Array as msgpack binary type, but does it match exactly what `#[serde(with = "serde_bytes")]` produces?

**Test This**: Compare byte-for-byte:
1. Rust: `ExternIO::encode(data)` → serialize → what bytes?
2. TypeScript: `encode(encode(data))` → what bytes?
3. Do they match?

### 🧬 Meta-Analysis: The msgpack-bridge Back-and-Forth

**WHY does the msgpack-bridge keep being reconsidered, then rejected, then reconsidered again?**

This pattern reveals a deeper issue with how Claude approaches the problem:

**The Loop**:
1. Claude sees double-encoding issue
2. Claude suspects @msgpack/msgpack vs rmp-serde incompatibility
3. Claude builds msgpack-bridge WASM module using Rust's rmpv
4. Claude tests and sees problem persists
5. Claude realizes it's not about the codec
6. Claude reverts to @msgpack/msgpack
7. **[Time passes, new session starts]**
8. Claude sees double-encoding issue again...
9. **GOTO step 2** (loop!)

**Root Cause of the Loop**:
- **Symptom focus** instead of understanding the protocol
- **Assumption** that matching Rust's library = matching behavior
- **Missing**: Deep understanding of ExternIO contract (now documented above!)
- **Missing**: Byte-level comparison of what Holochain actually produces vs what we produce

**The msgpack-bridge IS technically correct** - using rmpv WILL produce identical bytes to Holochain for the SAME operations. But:
- The complexity of WASM initialization in service workers is HIGH
- The debugging is HARDER (binary WASM vs readable TypeScript)
- **IT DOESN'T SOLVE THE ROOT ISSUE** which is about understanding the ExternIO protocol

**When to Consider msgpack-bridge**:
✅ **YES** - If byte-level testing proves @msgpack/msgpack produces different bytes than rmpv for the same input
✅ **YES** - If we find edge cases where JavaScript msgpack != Rust msgpack (e.g., handling of Map vs Object)

❌ **NO** - If we haven't done byte-level comparison first
❌ **NO** - If we don't understand what ExternIO expects
❌ **NO** - As a first attempt before understanding the protocol

**Decision Framework for Future Sessions**:

Before considering msgpack-bridge again, MUST complete this checklist:
- [ ] Have we documented the exact bytes Holochain produces for test cases?
- [ ] Have we documented the exact bytes our TypeScript produces?
- [ ] Do the bytes differ? If YES, where exactly?
- [ ] Have we tested with actual Holochain WASM to see what it expects/produces?
- [ ] Can we explain WHY the bytes differ (not just that they do)?
- [ ] Have we tried adjusting the TypeScript encoding to match?
- [ ] Have we exhausted simpler solutions?

**ONLY AFTER** answering these questions should msgpack-bridge be reconsidered.

**The Real Solution Likely Involves**:
- Understanding how Holochain's HDK expects data formatted
- Matching the exact byte sequence for ExternIO serialization
- Potentially adjusting how we handle Uint8Array in TypeScript
- NOT necessarily using the same Rust library

### 🎯 Next Steps Guidance

Before attempting a new solution, ensure you can answer:
1. **Why did the previous approaches fail?** (Understand root cause, not symptoms)
2. **What is the ExternIO format contract?** ✅ NOW DOCUMENTED ABOVE
3. **How does Holochain's conductor handle this?** (Study real_ribosome.rs implementation)
4. **What does the HDK expect to receive?** (Trace the WASM-side code)
5. **Does TypeScript's msgpack.encode(Uint8Array) produce the same bytes as Rust's `#[serde(with = "serde_bytes")]`?**

**Required Testing**:
- Create a test Rust program that serializes ExternIO with different payloads
- Capture the exact bytes produced
- Compare with TypeScript implementation byte-for-byte
- Test specifically with `{Ok: Uint8Array(39)}` (ActionHash)

**DO NOT**:
- Retry msgpack version changes without understanding ExternIO contract ✅ NOW UNDERSTOOD
- Add more encoding/decoding layers without fixing root cause
- Assume the issue is codec compatibility
- Make changes without comprehensive logging to compare byte sequences

---

## Serialization Testing Strategy

### Overview

Serialization bugs are notoriously difficult because:
- Small byte differences cause failures
- Errors manifest far from the root cause
- "Works in tests, fails in production" scenarios

This testing strategy ensures serialization changes are validated thoroughly.

### Level 1: Unit Tests (Already Implemented)

**Location**: `packages/core/src/ribosome/serialization.test.ts` (21 tests)

**Coverage**:
- Round-trip encoding/decoding for primitive types
- Uint8Array handling
- WASM memory operations (read/write)
- Result type wrapping `{Ok: T}` and `{Err: E}`

**When to Run**: After ANY change to serialization.ts
**Expected**: ALL 21 tests must pass

### Level 2: Byte-Level Comparison Tests (NEEDS IMPLEMENTATION)

**Purpose**: Verify our TypeScript produces identical bytes to Holochain's Rust

**Implementation Approach**:

1. **Create Rust test program** (`test-serialization/src/main.rs`):
   ```rust
   use holochain_integrity_types::prelude::*;
   use holochain_serialized_bytes::prelude::*;

   fn main() {
       // Test case 1: Simple object
       let data = json!({"foo": "bar"});
       let extern_io = ExternIO::encode(&data).unwrap();
       let bytes = rmp_serde::to_vec(&extern_io).unwrap();
       println!("TEST_CASE_1: {:?}", bytes);

       // Test case 2: ActionHash in Result
       let hash = ActionHash::from_raw_bytes(vec![0u8; 39]);
       let result: Result<ActionHash, ()> = Ok(hash);
       let extern_io = ExternIO::encode(&result).unwrap();
       let bytes = rmp_serde::to_vec(&extern_io).unwrap();
       println!("TEST_CASE_2: {:?}", bytes);

       // Test case 3: Nested structure
       // ... more test cases
   }
   ```

2. **Capture Rust output**:
   ```bash
   cargo run > rust-bytes.txt
   ```

3. **Create TypeScript comparison test**:
   ```typescript
   import { encode } from '@msgpack/msgpack';

   describe('Byte-level compatibility with Holochain', () => {
     it('matches Rust for simple object', () => {
       const data = {foo: 'bar'};
       const paramBytes = encode(data);
       const externIOBytes = encode(paramBytes);

       // Expected from Rust test program
       const expected = [196, 131, 161, 102, ...]; // bytes from rust-bytes.txt
       expect(Array.from(externIOBytes)).toEqual(expected);
     });

     it('matches Rust for ActionHash in Result', () => {
       const hash = new Uint8Array(39); // all zeros
       const result = {Ok: hash};
       const paramBytes = encode(result);
       const externIOBytes = encode(paramBytes);

       const expected = [...]; // from TEST_CASE_2
       expect(Array.from(externIOBytes)).toEqual(expected);
     });
   });
   ```

4. **If bytes DON'T match**: Document the differences and investigate why
5. **If bytes DO match**: The issue is elsewhere (not encoding, maybe decoding or WASM interface)

### Level 3: Integration Tests with Real WASM (NEEDS IMPLEMENTATION)

**Purpose**: Verify the entire pipeline works with actual Holochain WASM

**Prerequisites**:
- A simple Holochain zome compiled to WASM
- Zome functions that return ActionHash, EntryHash, etc.

**Test Setup**:
```javascript
// test-zomes/simple/src/lib.rs
use hdk::prelude::*;

#[hdk_extern]
fn get_my_agent() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_latest_pubkey)
}

#[hdk_extern]
fn echo_hash(hash: ActionHash) -> ExternResult<ActionHash> {
    Ok(hash)
}
```

**Compile**:
```bash
cargo build --release --target wasm32-unknown-unknown
```

**Integration Test**:
```typescript
import { callZome } from './ribosome';

describe('Real WASM Integration', () => {
  it('returns AgentPubKey from zome', async () => {
    const result = await callZome({
      dnaHash,
      zomeName: 'simple',
      fnName: 'get_my_agent',
      payload: null,
    });

    expect(result).toHaveProperty('Ok');
    expect(result.Ok).toBeInstanceOf(Uint8Array);
    expect(result.Ok.length).toBe(39);
  });

  it('round-trips ActionHash through zome', async () => {
    const inputHash = new Uint8Array(39).fill(42);
    const result = await callZome({
      dnaHash,
      zomeName: 'simple',
      fnName: 'echo_hash',
      payload: inputHash,
    });

    expect(result.Ok).toEqual(inputHash);
  });
});
```

### Level 4: End-to-End Browser Tests (MANUAL)

**Purpose**: Verify serialization in real browser environment

**Test Page**: `packages/extension/test/wasm-test.html` (already exists)

**Manual Test Cases**:
1. Load extension in Chrome
2. Install hApp with real WASM
3. Call zome function that returns AgentPubKey
4. Verify console shows correct deserialized value (not double-encoded)
5. Call zome function that creates entry and returns ActionHash
6. Verify ActionHash is correct format

### Test-Driven Development Flow

When fixing serialization issues:

1. **Reproduce** - Create a failing test that demonstrates the bug
2. **Isolate** - Determine which level the bug occurs (unit/byte/integration/e2e)
3. **Compare** - If byte-level, compare with Rust output
4. **Fix** - Make minimum change to fix the specific issue
5. **Verify** - All levels of tests pass
6. **Commit** - With clear explanation of what was wrong and how it was fixed

### Debugging Helpers

**Add to serialization.ts**:
```typescript
export function debugEncode(data: any, label: string): Uint8Array {
  console.log(`[${label}] Input:`, data);
  console.log(`[${label}] Input type:`, typeof data, Array.isArray(data) ? 'array' : '');
  const bytes = encode(data);
  console.log(`[${label}] Encoded length:`, bytes.length);
  console.log(`[${label}] First 20 bytes:`, Array.from(bytes.slice(0, 20)));
  console.log(`[${label}] Decoded back:`, decode(bytes));
  return new Uint8Array(bytes);
}
```

**Use in ribosome**:
```typescript
const paramBytes = debugEncode(normalizedPayload, 'PARAM');
const payloadBytes = debugEncode(paramBytes, 'EXTERN_IO');
```

This produces detailed logs for comparing with Rust output.

---

## Development Patterns Analysis

> **Purpose**: This section documents recurring development patterns identified across all STEP*_PLAN.md completion notes. These patterns represent problems that consumed significant debugging time and could be predicted/avoided in future work.

### Pattern 1: Debugging the Wrong Layer

**Evidence**: See [Meta-Lesson](#meta-lesson-debugging-the-wrong-layer) above.

**Summary**: Hours were spent debugging serialization at the WASM boundary (ExternIO, msgpack encoding, codec compatibility) when the actual problem was deserialization at the UI boundary. The fix was a single missing `decodeResult()` call in the background script.

**Prevention**:
- Before deep-diving into any layer, trace the full data flow: Input → Encode → WASM → Decode → Transport → UI
- Verify each boundary has proper handling before assuming any one boundary is the problem
- Check the "simple stuff" first (is decode() being called where needed?)

---

### Pattern 2: Re-attempting Failed Solutions

**Evidence**:
- Result wrapper removal: Attempted 3+ times across sessions, always failing with "invalid type: sequence, expected `Ok` or `Err`"
- msgpack-bridge: Built, tested, failed, reverted, then reconsidered in later sessions
- ExternIO double-encoding: Attempted at multiple boundaries (inputs, outputs, returns), reverted each time

**Summary**: Without documenting failed approaches, the same solutions get retried. Each retry wastes hours before reaching the same conclusion.

**Prevention**:
- When a solution fails, document it immediately in the Failed Solutions Archive with:
  - What was tried
  - Why it failed (exact error messages)
  - Why it seemed like a good idea
  - Why it cannot work
- Before attempting any fix, check LESSONS_LEARNED.md for previous attempts
- A new attempt must differ fundamentally from archived failures

---

### Pattern 3: Protocol/Contract Misunderstanding

**Evidence**:
- STEPS/6_PLAN.md: "Action serialization requires internally tagged enum format with snake_case" - discovered after multiple failures
- LESSONS_LEARNED.md: "HDK explicitly requires Result<T, WasmError> from host functions" - tried removing 3+ times
- STEPS/5.7_PLAN.md: "AgentPubKey requires 39-byte format (32-byte key + 7-byte prefix)" - wrong format caused failures

**Summary**: Assumptions about data formats without verifying against the actual protocol. Many hours spent before realizing Holochain has specific contracts that must be followed exactly.

**Key Contracts (DO NOT VIOLATE)**:
- Host functions MUST return `Result<T, WasmError>` - never remove the `{Ok: data}` wrapper
- Action serialization: internally tagged enum with snake_case fields (`{"type": "create", "author": ...}`)
- AgentPubKey/ActionHash/EntryHash: 39-byte format (Core 32 bytes + 3-byte type prefix + 4-byte location bytes)
- Link structures require all fields populated (base, target, tag, etc.)

**Prevention**:
- Find the canonical source in ../holochain/ codebase before implementing
- Document the exact format contract before writing code
- Create a reference test that verifies format matches Holochain's expectations
- Never assume a wrapper can be removed or format changed without checking HDK requirements

---

### Pattern 4: Measuring After Coding

**Evidence**:
- STEPS/5.5.5_PLAN.md entire approach: "Empirical measurement before code changes... NOT assuming codec incompatibility without proof"
- Multiple codec changes were made without byte-level comparison to see what was actually different
- msgpack-bridge was built based on assumption of codec incompatibility, not measured proof

**Summary**: Jumping to solutions based on symptoms rather than root cause analysis. Making changes without knowing the exact byte differences leads to repeated failed attempts.

**Prevention**:
- Capture exact bytes from the working reference (Holochain/Rust)
- Capture exact bytes from our implementation
- Compare byte-for-byte to identify exact differences
- Only then form a hypothesis about the cause
- Test fix against the byte comparison, not just functional tests

---

### Pattern 5: Chrome Extension Boundary Handling

**Evidence**:
- LESSONS_LEARNED.md: "Chrome message passing required special handling (Uint8Array → Array)"
- STEPS/5_PLAN.md: Message passing serialization requirements
- Actual bug: Chrome's `runtime.sendMessage` converts Uint8Array to `{0: 1, 1: 2, ...}` object

**Summary**: Chrome's message passing API doesn't preserve Uint8Array types - it converts them to plain objects with numeric keys. This caused data corruption that wasn't obvious because the object still "looked like" an array.

**Prevention**:
- All Uint8Array data must be converted to Array before Chrome message passing
- All received data must be normalized back to Uint8Array after message passing
- Test the full background → content script → page pipeline, not just individual parts
- Use `serializeForTransport()` and `normalizeUint8Arrays()` consistently

---

### Pattern 6: Reference Source Priority

**Evidence**:
- STEPS/6.6_PLAN.md: "Use ../holochain/ as canonical source... Web searches can lead to outdated documentation"
- Multiple instances of using web docs that didn't match actual 0.6 implementation
- Time wasted on approaches based on outdated information

**Summary**: Referencing online documentation or web searches led to outdated or incorrect information. The local Holochain repo has the authoritative implementation.

**Prevention**:
Reference sources in priority order:
1. **First**: Local `../holochain/` repository (authoritative for 0.6)
2. **Second**: `holochain-client-js` for TypeScript type patterns
3. **Third**: Official Holochain documentation (may lag behind code)
4. **Avoid**: Web searches for implementation details (often outdated or wrong version)

---

### Pattern 7: Testing Strategy Gaps

**Evidence**:
- STEPS/5.5.5_PLAN.md: "Create automated tests FIRST for fast iteration... Manual browser testing is time-consuming"
- STEPS/6.6_PLAN.md: Three-tier testing strategy recommendation
- Multiple debugging sessions slowed by reliance on manual testing (reload extension, click buttons, read console)

**Summary**: Over-reliance on manual browser testing slowed iteration. Each change took minutes to verify instead of seconds. Automated tests would have caught many issues immediately.

**Prevention**:
Testing priority order:
1. **Unit tests** for individual functions (run in seconds)
2. **Integration tests** with mock WASM (run in seconds)
3. **Byte-level comparison tests** for serialization (validates against Rust reference)
4. **Manual browser testing** ONLY for final verification after automated tests pass

Create the automated test FIRST (test-driven), then implement the fix. Only use manual testing when automated tests pass.

---

### Quick Reference Checklist

Before starting serialization work:
- [ ] Read Failed Solutions Archive in this document
- [ ] Identify exact bytes from Holochain reference (measure first)
- [ ] Check protocol contracts (Result wrapper, field names, byte formats)
- [ ] Verify Chrome boundary handling (Uint8Array ↔ Array)
- [ ] Write automated test before implementing fix

Before any significant debugging:
- [ ] Trace full data flow (Input → Encode → WASM → Decode → Transport → UI)
- [ ] Check each boundary, not just the one you suspect
- [ ] Look for simple missing steps (decode not called, etc.)
- [ ] Reference ../holochain/ not web searches

---

## Documentation Design: Human Lessons vs. Agent Guardrails

> **Purpose**: This section captures what we learned about writing documentation that actually prevents AI agent mistakes, vs. documentation that only explains mistakes after the fact.

### The Problem (2026-02-15)

This document is 792 lines of excellent serialization lessons. It documents 6 failed solutions with exact error messages, root cause analysis, and prevention checklists. It was explicitly referenced in CLAUDE.md: "Check LESSONS_LEARNED.md before serialization work."

Despite all of this, on 2026-02-15 an agent **repeated Failed Solution #2** (removing double-encoding) during a branch integration. It replaced `serializeToWasm()` with raw `wasmAllocate()` + `writeToWasmMemory()` in `validate.ts`, then had to revert after re-deriving the ExternIO contract from first principles by reading `guest.rs`.

The documentation was correct, comprehensive, and available. It failed to prevent the mistake.

### Why It Failed

**1. Trigger condition was too narrow.** CLAUDE.md said "before serialization work." The agent was doing a branch merge. It didn't categorize merge-induced test failures as "serialization work," so it never consulted this document.

**2. Knowledge was story-indexed, not symptom-indexed.** This document organizes by *what was tried* ("Removing Double-Encoding"). The agent needed indexing by *what was observed* (`"expected byte array"` → you broke ExternIO). To use this document, you must already suspect your fix matches a documented failure. But agents don't think "I'm about to try Failed Solution #2" -- they think "I found a bug."

**3. Narratives don't create decision boundaries.** A 200-line narrative explaining why ExternIO double-encoding is intentional teaches understanding. A 1-line invariant ("All data INTO WASM → serializeToWasm(). Never bypass.") prevents action. The document had the narrative but not the invariant.

**4. Lessons were context-bound.** Failures were documented as happening in `serialization.ts`, `background/index.ts`, host function files. When the identical pattern appeared in `validate.ts`, the agent treated it as novel. The lessons described incidents, not transferable principles.

### Human Documentation vs. Agent Documentation

| Aspect | Human-optimized | Agent-optimized |
|--------|----------------|-----------------|
| Format | Narratives explaining *why* | Invariants stating *what never to do* |
| Organization | By solution attempted | By symptom observed |
| Length | Comprehensive context | Short, checkable rules |
| Trigger | Broad categories ("serialization work") | Precise conditions ("any code touching encode/decode/WASM memory") |
| Placement | Separate reference doc | Inline in rules file (CLAUDE.md) where always in context |
| Mechanism | Passive ("check before...") | Active (invariants agents can verify mechanically) |

### What Actually Works for Agents

**Invariants** (placed in CLAUDE.md, always loaded):
```
All data INTO WASM → serializeToWasm(). Never bypass with wasmAllocate+writeToWasmMemory.
All data FROM WASM → deserializeFromWasm().
All host function returns → serializeResult() (wraps in {Ok:}).
```

**Symptom tables** (placed in CLAUDE.md):
```
"expected byte array, got map" → Missing ExternIO binary wrapper → use serializeToWasm()
"expected Ok or Err"           → Missing Result wrapper          → use serializeResult()
```

**Broad triggers** (in CLAUDE.md):
"Before ANY change that modifies how data enters or exits WASM memory -- including validation, host functions, zome calls, and any file that imports from serialization.ts -- check the WASM boundary invariants."

### The Role of This Document Going Forward

This document (LESSONS_LEARNED.md) remains valuable as **deep reference**. When an agent needs to understand *why* an invariant exists, it can read the narrative here. But the invariants themselves belong in CLAUDE.md where they're always in context and can be checked mechanically.

Think of it as: CLAUDE.md has the traffic laws. LESSONS_LEARNED.md has the accident reports that explain why those laws exist.

### For Agent Teams

When defining team boundaries (`.claude/agents/*.md`), each team's instructions must include:
1. The WASM boundary invariants (cross-cutting, all teams)
2. The symptom-diagnostic table relevant to their domain
3. Integration-specific checklists (bugs emerge when features combine)

Teams will produce MORE integration moments than a single agent. The highest-risk time is merge/integration, not initial development. See `STEPS/META_2_PROCESS_REVIEW.md` for the full analysis.

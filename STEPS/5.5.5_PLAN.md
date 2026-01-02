Serialization Debug Plan - Byte-Level Investigation

 Executive Summary

 Approach: Empirical measurement before code changes
 - Create Rust reference program using Holochain's exact crates
 - Capture byte-for-byte what Holochain produces
 - Compare with our TypeScript implementation
 - Only make changes based on observed differences

 Why This is Different from Previous Attempts:
 - NOT assuming codec incompatibility without proof
 - NOT retrying failed solutions (removing double-encoding, etc.)
 - Following Serialization Debugging Protocol: Measure first, code second

 Expected Outcome:
 - Understand EXACTLY where bytes differ
 - Form evidence-based hypothesis
 - Implement targeted fix (not shotgun debugging)

 ---
 Problem Statement

 Current Status: 5/7 test zome functions working, 2 failing with binary data issues:
 - ❌ create_test_entry(content: String) - returns 47 bytes instead of 45
 - ❌ get_test_entry(hash: ActionHash) - receives 41 bytes instead of 39

 Symptom: Binary data gets double-wrapped in msgpack bin8 format:
 - Input to WASM: {Ok: Uint8Array(39)} → 45 bytes: {Ok: bin8(39, [hash])}
 - Output from WASM: 47 bytes: {Ok: bin8(41, [bin8(39, [hash])])}
 - The hash bytes [132, 41, 36, ...] get prefixed with bin8 marker [196, 39]

 Critical Context

 From Failed Solutions Archive:
 - ❌ msgpack-bridge with rmpv: Tried, issue persisted
 - ❌ Removing double-encoding: Breaks ExternIO format contract
 - ❌ Converting to plain arrays: Loses type semantics
 - ❌ Double-decode workaround: Band-aid, doesn't fix root cause

 What We DON'T Know Yet:
 1. Exact byte sequence Holochain produces for Result<ActionHash, WasmError>
 2. Whether @msgpack/msgpack vs holochain_serialized_bytes differ for our exact use case
 3. How WASM zome functions actually handle return values (observed behavior vs expected)
 4. Whether the issue is in encoding TO wasm, encoding FROM wasm, or both

 Serialization Debugging Protocol Requirements:
 - Read Failed Solutions Archive ✅ (done)
 - Understand WHY previous solutions failed ✅ (done)
 - Have hypothesis that differs from previous attempts → NEED BYTE-LEVEL COMPARISON FIRST
 - Can explain how approach avoids previous pitfalls → NEED DATA FIRST

 Investigation Strategy

 Instead of guessing, we will MEASURE.

 Phase 1: Establish Byte-Level Ground Truth

 Create reference implementations to capture EXACT byte sequences for comparison.

 1.1: Rust Reference Program

 Purpose: Generate exact bytes that Holochain's serialization produces

 Create: investigations/serialization-test-rust/src/main.rs

 Test Cases:
 1. Simple ActionHash in Result: Result<ActionHash, WasmError>::Ok(hash)
 2. String in Result: Result<String, WasmError>::Ok("test")
 3. Nested structure: Result<Option<ActionHash>, WasmError>
 4. Raw ActionHash (no Result wrapper)
 5. ExternIO wrapping the above

 Output Format: Byte arrays in hex and decimal for easy comparison

 Implementation:
 use holochain_integrity_types::prelude::*;
 use holochain_serialized_bytes::prelude::*;
 use holo_hash::ActionHash;

 fn print_bytes(label: &str, bytes: &[u8]) {
     println!("\n=== {} ===", label);
     println!("Length: {} bytes", bytes.len());
     println!("Hex: {}", hex::encode(bytes));
     println!("Dec: {:?}", bytes);
     println!("First 20: {:?}", &bytes[..20.min(bytes.len())]);
 }

 fn main() {
     // Test Case 1: ActionHash wrapped in Result::Ok
     // Using exact bytes from test-zome logs
     let hash_bytes = vec![
         132, 41, 36, 129, 10, 140, 151, 66, 20, 198, 107, 227, 244, 220,
         175, 133, 244, 112, 233, 112, 140, 211, 145, 176, 182, 141, 77,
         137, 213, 160, 26, 122, 35, 82, 232, 159, 178, 77, 227
     ]; // 39 bytes total
     let hash = ActionHash::from_raw_39(hash_bytes.clone().try_into().unwrap());
     let result: Result<ActionHash, WasmError> = Ok(hash);

     // Serialize directly
     let bytes_direct = holochain_serialized_bytes::encode(&result).unwrap();
     print_bytes("Result<ActionHash> direct", &bytes_direct);

     // Serialize as ExternIO would
     let extern_io = ExternIO::encode(&result).unwrap();
     let bytes_externio_inner = extern_io.0;
     print_bytes("ExternIO.encode(Result<ActionHash>) - inner bytes", &bytes_externio_inner);

     // Serialize ExternIO itself (what conductor would send over wire)
     let bytes_externio_serialized = holochain_serialized_bytes::encode(&extern_io).unwrap();
     print_bytes("ExternIO serialized", &bytes_externio_serialized);

     // Test Case 2: String in Result
     let result_str: Result<String, WasmError> = Ok("test".to_string());
     let bytes_str = holochain_serialized_bytes::encode(&result_str).unwrap();
     print_bytes("Result<String>", &bytes_str);

     // Test Case 3: Raw ActionHash (no Result)
     let bytes_hash_only = holochain_serialized_bytes::encode(&hash).unwrap();
     print_bytes("ActionHash (no Result)", &bytes_hash_only);
 }

 Dependencies for Cargo.toml:
 [dependencies]
 holochain_serialized_bytes = "=0.0.56"
 holochain_integrity_types = "0.6.0-rc.0"
 holo_hash = { version = "0.6.0-rc.0", features = ["serialization", "hashing"] }
 serde = { version = "1.0", features = ["derive"] }
 serde_bytes = "0.11"
 rmp-serde = "1.3"
 hex = "0.4"

 Run:
 mkdir -p investigations
 cd investigations
 cargo new --bin serialization-test-rust
 cd serialization-test-rust
 # Edit Cargo.toml to add dependencies above
 # Copy main.rs implementation from plan
 cargo run > ../rust-reference-bytes.txt

 Note:
 - Uses same versions as test-zome (holochain_serialized_bytes = "=0.0.56") for exact compatibility
 - Investigation files stored in project for future reference and version control

 1.2: TypeScript Current Behavior Capture

 Purpose: Document EXACT bytes our implementation produces

 Create: Test file to log our current encoding

 File: investigations/serialization-test-ts.ts

 import { encode } from '@msgpack/msgpack';

 function printBytes(label: string, bytes: Uint8Array) {
   console.log(`\n=== ${label} ===`);
   console.log(`Length: ${bytes.length} bytes`);
   console.log(`Hex: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`);
   console.log(`Dec: [${Array.from(bytes).join(', ')}]`);
   console.log(`First 20: [${Array.from(bytes.slice(0, 20)).join(', ')}]`);
 }

 // Test Case 1: Result<ActionHash> - matching Rust test
 // Using exact bytes from test-zome logs
 const hashBytes = new Uint8Array([
   132, 41, 36, 129, 10, 140, 151, 66, 20, 198, 107, 227, 244, 220,
   175, 133, 244, 112, 233, 112, 140, 211, 145, 176, 182, 141, 77,
   137, 213, 160, 26, 122, 35, 82, 232, 159, 178, 77, 227
 ]); // 39 bytes total
 const result = { Ok: hashBytes };

 // Our current approach: double encoding
 const encoded1 = new Uint8Array(encode(result));
 const encoded2 = new Uint8Array(encode(encoded1));

 printBytes('Result {Ok: Uint8Array} - first encode', encoded1);
 printBytes('Result {Ok: Uint8Array} - second encode', encoded2);

 // Test Case 2: String in Result
 const resultStr = { Ok: "test" };
 const encodedStr1 = new Uint8Array(encode(resultStr));
 const encodedStr2 = new Uint8Array(encode(encodedStr1));

 printBytes('Result {Ok: String} - first encode', encodedStr1);
 printBytes('Result {Ok: String} - second encode', encodedStr2);

 // Test Case 3: Raw hash (no Result)
 const encodedHashOnly = new Uint8Array(encode(hashBytes));
 printBytes('Uint8Array only', encodedHashOnly);

 Run:
 cd investigations
 npx tsx serialization-test-ts.ts > typescript-current-bytes.txt

 1.3: WASM Behavior Observation

 Purpose: Capture what WASM actually returns

 Already have: Logs from test runs showing 47-byte output

 Need: More detailed logging showing:
 - Exact bytes written to WASM memory by host function
 - Exact bytes read from WASM memory after zome function returns
 - Both hex and decimal representation

 Add to: packages/core/src/ribosome/serialization.ts

 export function serializeToWasm(...): { ptr: number; len: number } {
   const bytes = new Uint8Array(encodeRust(data));

   // ADD: Detailed logging
   console.log(`[serializeToWasm] Input type:`, typeof data, Array.isArray(data));
   console.log(`[serializeToWasm] Input:`, JSON.stringify(data, null, 2).substring(0, 200));
   console.log(`[serializeToWasm] Encoded ${bytes.length} bytes`);
   console.log(`[serializeToWasm] Hex:`, Array.from(bytes.slice(0, 50)).map(b => b.toString(16).padStart(2, '0')).join(' '));
   console.log(`[serializeToWasm] Dec:`, Array.from(bytes.slice(0, 50)));

   // ... rest of function
 }

 export function deserializeFromWasm(...): unknown {
   const bytes = readFromWasmMemory(instance, ptr, len);

   // ADD: Detailed logging
   console.log(`[deserializeFromWasm] Reading ${len} bytes from ptr ${ptr}`);
   console.log(`[deserializeFromWasm] Hex:`, Array.from(bytes.slice(0, 50)).map(b => b.toString(16).padStart(2, '0')).join(' '));
   console.log(`[deserializeFromWasm] Dec:`, Array.from(bytes.slice(0, 50)));

   const decoded = decodeRust(bytes);
   console.log(`[deserializeFromWasm] Decoded:`, JSON.stringify(decoded, null, 2).substring(0, 200));

   return decoded;
 }

 Phase 2: Compare and Analyze

 2.1: Side-by-Side Comparison

 Create: investigations/byte-comparison.md

 Format:
 # Byte-Level Comparison

 ## Test Case: Result<ActionHash, WasmError>::Ok(hash)

 ### Holochain Reference (Rust)
 - holochain_serialized_bytes::encode(&result)
 - Length: X bytes
 - Hex: ...
 - Structure: ...

 ### Fishy Current (TypeScript)
 - @msgpack/msgpack encode({Ok: Uint8Array})
 - Length: Y bytes
 - Hex: ...
 - Structure: ...

 ### Difference Analysis
 - Byte-by-byte diff
 - Structure interpretation
 - Hypothesis on cause

 ## Test Case: Result<String>
 ...

 2.2: Decode and Interpret

 Use msgpack decoder tools to understand structure:
 - https://msgpack.org/ online decoder
 - npm install -g msgpack-lite, msgpack decode command
 - cargo install msgpack-inspect (if exists)

 For each byte sequence:
 1. Decode to see structure
 2. Identify where double-wrapping occurs
 3. Understand if it's in the data structure or encoding process

 Phase 3: Root Cause Hypothesis

 Based on byte comparison, determine:

 Hypothesis A: @msgpack/msgpack and holochain_serialized_bytes produce different bytes for identical structures
 - Evidence needed: Same JavaScript object → different bytes
 - Solution: Use msgpack-bridge (Rust codec)

 Hypothesis B: We're constructing the wrong data structure
 - Evidence needed: Rust produces X structure, we produce Y structure
 - Solution: Fix how we build the Result/ActionHash objects

 Hypothesis C: ExternIO double-encoding is being applied incorrectly
 - Evidence needed: Extra encoding layer in our flow vs Holochain's flow
 - Solution: Adjust encoding pipeline

 Hypothesis D: WASM is adding extra wrapping on return
 - Evidence needed: Host function writes 45 bytes, WASM returns 47 bytes
 - Solution: Understand HDK's return value handling

 Phase 4: Targeted Fix

 Based on hypothesis from Phase 3, implement ONLY the necessary change.

 DO NOT:
 - Make broad refactoring
 - Try multiple solutions at once
 - Change things we haven't measured

 DO:
 - Add automated test FIRST (test-driven approach)
 - Make minimal targeted change
 - Verify automated tests pass before manual browser testing
 - Use logging only to debug specific issues

 Implementation Plan

 Step 1: Create Rust Reference Program (30-45 min)

 - Create investigations/ directory in project root
 - Set up Cargo project: investigations/serialization-test-rust/
 - Add dependencies matching test-zome versions (holochain_serialized_bytes = "=0.0.56")
 - Implement test cases with exact hash bytes from logs
 - Run and save output to investigations/rust-reference-bytes.txt

 Critical Files:
 - Local Holochain crates: /home/eric/code/metacurrency/holochain/holochain/crates/
 - Test-zome for reference: packages/test-zome/
 - Investigation outputs: investigations/ (tracked in git for future reference)

 Step 2: Create TypeScript Test (30 min)

 - Create standalone test script: investigations/serialization-test-ts.ts
 - Match Rust test cases exactly (same hash bytes)
 - Run and save output to investigations/typescript-current-bytes.txt

 Step 3: Enhanced Logging (30 min)

 - Add hex/decimal logging to serializeToWasm
 - Add hex/decimal logging to deserializeFromWasm
 - Rebuild and re-run tests

 Step 4: Comparison Analysis (1 hour)

 - Create comparison document: investigations/byte-comparison.md
 - Decode byte sequences using msgpack tools
 - Identify exact differences (byte-by-byte)
 - Form evidence-based hypothesis
 - Document findings for future reference

 Step 5: Implement Fix (varies)

 - Based on hypothesis from Step 4
 - FIRST: Add automated test case with expected bytes from Rust reference
 - Verify test fails with current implementation
 - Implement minimal targeted change
 - Verify automated test passes
 - Run full test suite

 Step 6: Create Automated Tests (30 min)

 IMPORTANT: Create automated tests for fast iteration - manual browser testing is time-consuming

 Create: packages/core/src/ribosome/serialization-integration.test.ts

 Test Structure:
 import { describe, it, expect } from 'vitest';
 import { encode, decode } from '@msgpack/msgpack';  // or msgpack-bridge if needed
 import { serializeToWasm, deserializeFromWasm } from './serialization';

 describe('Serialization Integration - Binary Data', () => {
   // Use expected bytes from Rust reference program
   const EXPECTED_RESULT_ACTIONHASH_BYTES = [/* bytes from rust-reference-bytes.txt */];

   it('encodes Result<ActionHash> matching Holochain', () => {
     const hash = new Uint8Array([132, 41, 36, /* ... 39 bytes */]);
     const result = { Ok: hash };
     const encoded = new Uint8Array(encode(result));

     expect(Array.from(encoded)).toEqual(EXPECTED_RESULT_ACTIONHASH_BYTES);
   });

   it('round-trips ActionHash through serialization', () => {
     const hash = new Uint8Array([132, 41, 36, /* ... 39 bytes */]);
     const result = { Ok: hash };

     const encoded = encode(result);
     const decoded = decode(encoded);

     expect(decoded).toEqual(result);
     expect((decoded as any).Ok).toBeInstanceOf(Uint8Array);
     expect((decoded as any).Ok.length).toBe(39);
   });

   // Add more test cases based on Rust reference outputs
 });

 Why This Matters:
 - Automated tests run in seconds vs minutes for manual browser testing
 - Faster iteration during debugging
 - Can verify fix immediately without extension reload
 - CI can catch regressions

 When to Use Manual Testing:
 - Final verification after fix is implemented
 - Testing actual WASM execution with real zome functions
 - Only use manual testing when automated tests pass

 Step 7: Verify All Test Cases

 - Run automated serialization tests (npm test)
 - If automated tests pass, then run all 7 zome functions manually
 - Confirm ActionHash is 39 bytes (not 41)
 - Confirm no double-wrapping

 Success Criteria

 1. ✅ Have byte-level reference from Holochain's actual serialization
 2. ✅ Can point to EXACT byte where our output differs
 3. ✅ Can explain WHY bytes differ (not just that they do)
 4. ✅ Automated tests verify byte-for-byte match with Rust reference
 5. ✅ Implemented fix addresses root cause (proven by automated tests)
 6. ✅ All automated serialization tests pass
 7. ✅ All 7 zome functions pass (manual verification)
 8. ✅ No "BadSize" errors
 9. ✅ ActionHash is exactly 39 bytes in all cases

 Next Steps After Fix

 1. Document findings in claude.md (add to Failed Solutions Archive if fix doesn't work, or to a "Solved Issues" section if successful)
 2. Update SESSION.md with resolution
 3. Commit investigation files in investigations/ directory for future reference
 4. Commit fix with detailed explanation of root cause
 5. Continue to Step 6 (real source chain storage)

 Investigation Directory Structure

 investigations/
 ├── serialization-test-rust/       # Rust reference program
 │   ├── Cargo.toml
 │   └── src/
 │       └── main.rs
 ├── serialization-test-ts.ts       # TypeScript test program
 ├── rust-reference-bytes.txt       # Rust serialization output
 ├── typescript-current-bytes.txt   # TypeScript serialization output
 ├── byte-comparison.md             # Analysis and findings
 └── README.md                      # Explains purpose of investigation

 # Add to .gitignore:
 investigations/serialization-test-rust/target/

 This keeps the investigation process transparent and reproducible for future debugging sessions.

 Avoiding Previous Pitfalls

 Why this approach is different:
 1. NOT assuming codec incompatibility - we'll MEASURE it
 2. NOT removing double-encoding blindly - we'll understand the format first
 3. NOT adding workarounds - we'll fix the root cause
 4. NOT retrying msgpack-bridge without evidence it's needed

 Following the protocol:
 - ✅ Read Failed Solutions Archive
 - ✅ Understand why previous approaches failed
 - ✅ Different hypothesis: Need data before guessing
 - ✅ Avoiding pitfalls: Measure first, code second

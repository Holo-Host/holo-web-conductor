/**
 * JSPI Availability Test
 *
 * Tests whether WebAssembly.Suspending and WebAssembly.promising are available.
 * These are the JSPI (JavaScript Promise Integration) APIs that allow WASM
 * to call async host functions.
 */

// Check if JSPI APIs are available
console.log('=== JSPI Availability Check ===\n');

// Check WebAssembly.Suspending
const hasSuspending = typeof (WebAssembly as any).Suspending === 'function';
console.log(`WebAssembly.Suspending: ${hasSuspending ? 'AVAILABLE' : 'NOT AVAILABLE'}`);

// Check WebAssembly.promising
const hasPromising = typeof (WebAssembly as any).promising === 'function';
console.log(`WebAssembly.promising: ${hasPromising ? 'AVAILABLE' : 'NOT AVAILABLE'}`);

// Runtime environment info
console.log(`\n=== Environment Info ===`);
console.log(`Node.js version: ${process.version}`);
console.log(`V8 version: ${process.versions.v8}`);

// Check for experimental flags needed
console.log(`\n=== Notes ===`);
if (!hasSuspending || !hasPromising) {
  console.log('JSPI is not available in this environment.');
  console.log('In Node.js, try running with: node --experimental-wasm-jspi');
  console.log('In Chrome, enable: chrome://flags/#enable-experimental-webassembly-jspi');
}

// If available, try a simple test
if (hasSuspending && hasPromising) {
  console.log('JSPI APIs are available. Running functional test...\n');

  // Create a minimal WASM module that calls an imported function
  // This is the minimal WAT:
  // (module
  //   (import "env" "get_value" (func $get_value (result i32)))
  //   (func (export "test") (result i32)
  //     call $get_value))

  const wasmBytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version
    // Type section - one function type () -> i32
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    // Import section - import "env" "get_value"
    0x02, 0x0f, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x09, 0x67, 0x65, 0x74, 0x5f, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x00, 0x00,
    // Function section - one function using type 0
    0x03, 0x02, 0x01, 0x00,
    // Export section - export "test"
    0x07, 0x08, 0x01, 0x04, 0x74, 0x65, 0x73, 0x74, 0x00, 0x01,
    // Code section - body just calls the import
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b
  ]);

  async function testJSPI() {
    // Async host function that returns a Promise
    const asyncGetValue = async (): Promise<number> => {
      // Simulate async operation
      await new Promise(resolve => setTimeout(resolve, 10));
      return 42;
    };

    // Wrap the async function with WebAssembly.Suspending
    const suspendingGetValue = new (WebAssembly as any).Suspending(asyncGetValue);

    const imports = {
      env: {
        get_value: suspendingGetValue
      }
    };

    // Compile and instantiate
    const module = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(module, imports);

    // Get the export and wrap it with promising
    const testFn = instance.exports.test as () => number;
    const promisingTest = (WebAssembly as any).promising(testFn);

    // Call the promising function - it should return a Promise
    console.log('Calling WASM function that uses async host function...');
    const result = await promisingTest();
    console.log(`Result: ${result}`);

    if (result === 42) {
      console.log('\n✓ JSPI WORKS! Async host function was called and returned correctly.');
    } else {
      console.log(`\n✗ JSPI returned unexpected value: ${result}`);
    }
  }

  testJSPI().catch(err => {
    console.error('\n✗ JSPI test failed:', err);
  });
}

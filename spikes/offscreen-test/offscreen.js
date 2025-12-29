/**
 * Offscreen Document Script
 *
 * Tests:
 * 1. Can we run WASM here?
 * 2. Can we make synchronous XHR from a WASM host function?
 */

console.log('[Offscreen] Script loaded');

// Test 1: Check if sync XHR works
function testSyncXHR() {
  console.log('[Offscreen] Testing sync XHR...');

  try {
    const xhr = new XMLHttpRequest();
    // Use httpbin.org for testing - returns request info as JSON
    xhr.open('GET', 'https://httpbin.org/get?test=sync', false); // false = synchronous
    xhr.send();

    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      console.log('[Offscreen] Sync XHR SUCCESS:', data.args);
      return { success: true, data: data.args };
    } else {
      console.log('[Offscreen] Sync XHR failed with status:', xhr.status);
      return { success: false, error: `HTTP ${xhr.status}` };
    }
  } catch (error) {
    console.error('[Offscreen] Sync XHR error:', error);
    return { success: false, error: error.message };
  }
}

// Test 2: Check if WASM works
async function testWASM() {
  console.log('[Offscreen] Testing WASM...');

  try {
    // Minimal WASM module that imports a function and calls it
    // This tests if host functions work
    // (module
    //   (import "env" "get_value" (func $get_value (result i32)))
    //   (func (export "test") (result i32)
    //     call $get_value))
    const wasmBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // magic
      0x01, 0x00, 0x00, 0x00, // version
      // Type section (id=1): one type () -> i32
      0x01,       // section id
      0x05,       // section size (5 bytes)
      0x01,       // num types
      0x60,       // func type
      0x00,       // num params
      0x01, 0x7f, // num results, i32
      // Import section (id=2): import "env" "get_value" as func type 0
      0x02,       // section id
      0x11,       // section size (17 bytes)
      0x01,       // num imports
      0x03, 0x65, 0x6e, 0x76,  // "env" (length 3)
      0x09, 0x67, 0x65, 0x74, 0x5f, 0x76, 0x61, 0x6c, 0x75, 0x65,  // "get_value" (length 9)
      0x00,       // import kind: func
      0x00,       // type index 0
      // Function section (id=3): one function using type 0
      0x03,       // section id
      0x02,       // section size
      0x01,       // num functions
      0x00,       // type index 0
      // Export section (id=7): export "test" as func 1
      0x07,       // section id
      0x08,       // section size
      0x01,       // num exports
      0x04, 0x74, 0x65, 0x73, 0x74,  // "test" (length 4)
      0x00,       // export kind: func
      0x01,       // func index 1 (func 0 is the import)
      // Code section (id=10): body of func 1
      0x0a,       // section id
      0x06,       // section size
      0x01,       // num function bodies
      0x04,       // body size
      0x00,       // num locals
      0x10, 0x00, // call $get_value (func index 0)
      0x0b        // end
    ]);

    // Host function that uses sync XHR
    function hostGetValue() {
      console.log('[Offscreen] Host function called, making sync XHR...');

      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://httpbin.org/base64/NDI=', false); // Returns "42"
      xhr.send();

      if (xhr.status === 200) {
        const value = parseInt(xhr.responseText, 10);
        console.log('[Offscreen] Host function returning:', value);
        return value;
      }
      return -1;
    }

    const imports = {
      env: {
        get_value: hostGetValue
      }
    };

    const module = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(module, imports);

    const testFn = instance.exports.test;
    console.log('[Offscreen] Calling WASM function...');
    const result = testFn();

    console.log('[Offscreen] WASM result:', result);

    if (result === 42) {
      return { success: true, result: 42, message: 'WASM called sync XHR host function successfully' };
    } else {
      return { success: false, result, message: 'Unexpected result' };
    }
  } catch (error) {
    console.error('[Offscreen] WASM error:', error);
    return { success: false, error: error.message };
  }
}

// Run full test
async function runFullTest() {
  const results = {
    syncXHR: testSyncXHR(),
    wasm: await testWASM()
  };

  // Overall assessment
  results.viable = results.syncXHR.success && results.wasm.success;
  results.summary = results.viable
    ? 'Offscreen document CAN run WASM with sync XHR host functions'
    : 'Offscreen document approach has issues';

  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(results, null, 2));

  // Report back to background
  chrome.runtime.sendMessage({
    target: 'background',
    type: 'TEST_RESULT',
    data: results
  });

  return results;
}

// Handle messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Offscreen] Received message:', message);

  if (message.target !== 'offscreen') {
    return;
  }

  if (message.type === 'RUN_TEST') {
    runFullTest().then(results => {
      sendResponse(results);
    });
    return true; // Keep channel open for async response
  }

  return false;
});

// Notify background that we're ready
console.log('[Offscreen] Sending ready signal to background...');
chrome.runtime.sendMessage({
  target: 'background',
  type: 'OFFSCREEN_READY'
});

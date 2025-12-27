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

// Test Case 4: Unit type - for zero-argument functions
// In TypeScript, null is the closest equivalent to Rust's ()
const encodedNull = new Uint8Array(encode(null));
printBytes('null - zero-argument encoding', encodedNull);

// Test Case 5: undefined - to see how it encodes
const encodedUndefined = new Uint8Array(encode(undefined));
printBytes('undefined encoding', encodedUndefined);

// Test Case 6: Empty object {} - another possible zero-arg representation
const encodedEmptyObj = new Uint8Array(encode({}));
printBytes('Empty object {} encoding', encodedEmptyObj);

console.log('\n=== SUMMARY ===');
console.log('All test cases completed successfully');

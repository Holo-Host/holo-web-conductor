/**
 * Minimal test WASM bytes
 *
 * Properly encoded minimal WASM module
 * Exports: add(i32, i32) -> i32, get_constant() -> i32
 */

//  WASM module: add(i32, i32) -> i32 and get_constant() -> i32
export const minimalWasmBytes = new Uint8Array([
  // Magic number and version
  0x00, 0x61, 0x73, 0x6d, // \0asm
  0x01, 0x00, 0x00, 0x00, // version 1

  // Type section
  0x01, // section code
  0x07, // section length
  0x01, // num types
  0x60, // func type
  0x02, 0x7f, 0x7f, // 2 params (i32, i32)
  0x01, 0x7f, // 1 return (i32)

  // Function section
  0x03, // section code
  0x02, // section length
  0x01, // num functions
  0x00, // function 0, type 0

  // Export section
  0x07, // section code
  0x07, // section length
  0x01, // num exports
  0x03, // string length
  0x61, 0x64, 0x64, // "add"
  0x00, // export kind (func)
  0x00, // export func index

  // Code section
  0x0a, // section code
  0x09, // section length
  0x01, // num functions
  // Function body 0
  0x07, // body size
  0x00, // local decl count
  0x20, 0x00, // local.get 0
  0x20, 0x01, // local.get 1
  0x6a, // i32.add
  0x0b, // end
]);

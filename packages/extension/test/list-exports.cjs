const fs = require('fs');
const wasm = fs.readFileSync('test-zome.wasm');
WebAssembly.compile(wasm).then(module => {
  const exports = WebAssembly.Module.exports(module);
  console.log('\n=== All WASM Exports ===');
  exports.filter(e => e.kind === 'function').forEach(e => {
    console.log(e.name);
  });
});

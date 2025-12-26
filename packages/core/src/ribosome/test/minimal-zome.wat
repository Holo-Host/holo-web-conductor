;; Minimal test WASM module
;; Simple add function for testing basic WASM loading and execution

(module
  ;; Export a simple add function
  (func (export "add") (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.add
  )

  ;; Export a function that returns a constant (for testing zero-param functions)
  (func (export "get_constant") (result i32)
    i32.const 42
  )
)

/**
 * Tests for emit_signal host function
 */

import { describe, it, expect, beforeEach } from "vitest";
import { emit_signal } from "./emit_signal";
import { CallContext } from "../call-context";
import { RibosomeRuntime } from "../runtime";
import { allocatorWasmBytes } from "../test/allocator-wasm-bytes";
import { serializeToWasm, deserializeFromWasm } from "../serialization";
import { HostFunctionContext } from "./base";

describe("emit_signal", () => {
  let runtime: RibosomeRuntime;
  let instance: WebAssembly.Instance;
  let callContext: CallContext;
  let hostContext: HostFunctionContext;

  beforeEach(async () => {
    runtime = new RibosomeRuntime();
    const module = await runtime.compileModule(allocatorWasmBytes);
    instance = await runtime.instantiateModule(module, {});

    callContext = {
      cellId: [
        new Uint8Array(39), // DNA hash
        new Uint8Array(39), // Agent pub key
      ],
      zome: "test_zome",
      fn: "emit_signal_test",
      payload: null,
      provenance: new Uint8Array(39),
    };

    hostContext = {
      instance,
      callContext,
    };
  });

  it("should store signal in call context", () => {
    const signalMessage = "Test signal message";
    const { ptr, len } = serializeToWasm(instance, signalMessage);

    emit_signal(hostContext, ptr, len);

    expect(callContext.emittedSignals).toBeDefined();
    expect(callContext.emittedSignals).toHaveLength(1);
    expect(callContext.emittedSignals![0].zome_name).toBe("test_zome");
    expect(callContext.emittedSignals![0].cell_id).toBe(callContext.cellId);
  });

  it("should accumulate multiple signals", () => {
    const signal1 = "First signal";
    const signal2 = "Second signal";
    const signal3 = "Third signal";

    const { ptr: ptr1, len: len1 } = serializeToWasm(instance, signal1);
    const { ptr: ptr2, len: len2 } = serializeToWasm(instance, signal2);
    const { ptr: ptr3, len: len3 } = serializeToWasm(instance, signal3);

    emit_signal(hostContext, ptr1, len1);
    emit_signal(hostContext, ptr2, len2);
    emit_signal(hostContext, ptr3, len3);

    expect(callContext.emittedSignals).toHaveLength(3);
    expect(callContext.emittedSignals![0].zome_name).toBe("test_zome");
    expect(callContext.emittedSignals![1].zome_name).toBe("test_zome");
    expect(callContext.emittedSignals![2].zome_name).toBe("test_zome");
  });

  it("should include timestamp in signal", () => {
    const signalMessage = "Timestamped signal";
    const { ptr, len } = serializeToWasm(instance, signalMessage);

    const beforeTime = Date.now();
    emit_signal(hostContext, ptr, len);
    const afterTime = Date.now();

    expect(callContext.emittedSignals).toHaveLength(1);
    const signal = callContext.emittedSignals![0];
    expect(signal.timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(signal.timestamp).toBeLessThanOrEqual(afterTime);
  });

  it("should handle binary signal data", () => {
    const binaryData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { ptr, len } = serializeToWasm(instance, binaryData);

    emit_signal(hostContext, ptr, len);

    expect(callContext.emittedSignals).toHaveLength(1);
    expect(callContext.emittedSignals![0].signal).toBeInstanceOf(Uint8Array);
  });

  it("should handle complex object signals", () => {
    const complexSignal = {
      type: "notification",
      data: {
        message: "Complex signal",
        priority: 5,
        tags: ["test", "automated"],
      },
    };
    const { ptr, len } = serializeToWasm(instance, complexSignal);

    emit_signal(hostContext, ptr, len);

    expect(callContext.emittedSignals).toHaveLength(1);
    expect(callContext.emittedSignals![0].zome_name).toBe("test_zome");
  });

  it("should return Result::Ok(null)", () => {
    const signalMessage = "Test signal";
    const { ptr, len } = serializeToWasm(instance, signalMessage);

    const resultI64 = emit_signal(hostContext, ptr, len);

    // Ensure result is not a Promise (should never happen for emit_signal)
    if (resultI64 instanceof Promise) {
      throw new Error('emit_signal returned Promise unexpectedly');
    }

    // Extract ptr and len from i64 result
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);

    expect(resultPtr).toBeGreaterThanOrEqual(0);
    expect(resultLen).toBeGreaterThan(0);

    // Result should be wrapped in {Ok: null}
    const result = deserializeFromWasm(instance, resultPtr, resultLen);
    expect(result).toEqual({ Ok: null });
  });
});

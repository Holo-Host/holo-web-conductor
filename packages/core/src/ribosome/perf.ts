/**
 * Performance Metrics for Ribosome
 *
 * Provides timing instrumentation to identify bottlenecks in zome execution.
 */

export interface PerfMetrics {
  zomeCall: string;
  totalMs: number;
  breakdown: {
    sodiumReady: number;
    genesisCheck: number;
    wasmCompile: number;
    wasmInstantiate: number;
    metadataInit: number;
    serialize: number;
    zomeExecute: number;
    deserialize: number;
    txCommit: number;
  };
  hostFunctions: Map<string, { count: number; totalMs: number }>;
}

// Current call metrics (thread-local in practice since JS is single-threaded per worker)
let currentMetrics: PerfMetrics | null = null;
let enabled = true;

/**
 * Enable or disable performance metrics
 */
export function setPerfEnabled(value: boolean): void {
  enabled = value;
}

/**
 * Start metrics collection for a zome call
 */
export function startZomeCallMetrics(zome: string, fn: string): void {
  if (!enabled) return;
  currentMetrics = {
    zomeCall: `${zome}::${fn}`,
    totalMs: 0,
    breakdown: {
      sodiumReady: 0,
      genesisCheck: 0,
      wasmCompile: 0,
      wasmInstantiate: 0,
      metadataInit: 0,
      serialize: 0,
      zomeExecute: 0,
      deserialize: 0,
      txCommit: 0,
    },
    hostFunctions: new Map(),
  };
}

/**
 * Record time for a specific phase
 */
export function recordPhase(phase: keyof PerfMetrics['breakdown'], ms: number): void {
  if (!enabled || !currentMetrics) return;
  currentMetrics.breakdown[phase] += ms;
}

/**
 * Record a host function call
 */
export function recordHostFunction(name: string, ms: number): void {
  if (!enabled || !currentMetrics) return;
  const existing = currentMetrics.hostFunctions.get(name) || { count: 0, totalMs: 0 };
  existing.count++;
  existing.totalMs += ms;
  currentMetrics.hostFunctions.set(name, existing);
}

/**
 * End metrics collection and log results
 */
export function endZomeCallMetrics(totalMs: number): void {
  if (!enabled || !currentMetrics) return;

  currentMetrics.totalMs = totalMs;

  // Log summary
  const m = currentMetrics;
  const b = m.breakdown;

  console.log(`\n⏱️ [PERF] ${m.zomeCall} completed in ${totalMs.toFixed(1)}ms`);
  console.log(`   ├─ sodium.ready:     ${b.sodiumReady.toFixed(1)}ms`);
  console.log(`   ├─ genesis check:    ${b.genesisCheck.toFixed(1)}ms`);
  console.log(`   ├─ WASM compile:     ${b.wasmCompile.toFixed(1)}ms`);
  console.log(`   ├─ WASM instantiate: ${b.wasmInstantiate.toFixed(1)}ms`);
  console.log(`   ├─ metadata init:    ${b.metadataInit.toFixed(1)}ms`);
  console.log(`   ├─ serialize input:  ${b.serialize.toFixed(1)}ms`);
  console.log(`   ├─ zome execute:     ${b.zomeExecute.toFixed(1)}ms`);
  console.log(`   ├─ deserialize:      ${b.deserialize.toFixed(1)}ms`);
  console.log(`   └─ tx commit:        ${b.txCommit.toFixed(1)}ms`);

  // Calculate overhead (time not accounted for in breakdown)
  const accounted = Object.values(b).reduce((a, b) => a + b, 0);
  const overhead = totalMs - accounted;
  if (overhead > 1) {
    console.log(`   ⚠️ Unaccounted:     ${overhead.toFixed(1)}ms`);
  }

  // Log host function breakdown if significant
  if (m.hostFunctions.size > 0) {
    console.log(`   📞 Host Functions:`);
    const sorted = [...m.hostFunctions.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
    for (const [name, stats] of sorted.slice(0, 10)) {
      if (stats.totalMs >= 0.1) {
        const avg = stats.totalMs / stats.count;
        console.log(`      ├─ ${name}: ${stats.totalMs.toFixed(1)}ms (${stats.count}x, avg ${avg.toFixed(2)}ms)`);
      }
    }
  }

  console.log('');

  currentMetrics = null;
}

/**
 * Helper to time a synchronous operation
 */
export function timeSync<T>(phase: keyof PerfMetrics['breakdown'], fn: () => T): T {
  if (!enabled) return fn();
  const start = performance.now();
  const result = fn();
  recordPhase(phase, performance.now() - start);
  return result;
}

/**
 * Helper to time an async operation
 */
export async function timeAsync<T>(phase: keyof PerfMetrics['breakdown'], fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  const result = await fn();
  recordPhase(phase, performance.now() - start);
  return result;
}

/**
 * Helper to time a host function
 */
export function timeHostFn<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  const start = performance.now();
  const result = fn();
  recordHostFunction(name, performance.now() - start);
  return result;
}

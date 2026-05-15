import { describe, it, expect, beforeEach } from 'vitest';
import {
  isV8IntrinsicsAvailable,
  prepareForOptimization,
  optimizeOnNextCall,
  forceOptimization,
  getOptimizationStatus,
  clearOptimizationData,
  optimizationInfo,
  deoptedFunctions,
  ingestTraceChunkForTesting,
} from '../../src/core/v8-monitor.js';

const hasIntrinsics = isV8IntrinsicsAvailable();
const itIfIntrinsics = hasIntrinsics ? it : it.skip;

function makeBenchmark() {
  // Fresh closure each time so V8 doesn't carry tier-up state across tests.
  return function bench() {
    let sum = 0;
    for (let i = 0; i < 5000; i++) sum += i;
    return sum;
  };
}

describe('V8 monitor (intrinsics)', () => {
  beforeEach(() => clearOptimizationData());

  it('should return a boolean from isV8IntrinsicsAvailable that matches harness flag', () => {
    expect(typeof hasIntrinsics).toBe('boolean');
    // The vitest config passes --allow-natives-syntax to the fork pool, so
    // intrinsics should be available in this test environment.
    expect(hasIntrinsics).toBe(true);
  });

  itIfIntrinsics('prepareForOptimization + optimizeOnNextCall mark the function for optimization', () => {
    const fn = makeBenchmark();

    expect(prepareForOptimization(fn)).toBe(true);
    for (let i = 0; i < 20; i++) fn();
    expect(optimizeOnNextCall(fn)).toBe(true);
    fn(); // triggers compilation

    const result = getOptimizationStatus(fn, 'bench');
    expect(result.available).toBe(true);
    // After a forced optimization pass we expect either the optimized bit or
    // the top-tier turbofan bit to be set.
    expect(result.flags.optimized || result.flags.is_topTierTurbofan).toBe(true);
  });

  itIfIntrinsics('forceOptimization composes prepare + optimize and survives a trigger call', () => {
    const fn = makeBenchmark();
    for (let i = 0; i < 5; i++) fn();

    expect(forceOptimization(fn)).toBe(true);
    fn(); // trigger

    const status = getOptimizationStatus(fn, 'fn');
    expect(status.available).toBe(true);
    expect(status.flags).toBeTypeOf('object');
  });

  itIfIntrinsics('getOptimizationStatus accepts a function reference (not just a name)', () => {
    const fn = makeBenchmark();
    const result = getOptimizationStatus(fn, 'fn');
    expect(result.available).toBe(true);
    expect(typeof result.status).toBe('number');
  });
});

describe('V8 trace parsing', () => {
  beforeEach(() => clearOptimizationData());

  it('should parse a complete optimization line', () => {
    ingestTraceChunkForTesting(
      '[marking 0x22bac9112da1 <JSFunction hotLoop (sfi = 0x157c3d9067b1)> for optimization to MAGLEV, ConcurrencyMode::kConcurrent, reason: hot and stable]\n'
    );
    expect(optimizationInfo.has('hotLoop')).toBe(true);
    const info = optimizationInfo.get('hotLoop');
    expect(info.attempts).toBe(1);
    expect(info.reasons[0]).toContain('hot and stable');
  });

  it('should parse a complete deopt line', () => {
    ingestTraceChunkForTesting(
      '[bailout (kind: deopt-eager, reason: wrong map): begin. deoptimizing 0x134c0d6165b9 <JSFunction next (sfi = 0x2f28637093c9)>, 0x3d4fef2817c9 <Code MAGLEV>, opt id 2, bytecode offset 3, deopt exit 0, FP to SP delta 32, caller SP 0x00016d8cdb38, pc 0x000118f02814]\n'
    );
    expect(deoptedFunctions.has('next')).toBe(true);
  });

  it('should parse a complete optimization line delivered as one chunk', () => {
    ingestTraceChunkForTesting(
      '[marking 0x1 <JSFunction split (sfi = 0x2)> for optimization to TURBOFAN, ConcurrencyMode::kConcurrent, reason: hot and stable]\n'
    );
    expect(optimizationInfo.has('split')).toBe(true);
    expect(optimizationInfo.get('split').attempts).toBe(1);
  });

  it('should parse multiple events arriving in one chunk', () => {
    ingestTraceChunkForTesting(
      '[marking 0x1 <JSFunction first (sfi = 0x2)> for optimization to MAGLEV, ConcurrencyMode::kConcurrent, reason: hot and stable]\n' +
      '[marking 0x3 <JSFunction second (sfi = 0x4)> for optimization to MAGLEV, ConcurrencyMode::kConcurrent, reason: hot and stable]\n'
    );
    expect(optimizationInfo.has('first')).toBe(true);
    expect(optimizationInfo.has('second')).toBe(true);
  });

  it('should parse a manually-triggered optimization line (no reason field)', () => {
    ingestTraceChunkForTesting(
      '[manually marking 0x274bf386b5a1 <JSFunction hotLoop (sfi = 0x274bf3869381)> for optimization to TURBOFAN_JS, ConcurrencyMode::kSynchronous]\n'
    );
    expect(optimizationInfo.has('hotLoop')).toBe(true);
    const info = optimizationInfo.get('hotLoop');
    expect(info.attempts).toBe(1);
    expect(info.tiers).toContain('TURBOFAN_JS');
    expect(info.reasons[0]).toBe('manual');
  });

  it('should ignore anonymous JSFunction events (no name to attribute)', () => {
    ingestTraceChunkForTesting(
      '[marking 0x1 <JSFunction (sfi = 0x2)> for optimization to MAGLEV, ConcurrencyMode::kConcurrent, reason: hot and stable]\n'
    );
    expect(optimizationInfo.size).toBe(0);
  });
});

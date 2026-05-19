import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfiler, DEFAULT_EXPORT_SENTINEL } from '../../src/core/profiler.js';
import { createTraceParser } from '../../src/core/v8-monitor.js';

// Each test spawns a child Node process via fork(), so timings are dominated
// by spawn cost (~30–80ms). Keep run counts small to stay fast.
const FAST_CONFIG = {
  profiling: { warmupRuns: 2, testRuns: 10, delayBetweenTests: 0 },
  v8: { enableIntrinsics: true, forceOptimization: true, traceOptimization: true },
  output: { format: 'console', verbose: false },
  analysis: { outlierThreshold: 2, showInsights: false },
};

describe('createProfiler / runBenchmarks (child-process integration)', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v8-prof-int-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('should run a benchmark in a forked child and return timings + optimization status', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function hot() {
        let s = 0;
        for (let i = 0; i < 5000; i++) s += i;
        return s;
      }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([{ name: 'hot', path: file, exportName: 'hot' }]);

    expect(result.name).toBe('hot');
    expect(result.timing).toBeTypeOf('object');
    expect(result.timing.count).toBe(10);
    expect(result.optimization.available).toBe(true);
    // The child force-optimized via %OptimizeFunctionOnNextCall, so at least
    // one of these tier flags should be set.
    expect(
      result.optimization.flags.optimized || result.optimization.flags.is_topTierTurbofan
    ).toBe(true);
    // The parent parsed V8 stdout trace and attributed at least the manual
    // marking event to this function.
    expect(result.optimization.attempts).toBeGreaterThanOrEqual(1);
  });

  it('should return an error result (not throw) when the benchmark export is missing', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(file, `export function a(){}`);

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'missing', path: file, exportName: 'missing' },
    ]);

    expect(result.error).toBeTypeOf('object');
    expect(result.error.message).toMatch(/is not a function/);
    expect(result.timing).toBeNull();
  });

  it('should attribute trace events for named default exports by fn.name, not sentinel', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export default function namedDefault() {
        let s = 0;
        for (let i = 0; i < 3000; i++) s += i;
        return s;
      }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'default', path: file, exportName: DEFAULT_EXPORT_SENTINEL },
    ]);

    expect(result.optimization.attempts).toBeGreaterThanOrEqual(1);
    expect(result.optimization.traceAttribution).toBe('by-name');
  });

  it('should flag truly nameless functions as unattributable', async () => {
    // In ESM, `export default () => {}` binds the export name to the function,
    // so .name becomes 'default'. We need an IIFE-returned function to
    // exercise the genuinely nameless (fn.name === '') case.
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export default (() => () => {
        let s = 0;
        for (let i = 0; i < 3000; i++) s += i;
        return s;
      })();
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'default', path: file, exportName: DEFAULT_EXPORT_SENTINEL },
    ]);

    expect(result.optimization.traceAttribution).toBe('anonymous-skipped');
    expect(result.optimization.attempts).toBe(0);
  });

  it('should honor v8.forceOptimization=false: no manual optimize, optimization.forced exposed', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function hot() {
        let s = 0;
        for (let i = 0; i < 3000; i++) s += i;
        return s;
      }
    `
    );

    const noOptConfig = {
      ...FAST_CONFIG,
      v8: { ...FAST_CONFIG.v8, forceOptimization: false },
    };
    const profiler = await createProfiler(noOptConfig);
    const [result] = await profiler.runBenchmarks([{ name: 'hot', path: file, exportName: 'hot' }]);

    expect(result.optimization.forced).toBe(false);
    // The 'manual' reason is only recorded when the child invoked
    // %OptimizeFunctionOnNextCall. With forceOptimization off, it must not
    // appear regardless of whether V8 self-tier-ups the function during warmup.
    expect(result.optimization.reasons).not.toContain('manual');
    expect(result.metadata.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('forceOptimization disabled')])
    );
  });

  it('should surface a warning when intrinsics are disabled via config', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function hot() {
        let s = 0;
        for (let i = 0; i < 3000; i++) s += i;
        return s;
      }
    `
    );

    const noV8Config = {
      ...FAST_CONFIG,
      v8: { ...FAST_CONFIG.v8, enableIntrinsics: false, traceOptimization: false },
    };
    const profiler = await createProfiler(noV8Config);
    const [result] = await profiler.runBenchmarks([{ name: 'hot', path: file, exportName: 'hot' }]);

    expect(result.metadata.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('V8 intrinsics disabled')])
    );
  });

  it('should emit no warnings under the default healthy config', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function hot() {
        let s = 0;
        for (let i = 0; i < 3000; i++) s += i;
        return s;
      }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([{ name: 'hot', path: file, exportName: 'hot' }]);

    expect(result.metadata.warnings).toEqual([]);
  });

  it('should expose optimization.forced=true under the default config', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function hot() {
        let s = 0;
        for (let i = 0; i < 3000; i++) s += i;
        return s;
      }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([{ name: 'hot', path: file, exportName: 'hot' }]);

    expect(result.optimization.forced).toBe(true);
  });

  it('should report executionMode="sync" for a synchronous benchmark', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function syncFn() {
        let s = 0;
        for (let i = 0; i < 2000; i++) s += i;
        return s;
      }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'syncFn', path: file, exportName: 'syncFn' },
    ]);

    expect(result.metadata.executionMode).toBe('sync');
    expect(result.timing.mean).toBeGreaterThan(0);
  });

  it('should report executionMode="async" for an async benchmark', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export async function asyncFn() {
        let s = 0;
        for (let i = 0; i < 2000; i++) s += i;
        return s;
      }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'asyncFn', path: file, exportName: 'asyncFn' },
    ]);

    expect(result.metadata.executionMode).toBe('async');
    expect(result.timing.mean).toBeGreaterThan(0);
  });

  it('should record a non-zero mean and a sinkChecksum for a noop benchmark', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(file, `export function noop() {}`);

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'noop', path: file, exportName: 'noop' },
    ]);

    expect(result.timing.mean).toBeGreaterThan(0);
    expect(typeof result.metadata.sinkChecksum).toBe('number');
  });

  it('should auto-calibrate batchSize > 1 for a sub-microsecond benchmark', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(file, `export function tinyFn() { return 1 + 1; }`);

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'tinyFn', path: file, exportName: 'tinyFn' },
    ]);

    expect(result.metadata.batchSize).toBeGreaterThan(1);
    expect(result.metadata.mode).toBe('per-batch');
    expect(result.timing.count).toBe(10);
  });

  it('should pin batchSize to 1 for a benchmark whose single call exceeds the target', async () => {
    // 200k tight-loop iterations JITs to sub-ms on modern CPUs; nest two loops
    // so per-call time comfortably exceeds TARGET_BATCH_MS regardless of host.
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function slowFn() {
        let s = 0;
        for (let k = 0; k < 50; k++) {
          for (let i = 0; i < 200000; i++) s += i;
        }
        return s;
      }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'slowFn', path: file, exportName: 'slowFn' },
    ]);

    expect(result.metadata.batchSize).toBe(1);
    expect(result.metadata.mode).toBe('per-call');
    expect(result.timing.count).toBe(10);
  });

  it('should isolate trace counters between benchmarks (no bleed-through)', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function first()  { let s=0; for (let i=0;i<3000;i++) s+=i; return s; }
      export function second() { let s=0; for (let i=0;i<3000;i++) s+=i; return s; }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const results = await profiler.runBenchmarks([
      { name: 'first', path: file, exportName: 'first' },
      { name: 'second', path: file, exportName: 'second' },
    ]);

    expect(results).toHaveLength(2);
    // Each benchmark should carry its own attempts count — clearOptimizationData
    // between forks must reset the parent's parser state.
    expect(results[0].optimization.attempts).toBeGreaterThanOrEqual(1);
    expect(results[1].optimization.attempts).toBeGreaterThanOrEqual(1);
    expect(results[0].optimization.reasons.every(r => typeof r === 'string')).toBe(true);
  });

  it('should ignore user console.log lines that embed V8-shaped trace records without the trace prefix', async () => {
    // The OPT_PATTERN regex matches its tokens anywhere in a line, so a user
    // log that *contains* a V8-shaped record (but does not begin with one) is
    // enough to fool the parser if the readline-boundary filter is missing.
    // Use a fresh parser instance to confirm: feed it the same content the
    // child would have written to stdout, behind the isV8TraceLine gate, and
    // verify the gate keeps the line out.
    const { isV8TraceLine } = await import('../../src/core/profiler.js');
    const parser = createTraceParser();
    const userLog =
      'debug: [marking 0x123 <JSFunction phantomFn (sfi = 0x42)> for optimization to TURBOFAN_JS, ConcurrencyMode::kSynchronous]';
    if (isV8TraceLine(userLog)) parser.parseTraceLine(userLog);
    expect(parser.optimizationInfo.has('phantomFn')).toBe(false);
  });

  it('should wait for stdout/stderr drain so trailing trace events are not lost', async () => {
    // Heavy work in a tight loop produces trailing tier-up records that V8
    // commonly writes between the child's IPC send and process.exit. The
    // parent must wait for stream close to capture them. We can't assert on
    // a specific trailing event (V8 emits them nondeterministically), but a
    // successful resolve with attempts >= 1 demonstrates the drain wait did
    // not strand the message.
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function heavy() {
        let s = 0;
        for (let i = 0; i < 50000; i++) s += i * 3;
        return s;
      }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'heavy', path: file, exportName: 'heavy' },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.timing).toBeTypeOf('object');
    expect(result.optimization.attempts).toBeGreaterThanOrEqual(1);
  });

  it('should honor the runOrderCheck flag and not flag clearly-separated benchmarks as order-dependent', async () => {
    // Two benchmarks where the cost ratio is large enough that ordering
    // cannot plausibly flip the ranking. The flag should run both passes
    // (forward + reverse) and leave orderDependent unset on every result.
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function fast() { return 1; }
      export function slow() {
        let s = 0;
        for (let k = 0; k < 50; k++) {
          for (let i = 0; i < 200000; i++) s += i;
        }
        return s;
      }
    `
    );

    const profiler = await createProfiler({
      ...FAST_CONFIG,
      profiling: { ...FAST_CONFIG.profiling, runOrderCheck: true },
    });
    const results = await profiler.runBenchmarks([
      { name: 'fast', path: file, exportName: 'fast' },
      { name: 'slow', path: file, exportName: 'slow' },
    ]);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.metadata?.orderDependent).toBeFalsy();
    }
  });

  it('should not perform a second pass when runOrderCheck is off', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function a() { return 1; }
      export function b() { return 2; }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const results = await profiler.runBenchmarks([
      { name: 'a', path: file, exportName: 'a' },
      { name: 'b', path: file, exportName: 'b' },
    ]);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.metadata?.orderDependent).toBeUndefined();
    }
  });

  it('should report traceParserHealth="ok" on a normal run', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(
      file,
      `
      export function hot() {
        let s = 0;
        for (let i = 0; i < 3000; i++) s += i;
        return s;
      }
    `
    );

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([{ name: 'hot', path: file, exportName: 'hot' }]);

    expect(result.metadata.traceParserHealth).toBe('ok');
  });

  it('should still parse real V8 trace lines through parseTraceLine', () => {
    const parser = createTraceParser();
    parser.parseTraceLine(
      '[marking 0x123 <JSFunction realName (sfi = 0x42)> for optimization to TURBOFAN_JS, ConcurrencyMode::kSynchronous]'
    );
    parser.parseTraceLine(
      '[manually marking 0x123 <JSFunction manualName (sfi = 0x42)> for optimization to TURBOFAN_JS, ConcurrencyMode::kSynchronous]'
    );
    parser.parseTraceLine(
      '[bailout (kind: deopt-soft, reason: Insufficient type feedback): begin. deoptimizing <JSFunction bailName (sfi = 0x42)>]'
    );

    expect(parser.optimizationInfo.get('realName')?.attempts).toBe(1);
    expect(parser.optimizationInfo.get('manualName')?.attempts).toBe(1);
    expect(parser.optimizationInfo.get('bailName')?.deoptReasons).toContain(
      'Insufficient type feedback'
    );
  });
});

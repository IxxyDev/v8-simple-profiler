import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfiler } from '../../src/core/profiler.js';

// Each test spawns a child Node process via fork(), so timings are dominated
// by spawn cost (~30–80ms). Keep run counts small to stay fast.
const FAST_CONFIG = {
  profiling: { warmupRuns: 2, testRuns: 10, delayBetweenTests: 0 },
  v8: { enableIntrinsics: true, forceOptimization: true, monitorStderr: true },
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

  it('runs a benchmark in a forked child and returns timings + optimization status', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(file, `
      export function hot() {
        let s = 0;
        for (let i = 0; i < 5000; i++) s += i;
        return s;
      }
    `);

    const profiler = await createProfiler(FAST_CONFIG);
    const [result] = await profiler.runBenchmarks([
      { name: 'hot', path: file, exportName: 'hot' },
    ]);

    expect(result.name).toBe('hot');
    expect(result.timing).toBeTypeOf('object');
    expect(result.timing.count).toBe(10);
    expect(result.optimization.available).toBe(true);
    // The child force-optimized via %OptimizeFunctionOnNextCall, so at least
    // one of these tier flags should be set.
    expect(
      result.optimization.flags.optimized ||
      result.optimization.flags.is_topTierTurbofan
    ).toBe(true);
    // The parent parsed V8 stdout trace and attributed at least the manual
    // marking event to this function.
    expect(result.optimization.attempts).toBeGreaterThanOrEqual(1);
  });

  it('returns an error result (not throws) when the benchmark export is missing', async () => {
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

  it('isolates trace counters between benchmarks (no bleed-through)', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(file, `
      export function first()  { let s=0; for (let i=0;i<3000;i++) s+=i; return s; }
      export function second() { let s=0; for (let i=0;i<3000;i++) s+=i; return s; }
    `);

    const profiler = await createProfiler(FAST_CONFIG);
    const results = await profiler.runBenchmarks([
      { name: 'first',  path: file, exportName: 'first'  },
      { name: 'second', path: file, exportName: 'second' },
    ]);

    expect(results).toHaveLength(2);
    // Each benchmark should carry its own attempts count — clearOptimizationData
    // between forks must reset the parent's parser state.
    expect(results[0].optimization.attempts).toBeGreaterThanOrEqual(1);
    expect(results[1].optimization.attempts).toBeGreaterThanOrEqual(1);
    expect(results[0].optimization.reasons.every(r => typeof r === 'string')).toBe(true);
  });
});

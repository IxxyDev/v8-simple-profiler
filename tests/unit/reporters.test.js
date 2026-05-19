import { describe, it, expect } from 'vitest';
import { formatJsonReport } from '../../src/reporters/json.js';
import { formatCsvReport } from '../../src/reporters/csv.js';

function makeResult(overrides = {}) {
  return {
    name: 'sample',
    timing: {
      mean: 1.2345,
      median: 1.2,
      min: 1.0,
      max: 1.5,
      stdDev: 0.1,
      variance: 0.01,
      cov: 0.08,
      p25: 1.1,
      p75: 1.3,
      p90: 1.4,
      p95: 1.45,
      p99: 1.49,
      count: 100,
      outliers: 2,
      reliability: 'high',
    },
    optimization: {
      available: true,
      flags: { optimized: true, is_topTierTurbofan: true },
      deoptimized: false,
      attempts: 1,
      reasons: ['hot and stable'],
    },
    metadata: {
      timestamp: '2024-01-01T00:00:00Z',
      warnings: [],
    },
    ...overrides,
  };
}

describe('formatJsonReport', () => {
  it('should produce parseable JSON with the documented top-level shape', () => {
    const text = formatJsonReport([makeResult()]);
    const parsed = JSON.parse(text);
    expect(parsed).toHaveProperty('timestamp');
    expect(parsed).toHaveProperty('version');
    expect(parsed).toHaveProperty('results');
    expect(parsed).toHaveProperty('summary');
    expect(parsed).toHaveProperty('metadata');
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results).toHaveLength(1);
  });

  it('should drop p90/p95/p99 keys when calculateStats returned null', () => {
    const r = makeResult();
    r.timing.p90 = null;
    r.timing.p95 = null;
    r.timing.p99 = null;
    const parsed = JSON.parse(formatJsonReport([r]));
    expect(parsed.results[0].timing.percentiles).toHaveProperty('p25');
    expect(parsed.results[0].timing.percentiles).toHaveProperty('p75');
    expect(parsed.results[0].timing.percentiles).not.toHaveProperty('p90');
    expect(parsed.results[0].timing.percentiles).not.toHaveProperty('p95');
    expect(parsed.results[0].timing.percentiles).not.toHaveProperty('p99');
  });

  it('should mark errored results as status="error" without a timing block', () => {
    const errored = {
      name: 'broken',
      error: { message: 'boom', type: 'Error' },
      timing: null,
      optimization: { available: false },
      metadata: { timestamp: '2024-01-01T00:00:00Z' },
    };
    const parsed = JSON.parse(formatJsonReport([errored]));
    expect(parsed.results[0].status).toBe('error');
    expect(parsed.results[0].timing).toBeUndefined();
    expect(parsed.summary.failedFunctions).toBe(1);
    expect(parsed.summary.successfulFunctions).toBe(0);
  });

  it('should report fastest/slowest in the summary across multiple results', () => {
    const fast = makeResult({ name: 'fast' });
    fast.timing = { ...fast.timing, mean: 0.5 };
    const slow = makeResult({ name: 'slow' });
    slow.timing = { ...slow.timing, mean: 2.0 };
    const parsed = JSON.parse(formatJsonReport([fast, slow]));
    expect(parsed.summary.performance.fastest.name).toBe('fast');
    expect(parsed.summary.performance.slowest.name).toBe('slow');
    expect(parsed.summary.performance.speedupRatio).toBe(4);
  });

  it('should emit minified JSON when pretty=false', () => {
    const minified = formatJsonReport([makeResult()], { pretty: false });
    expect(minified).not.toContain('\n');
  });

  it('should propagate metadata.warnings into the per-result payload', () => {
    const r = makeResult();
    r.metadata.warnings = ['V8 intrinsics disabled — optimization status unavailable'];
    const parsed = JSON.parse(formatJsonReport([r]));
    expect(parsed.results[0].metadata.warnings).toEqual(r.metadata.warnings);
  });
});

describe('formatCsvReport', () => {
  it('should emit a header row plus one row per result', () => {
    const csv = formatCsvReport([makeResult(), makeResult({ name: 'b' })]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('name');
    expect(lines[0]).toContain('mean_ms');
  });

  it('should preserve zero values instead of emitting empty cells', () => {
    const zeroed = makeResult();
    zeroed.timing = { ...zeroed.timing, outliers: 0 };
    zeroed.optimization.attempts = 0;
    const csv = formatCsvReport([zeroed], { includeOptimization: true });
    const dataRow = csv.split('\n')[1].split(',');
    const headerRow = csv.split('\n')[0].split(',');
    const outliersIdx = headerRow.indexOf('outliers');
    const attemptsIdx = headerRow.indexOf('optimization_attempts');
    expect(dataRow[outliersIdx]).toBe('0');
    expect(dataRow[attemptsIdx]).toBe('0');
  });

  it('should quote-escape cells that contain commas', () => {
    const r = makeResult({ name: 'has,comma' });
    const csv = formatCsvReport([r]);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toMatch(/^"has,comma"/);
  });

  it('should include percentile columns only when requested', () => {
    const withP = formatCsvReport([makeResult()], { includePercentiles: true });
    const withoutP = formatCsvReport([makeResult()], { includePercentiles: false });
    expect(withP.split('\n')[0]).toContain('p95_ms');
    expect(withoutP.split('\n')[0]).not.toContain('p95_ms');
  });

  it('should render error results without crashing on missing timing', () => {
    const errored = {
      name: 'broken',
      error: { message: 'boom', type: 'Error' },
      timing: null,
      optimization: { available: false },
      metadata: { timestamp: '2024-01-01T00:00:00Z' },
    };
    const csv = formatCsvReport([errored]);
    const row = csv.split('\n')[1];
    expect(row).toContain('error');
  });
});

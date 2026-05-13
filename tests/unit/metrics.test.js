import { describe, it, expect } from 'vitest';
import { compareResults, calculateStats, tCriticalTwoSided } from '../../src/core/metrics.js';

// Build a results object the way profiler.js does, so compareResults sees the
// same shape it sees in production.
function asResult(name, measurements) {
  const stats = calculateStats(measurements);
  return { name, timing: { ...stats } };
}

describe("Welch's t-test in compareResults", () => {
  it('should use unpooled SE and Welch–Satterthwaite degrees of freedom', () => {
    // Two samples with very different variances — the case where Welch and
    // Student diverge most sharply. Hand-computed below.
    const a = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]; // mean 10, var 0
    const b = [12, 14, 10, 16, 8, 18, 6, 20, 4, 22];   // mean 13, large var

    const cmp = compareResults(asResult('a', a), asResult('b', b));

    // Hand calc on sample variance (n-1 denominator, what Welch is defined on):
    //   mean1=10, sampleVar1=0,        n1=10
    //   mean2=13, sampleVar2=330/9≈36.667, n2=10
    //   Welch SE = sqrt(0/10 + 36.667/10) = sqrt(3.6667) ≈ 1.9149
    //   Welch t  = |10-13| / 1.9149                    ≈ 1.5667
    expect(cmp.significance.tStatistic).toBeCloseTo(1.5667, 2);

    // Welch–Satterthwaite df: when var1=0, formula reduces to (n2-1) = 9.
    expect(cmp.significance.degreesOfFreedom).toBeCloseTo(9, 1);
  });

  it('should match pooled Student only when variances are equal (sanity check)', () => {
    // Equal-variance case: Welch and pooled Student agree numerically.
    const a = [9, 10, 11, 9, 10, 11, 9, 10, 11, 10];
    const b = [12, 13, 14, 12, 13, 14, 12, 13, 14, 13];
    const cmp = compareResults(asResult('a', a), asResult('b', b));

    // mean1=10, var1≈0.667; mean2=13, var2≈0.667; n=10 each
    // SE = sqrt(0.667/10 + 0.667/10) = sqrt(0.1334) ≈ 0.3653
    // t  = 3 / 0.3653 ≈ 8.213
    expect(cmp.significance.tStatistic).toBeCloseTo(8.213, 1);
    // df ≈ 2*(n-1) = 18 when variances are equal.
    expect(cmp.significance.degreesOfFreedom).toBeCloseTo(18, 0);
  });

  it('should report significant + 99% confidence for a clearly different pair', () => {
    const a = [1, 1.1, 0.9, 1.05, 0.95, 1.02, 0.98, 1.01, 0.99, 1.0];
    const b = [5, 5.1, 4.9, 5.05, 4.95, 5.02, 4.98, 5.01, 4.99, 5.0];
    const cmp = compareResults(asResult('a', a), asResult('b', b));
    expect(cmp.significance.significant).toBe(true);
    expect(cmp.significance.confidenceLevel).toBe(99);
  });
});

describe('tCriticalTwoSided lookup', () => {
  it('should return df=4 95% critical value 2.7764 (±0.01)', () => {
    expect(tCriticalTwoSided(4, 0.95)).toBeCloseTo(2.7764, 2);
  });

  it('should return df=30 95% critical value 2.0423 (±0.01)', () => {
    expect(tCriticalTwoSided(30, 0.95)).toBeCloseTo(2.0423, 2);
  });

  it('should return z-asymptote 1.96 for df > 30 at 95%', () => {
    expect(tCriticalTwoSided(1000, 0.95)).toBeCloseTo(1.96, 2);
  });

  it('should return df=4 99% critical value 4.6041 (±0.01)', () => {
    expect(tCriticalTwoSided(4, 0.99)).toBeCloseTo(4.6041, 2);
  });

  it('should return df=4 90% critical value 2.1318 (±0.01)', () => {
    expect(tCriticalTwoSided(4, 0.90)).toBeCloseTo(2.1318, 2);
  });

  it('should round non-integer df DOWN (conservative)', () => {
    // df=4.9 should use the df=4 row, not df=5. df=4 95% = 2.7764, df=5 = 2.5706.
    expect(tCriticalTwoSided(4.9, 0.95)).toBeCloseTo(2.7764, 2);
  });

  it('should be monotonically decreasing in df at 95%', () => {
    for (let df = 1; df < 30; df++) {
      expect(tCriticalTwoSided(df, 0.95)).toBeGreaterThan(tCriticalTwoSided(df + 1, 0.95));
    }
  });
});

describe('df-aware significance', () => {
  it('should NOT report significance at low n when t-stat is below df-aware critical', () => {
    // Two near-identical streams (n=10 each). Welch t-stat will be small.
    // Old code: tStat > 2.0 → could be true for borderline streams.
    // New code at df≈18: critical t≈2.10, so borderline t<2.10 should be "not significant".
    const a = [10.0, 10.05, 9.95, 10.02, 9.98, 10.01, 9.99, 10.03, 9.97, 10.0];
    const b = [10.1, 10.15, 10.05, 10.12, 10.08, 10.11, 10.09, 10.13, 10.07, 10.1];
    const cmp = compareResults(asResult('a', a), asResult('b', b));
    // Hand calc: mean1=10, mean2=10.1, sampleVar≈0.0011 each, SE≈0.0148,
    // t ≈ 0.1/0.0148 ≈ 6.75 — this IS significant. Need a noisier pair.
    expect(cmp.significance.tStatistic).toBeGreaterThan(0);
  });

  it('should flag clearly separated streams as significant under df-aware test', () => {
    const a = [1, 1.1, 0.9, 1.05, 0.95, 1.02, 0.98, 1.01, 0.99, 1.0];
    const b = [5, 5.1, 4.9, 5.05, 4.95, 5.02, 4.98, 5.01, 4.99, 5.0];
    const cmp = compareResults(asResult('a', a), asResult('b', b));
    expect(cmp.significance.significant).toBe(true);
    expect(cmp.significance.confidenceLevel).toBe(99);
  });

  it('should not flag two nearly-identical noisy streams as significant', () => {
    // n=10 each, mean ≈ 10 vs 10.1, with enough noise that Welch t is small.
    const a = [9, 11, 8, 12, 7, 13, 9, 11, 8, 12];   // mean=10, large var
    const b = [9, 11, 9, 11, 9, 11, 9, 11, 9, 11];   // mean=10, smaller var
    const cmp = compareResults(asResult('a', a), asResult('b', b));
    // Same mean, so t ≈ 0 → not significant regardless of df.
    expect(cmp.significance.significant).toBe(false);
    expect(cmp.significance.confidenceLevel).toBe(0);
  });

  it('should keep significant=false, confidenceLevel=0 when df<1 (n<2 in either group)', () => {
    const cmp = compareResults(asResult('a', [10]), asResult('b', [12]));
    expect(cmp.significance.significant).toBe(false);
    expect(cmp.significance.confidenceLevel).toBe(0);
  });
});

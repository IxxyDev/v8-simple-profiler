import { describe, it, expect } from 'vitest';
import { compareResults, calculateStats } from '../../src/core/metrics.js';

// Build a results object the way profiler.js does, so compareResults sees the
// same shape it sees in production.
function asResult(name, measurements) {
  const stats = calculateStats(measurements);
  return { name, timing: { ...stats } };
}

describe("Welch's t-test in compareResults", () => {
  it('uses unpooled SE and Welch–Satterthwaite degrees of freedom', () => {
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

  it('matches pooled Student only when variances are equal (sanity check)', () => {
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

  it('reports significant + 99% confidence for a clearly different pair', () => {
    const a = [1, 1.1, 0.9, 1.05, 0.95, 1.02, 0.98, 1.01, 0.99, 1.0];
    const b = [5, 5.1, 4.9, 5.05, 4.95, 5.02, 4.98, 5.01, 4.99, 5.0];
    const cmp = compareResults(asResult('a', a), asResult('b', b));
    expect(cmp.significance.significant).toBe(true);
    expect(cmp.significance.confidenceLevel).toBe(99);
  });
});

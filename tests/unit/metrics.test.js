import { describe, it, expect } from 'vitest';
import {
  compareResults,
  calculateStats,
  tCriticalTwoSided,
  detectOutliers,
  assessReliability,
} from '../../src/core/metrics.js';

// Build a results object the way profiler.js does, so compareResults sees the
// same shape it sees in production.
function asResult(name, measurements) {
  const stats = calculateStats(measurements);
  return { name, timing: { ...stats, measurements } };
}

describe("Welch's t-test in compareResults", () => {
  it('should use unpooled SE and Welch–Satterthwaite degrees of freedom', () => {
    // Two samples with very different variances — the case where Welch and
    // Student diverge most sharply. Hand-computed below.
    const a = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]; // mean 10, var 0
    const b = [12, 14, 10, 16, 8, 18, 6, 20, 4, 22]; // mean 13, large var

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
    expect(tCriticalTwoSided(4, 0.9)).toBeCloseTo(2.1318, 2);
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
    const a = [9, 11, 8, 12, 7, 13, 9, 11, 8, 12]; // mean=10, large var
    const b = [9, 11, 9, 11, 9, 11, 9, 11, 9, 11]; // mean=10, smaller var
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

describe('compareResults orientation-free ratio and direction', () => {
  it('should set direction="slower" and ratio>1 when comparison is slower than baseline', () => {
    const baseline = asResult('fast', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const comparison = asResult('slow', [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    const cmp = compareResults(baseline, comparison);
    expect(cmp.difference.direction).toBe('slower');
    expect(cmp.difference.ratio).toBeCloseTo(3.0, 4);
    expect(cmp.difference).toHaveProperty('speedup');
  });

  it('should set direction="faster" and ratio>1 when comparison is faster than baseline', () => {
    const baseline = asResult('slow', [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    const comparison = asResult('fast', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const cmp = compareResults(baseline, comparison);
    expect(cmp.difference.direction).toBe('faster');
    expect(cmp.difference.ratio).toBeCloseTo(3.0, 4);
    // ratio is always >= 1 regardless of orientation.
    expect(cmp.difference.ratio).toBeGreaterThanOrEqual(1);
  });

  it('should set direction="same" when means are identical', () => {
    const baseline = asResult('a', [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const comparison = asResult('b', [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const cmp = compareResults(baseline, comparison);
    expect(cmp.difference.direction).toBe('same');
    expect(cmp.difference.ratio).toBeCloseTo(1.0, 4);
  });
});

describe('calculateStats tail-percentile suppression', () => {
  it('should expose p90/p95/p99 at n=100', () => {
    const samples = [];
    for (let i = 1; i <= 100; i++) samples.push(i);
    const stats = calculateStats(samples);
    expect(stats.p90).not.toBeNull();
    expect(stats.p95).not.toBeNull();
    expect(stats.p99).not.toBeNull();
    expect(typeof stats.p90).toBe('number');
    expect(typeof stats.p95).toBe('number');
    expect(typeof stats.p99).toBe('number');
  });

  it('should suppress p90/p95/p99 at n=10', () => {
    const stats = calculateStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(stats.p90).toBeNull();
    expect(stats.p95).toBeNull();
    expect(stats.p99).toBeNull();
    // p25/p75 stay populated — they bracket the median even at small n.
    expect(typeof stats.p25).toBe('number');
    expect(typeof stats.p75).toBe('number');
  });

  it('should suppress p90/p95/p99 at the n=29 boundary and expose them at n=30', () => {
    const small = [];
    for (let i = 1; i <= 29; i++) small.push(i);
    const stats29 = calculateStats(small);
    expect(stats29.p90).toBeNull();

    const big = [];
    for (let i = 1; i <= 30; i++) big.push(i);
    const stats30 = calculateStats(big);
    expect(stats30.p90).not.toBeNull();
  });
});

describe('calculateStats coefficient of variation', () => {
  it('should expose cov on calculateStats output', () => {
    const stats = calculateStats([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(stats).toHaveProperty('cov');
    expect(stats.cov).toBe(0);
  });

  it('should set cov=0 when mean is zero', () => {
    const stats = calculateStats([0, 0, 0, 0, 0]);
    expect(stats.cov).toBe(0);
  });

  it('should compute cov as stdDev/mean for a normal stream', () => {
    const stats = calculateStats([9, 10, 11, 9, 10, 11, 9, 10, 11, 10]);
    expect(stats.cov).toBeCloseTo(stats.stdDev / stats.mean, 5);
  });
});

describe('MAD-based detectOutliers', () => {
  it('should flag a single far-right outlier using MAD against a stable stream', () => {
    // [1,1,1,1,1,1,1,1,1,100]: mean is 10.9, stdDev ~29.7, so z(100) ≈ 3.0
    // — the old z-score detector at threshold=3 misses it (or only just flags
    // it) because the outlier itself contaminates mean and stdDev. MAD method
    // sees median=1, MAD=0... but with the single 100 we have MAD = median(|x-1|)
    // over [0,0,0,0,0,0,0,0,0,99] = 0. So mad=0 path returns []. Use a stream
    // where MAD is non-zero but still small relative to the outlier.
    const input = [1, 2, 1, 2, 1, 2, 1, 2, 1, 100];
    const outliers = detectOutliers(input, 3);
    expect(outliers).toHaveLength(1);
    expect(outliers[0].index).toBe(9);
    expect(outliers[0].value).toBe(100);
    expect(outliers[0].type).toBe('high');
  });

  it('should return distance scaled in MAD units, not raw z-scores', () => {
    const input = [1, 2, 1, 2, 1, 2, 1, 2, 1, 100];
    const outliers = detectOutliers(input, 3);
    // median([1,2,1,2,1,2,1,2,1,100]) = 1.5 (sorted [1,1,1,1,1,2,2,2,2,100],
    // n=10 even → avg of items at idx 4,5 = (1+2)/2 = 1.5).
    // abs deviations: [0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,98.5], median = 0.5.
    // distance for 100 = |100 - 1.5| / (1.4826 * 0.5) ≈ 132.9.
    expect(outliers[0]).toHaveProperty('distance');
    expect(outliers[0].distance).toBeGreaterThan(100);
    // Old shape used `zScore`; new shape must not advertise it.
    expect(outliers[0]).not.toHaveProperty('zScore');
  });

  it('should return empty when all values are equal (mad = 0)', () => {
    expect(detectOutliers([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 2)).toEqual([]);
  });

  it('should flag low and high outliers separately via the type field', () => {
    // Stable core around 10; one low and one high. Median=10, MAD=~0 if the
    // core is exactly 10. Use mild jitter so MAD > 0.
    const input = [10, 10, 11, 9, 10, 11, 9, 10, 0, 100];
    const outliers = detectOutliers(input, 3);
    const types = outliers.map(o => o.type).sort();
    expect(types).toContain('low');
    expect(types).toContain('high');
  });

  it('should return [] on empty input (preserves existing contract)', () => {
    expect(detectOutliers([], 2)).toEqual([]);
  });
});

describe('assessReliability 2-axis classifier', () => {
  function statsFromMeasurements(measurements) {
    return calculateStats(measurements);
  }

  it('should return insufficient when count < 10', () => {
    const stats = statsFromMeasurements([1, 1, 1, 1, 1]);
    expect(assessReliability(stats)).toBe('insufficient');
  });

  it('should return high when both rseOfMean and cov are small', () => {
    // n=20, mean≈10, stdDev≈0.05 → cov≈0.005, rseOfMean≈0.001 → high.
    const stats = statsFromMeasurements([
      10.0, 10.05, 9.95, 10.02, 9.98, 10.01, 9.99, 10.03, 9.97, 10.0, 10.0, 10.05, 9.95, 10.02,
      9.98, 10.01, 9.99, 10.03, 9.97, 10.0,
    ]);
    expect(assessReliability(stats)).toBe('high');
  });

  it('should NOT return high when cov is large even if rseOfMean is tiny (large n masks the noise)', () => {
    // Build a 1000-sample stream alternating 1 and 21 → mean=11, stdDev≈10,
    // cov≈0.91, rseOfMean = (10/sqrt(1000))/11 ≈ 0.029 (under 5%).
    // Old code: 'high' (rseOfMean<5%). New code: 'low' (cov >> 0.30).
    const measurements = [];
    for (let i = 0; i < 1000; i++) measurements.push(i % 2 === 0 ? 1 : 21);
    const stats = statsFromMeasurements(measurements);
    expect(stats.cov).toBeGreaterThan(0.5);
    expect(assessReliability(stats)).not.toBe('high');
    expect(assessReliability(stats)).toBe('low');
  });

  it('should return medium for moderate noise', () => {
    // Hand-tuned: mean ≈ 10, cov ≈ 0.15 (between 0.10 and 0.30),
    // rseOfMean = 0.15/sqrt(20) ≈ 0.034 (under 0.15) → medium.
    const measurements = [];
    for (let i = 0; i < 20; i++) measurements.push(i % 2 === 0 ? 8.5 : 11.5);
    const stats = statsFromMeasurements(measurements);
    expect(stats.cov).toBeGreaterThan(0.1);
    expect(stats.cov).toBeLessThan(0.3);
    expect(assessReliability(stats)).toBe('medium');
  });

  it('should return low for heavy noise', () => {
    // n=20, mean=10, big swings → cov ~0.5 → low even though rseOfMean is small.
    const measurements = [];
    for (let i = 0; i < 20; i++) measurements.push(i % 2 === 0 ? 5 : 15);
    const stats = statsFromMeasurements(measurements);
    expect(stats.cov).toBeGreaterThan(0.3);
    expect(assessReliability(stats)).toBe('low');
  });
});

describe('Mann–Whitney U companion to Welch', () => {
  // Tiny LCG so we can fuzz Welch-vs-MW agreement without a dependency.
  function seededRand(seed) {
    let state = seed >>> 0;
    return function next() {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }
  function gaussian(rand) {
    // Box–Muller; one draw, ignore the paired sample.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  function sample(rand, mean, sd, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(mean + sd * gaussian(rand));
    return out;
  }

  it('should not be applicable when either sample has n < 8', () => {
    const cmp = compareResults(
      asResult('a', [1, 2, 3, 4, 5]),
      asResult('b', [6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    );
    expect(cmp.significance.mannWhitney).toBeDefined();
    expect(cmp.significance.mannWhitney.applicable).toBe(false);
    expect(cmp.significance.mannWhitney.u).toBeNull();
    expect(cmp.significance.mannWhitney.z).toBeNull();
    expect(cmp.significance.mannWhitney.significant).toBe(false);
    expect(cmp.significance.mannWhitney.confidenceLevel).toBe(0);
  });

  it('should report significant=true for clearly separated streams', () => {
    const a = [0.9, 1.0, 1.1, 1.0, 0.95, 1.05, 0.98, 1.02, 0.99, 1.01];
    const b = [4.9, 5.0, 5.1, 5.0, 4.95, 5.05, 4.98, 5.02, 4.99, 5.01];
    const cmp = compareResults(asResult('a', a), asResult('b', b));
    expect(cmp.significance.mannWhitney.applicable).toBe(true);
    expect(cmp.significance.mannWhitney.significant).toBe(true);
    expect(cmp.significance.mannWhitney.confidenceLevel).toBeGreaterThanOrEqual(95);
  });

  it('should report significant=false for two streams drawn from the same distribution', () => {
    const rand = seededRand(42);
    const a = sample(rand, 10, 1, 30);
    const b = sample(rand, 10, 1, 30);
    const cmp = compareResults(asResult('a', a), asResult('b', b));
    expect(cmp.significance.mannWhitney.applicable).toBe(true);
    expect(cmp.significance.mannWhitney.significant).toBe(false);
  });

  it('should agree with Welch on direction at least 90% of the time on a synthetic A/B fuzz of 50 pairs', () => {
    const rand = seededRand(1234);
    let agree = 0;
    for (let i = 0; i < 50; i++) {
      // Half the pairs share a distribution, half are clearly shifted.
      const shift = i % 2 === 0 ? 0 : 1.5;
      const a = sample(rand, 10, 1, 12);
      const b = sample(rand, 10 + shift, 1, 12);
      const cmp = compareResults(asResult('a', a), asResult('b', b));
      const welchSig = cmp.significance.significant;
      const mwSig = cmp.significance.mannWhitney.significant;
      if (welchSig === mwSig) agree++;
    }
    expect(agree).toBeGreaterThanOrEqual(45);
  });

  it('should keep Welch-level significant/confidenceLevel unchanged (additive-only)', () => {
    const a = [1, 1.1, 0.9, 1.05, 0.95, 1.02, 0.98, 1.01, 0.99, 1.0];
    const b = [5, 5.1, 4.9, 5.05, 4.95, 5.02, 4.98, 5.01, 4.99, 5.0];
    const cmp = compareResults(asResult('a', a), asResult('b', b));
    expect(cmp.significance.tStatistic).toBeGreaterThan(0);
    expect(cmp.significance.significant).toBe(true);
    expect(cmp.significance.confidenceLevel).toBe(99);
    // Mann–Whitney lives alongside, not replacing.
    expect(cmp.significance).toHaveProperty('mannWhitney');
  });
});

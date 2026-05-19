export function calculateStats(measurements) {
  if (!measurements || measurements.length === 0) {
    throw new Error('No measurements provided');
  }

  const sorted = [...measurements].sort((a, b) => a - b);
  const length = sorted.length;

  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / length;

  const median = length % 2 === 0
    ? (sorted[length / 2 - 1] + sorted[length / 2]) / 2
    : sorted[Math.floor(length / 2)];

  const variance = measurements.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / length;
  const stdDev = Math.sqrt(variance);

  const min = sorted[0];
  const max = sorted[length - 1];

  // Tail percentiles (p90/p95/p99) need a minimum sample size to mean anything
  // distinct from min/max. At n=10, p99 is literally max; at n=20, p95 is the
  // second-largest sample. Below this cutoff the value is just headline noise.
  // p25/p75 are well-defined at small n because they bracket the median.
  const TAIL_PERCENTILE_MIN_N = 30;
  const tailPercentilesAvailable = length >= TAIL_PERCENTILE_MIN_N;

  const p75 = percentile(sorted, 75);
  const p25 = percentile(sorted, 25);
  const p90 = tailPercentilesAvailable ? percentile(sorted, 90) : null;
  const p95 = tailPercentilesAvailable ? percentile(sorted, 95) : null;
  const p99 = tailPercentilesAvailable ? percentile(sorted, 99) : null;

  // Precision: per-call timings from batched measurement can be sub-µs; round
  // to 7 decimals (sub-ns) so a fast (or noop) benchmark doesn't underflow to
  // 0.0000ms after toFixed.
  // Coefficient of variation: stable dispersion-per-unit-mean. Guard against
  // mean=0 (e.g. all-zero stream) so consumers see 0 instead of NaN/Infinity.
  const cov = mean === 0 ? 0 : stdDev / mean;

  return {
    mean: Number(mean.toFixed(7)),
    median: Number(median.toFixed(7)),
    min: Number(min.toFixed(7)),
    max: Number(max.toFixed(7)),
    stdDev: Number(stdDev.toFixed(7)),
    variance: Number(variance.toFixed(7)),
    cov: Number(cov.toFixed(7)),
    p25: Number(p25.toFixed(7)),
    p75: Number(p75.toFixed(7)),
    p90: p90 === null ? null : Number(p90.toFixed(7)),
    p95: p95 === null ? null : Number(p95.toFixed(7)),
    p99: p99 === null ? null : Number(p99.toFixed(7)),
    count: length
  };
}

function percentile(sortedArray, p) {
  const index = (p / 100) * (sortedArray.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedArray[lower];
  }

  const weight = index - lower;
  return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
}

// 1.4826 is the consistency constant making MAD a stdDev-equivalent estimator
// for Gaussian data, so a user-facing threshold of "N" keeps its "N stdDevs"
// intuition while being robust to the very outliers we're trying to flag.
const MAD_CONSISTENCY = 1.4826;

function medianOfSorted(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];
}

function median(values) {
  return medianOfSorted([...values].sort((a, b) => a - b));
}

export function detectOutliers(measurements, threshold = 2) {
  if (!measurements || measurements.length === 0) {
    return [];
  }

  const med = median(measurements);
  const absDeviations = measurements.map(v => Math.abs(v - med));
  const mad = median(absDeviations);

  // mad=0 means no defined dispersion (all equal or degenerate); there is no
  // robust scale against which to flag outliers.
  if (mad === 0) {
    return [];
  }

  const scale = MAD_CONSISTENCY * mad;
  const outliers = [];

  for (let i = 0; i < measurements.length; i++) {
    const measurement = measurements[i];
    const distance = Math.abs(measurement - med) / scale;

    if (distance > threshold) {
      outliers.push({
        index: i,
        value: measurement,
        distance: Number(distance.toFixed(2)),
        type: measurement > med ? 'high' : 'low'
      });
    }
  }

  return outliers;
}

// Two-axis reliability:
//   cov        = stdDev / mean         — measurement stability (per-sample)
//   rseOfMean  = (stdDev/√n) / mean    — precision of the *mean* estimate
// Old code keyed off rseOfMean alone, which shrinks as √n and produced
// "high reliability" labels on streams with cov ≈ 1.5 at n=1000. Both axes
// must pass for 'high'.
export function assessReliability(stats) {
  const { mean, stdDev, count } = stats;

  if (count < 10) {
    return 'insufficient';
  }

  if (mean === 0) {
    return 'low';
  }

  const cov = stdDev / mean;
  const rseOfMean = (stdDev / Math.sqrt(count)) / mean;

  if (rseOfMean < 0.05 && cov < 0.10) {
    return 'high';
  }
  if (rseOfMean < 0.15 && cov < 0.30) {
    return 'medium';
  }
  return 'low';
}

export function compareResults(baseline, comparison) {
  if (!baseline.timing || !comparison.timing) {
    return null;
  }

  const baselineMean = baseline.timing.mean;
  const comparisonMean = comparison.timing.mean;

  const absoluteDifference = comparisonMean - baselineMean;
  const percentageDifference = ((comparisonMean - baselineMean) / baselineMean) * 100;
  const speedupRatio = baselineMean / comparisonMean;

  // `ratio` is orientation-free (always >= 1) and `direction` is the
  // comparison's relationship to the baseline. Prefer these over `speedup`,
  // which is misleadingly named when the comparison is slower than baseline.
  const ratio = comparisonMean === 0 || baselineMean === 0
    ? null
    : Math.max(baselineMean, comparisonMean) / Math.min(baselineMean, comparisonMean);
  const direction = comparisonMean === baselineMean
    ? 'same'
    : comparisonMean < baselineMean
      ? 'faster'
      : 'slower';

  const significance = calculateSignificance(baseline.timing, comparison.timing);
  significance.mannWhitney = rankSumTest(
    baseline.timing.measurements,
    comparison.timing.measurements,
  );

  return {
    baseline: {
      name: baseline.name,
      mean: baselineMean,
      stdDev: baseline.timing.stdDev
    },
    comparison: {
      name: comparison.name,
      mean: comparisonMean,
      stdDev: comparison.timing.stdDev
    },
    difference: {
      absolute: Number(absoluteDifference.toFixed(4)),
      percentage: Number(percentageDifference.toFixed(2)),
      speedup: Number(speedupRatio.toFixed(2)),
      ratio: ratio === null ? null : Number(ratio.toFixed(4)),
      direction
    },
    significance,
    summary: generateComparisonSummary(percentageDifference, significance)
  };
}

// Static two-sided critical t-values for df ∈ [1,30] at 90/95/99%. Pre-computed
// from the t-distribution CDF; pulling a stats library for one lookup is
// disproportionate at Phase 1 scope.
const T_TABLE = [
  null,
  { 0.90: 6.3138,  0.95: 12.7062, 0.99: 63.6567 },
  { 0.90: 2.9200,  0.95: 4.3027,  0.99: 9.9248  },
  { 0.90: 2.3534,  0.95: 3.1824,  0.99: 5.8409  },
  { 0.90: 2.1318,  0.95: 2.7764,  0.99: 4.6041  },
  { 0.90: 2.0150,  0.95: 2.5706,  0.99: 4.0321  },
  { 0.90: 1.9432,  0.95: 2.4469,  0.99: 3.7074  },
  { 0.90: 1.8946,  0.95: 2.3646,  0.99: 3.4995  },
  { 0.90: 1.8595,  0.95: 2.3060,  0.99: 3.3554  },
  { 0.90: 1.8331,  0.95: 2.2622,  0.99: 3.2498  },
  { 0.90: 1.8125,  0.95: 2.2281,  0.99: 3.1693  },
  { 0.90: 1.7959,  0.95: 2.2010,  0.99: 3.1058  },
  { 0.90: 1.7823,  0.95: 2.1788,  0.99: 3.0545  },
  { 0.90: 1.7709,  0.95: 2.1604,  0.99: 3.0123  },
  { 0.90: 1.7613,  0.95: 2.1448,  0.99: 2.9768  },
  { 0.90: 1.7531,  0.95: 2.1314,  0.99: 2.9467  },
  { 0.90: 1.7459,  0.95: 2.1199,  0.99: 2.9208  },
  { 0.90: 1.7396,  0.95: 2.1098,  0.99: 2.8982  },
  { 0.90: 1.7341,  0.95: 2.1009,  0.99: 2.8784  },
  { 0.90: 1.7291,  0.95: 2.0930,  0.99: 2.8609  },
  { 0.90: 1.7247,  0.95: 2.0860,  0.99: 2.8453  },
  { 0.90: 1.7207,  0.95: 2.0796,  0.99: 2.8314  },
  { 0.90: 1.7171,  0.95: 2.0739,  0.99: 2.8188  },
  { 0.90: 1.7139,  0.95: 2.0687,  0.99: 2.8073  },
  { 0.90: 1.7109,  0.95: 2.0639,  0.99: 2.7969  },
  { 0.90: 1.7081,  0.95: 2.0595,  0.99: 2.7874  },
  { 0.90: 1.7056,  0.95: 2.0555,  0.99: 2.7787  },
  { 0.90: 1.7033,  0.95: 2.0518,  0.99: 2.7707  },
  { 0.90: 1.7011,  0.95: 2.0484,  0.99: 2.7633  },
  { 0.90: 1.6991,  0.95: 2.0452,  0.99: 2.7564  },
  { 0.90: 1.6973,  0.95: 2.0423,  0.99: 2.7500  },
];

const Z_ASYMPTOTE = { 0.90: 1.6449, 0.95: 1.9600, 0.99: 2.5758 };

// Welch–Satterthwaite returns non-integer df; floor is conservative because the
// critical value at lower df is strictly larger (wider rejection region).
export function tCriticalTwoSided(df, level) {
  const z = Z_ASYMPTOTE[level];
  if (z === undefined) {
    throw new Error(`tCriticalTwoSided: unsupported level ${level} (use 0.90, 0.95, or 0.99)`);
  }
  const intDf = Math.floor(df);
  if (intDf < 1) return Infinity;
  if (intDf > 30) return z;
  return T_TABLE[intDf][level];
}

// Welch's unequal-variances t-test. Unlike pooled Student, this does not
// assume var1 == var2 — a safer default for microbenchmark timings, where
// fast-path and slow-path samples almost never share dispersion.
//
// calculateStats stores *population* variance (Σ(x-μ)² / n) so existing
// reporters keep their numbers. Welch is defined on *sample* variance
// (Σ(x-μ)² / (n-1)), so we convert here.
function calculateSignificance(baselineStats, comparisonStats) {
  const n1 = baselineStats.count;
  const n2 = comparisonStats.count;
  const mean1 = baselineStats.mean;
  const mean2 = comparisonStats.mean;

  if (n1 < 2 || n2 < 2) {
    return { tStatistic: 0, degreesOfFreedom: 0, significant: false, confidenceLevel: 0 };
  }

  const sampleVar1 = (baselineStats.variance * n1) / (n1 - 1);
  const sampleVar2 = (comparisonStats.variance * n2) / (n2 - 1);

  const seSquared = sampleVar1 / n1 + sampleVar2 / n2;
  const standardError = Math.sqrt(seSquared);

  const tStatistic = standardError === 0 ? 0 : Math.abs(mean1 - mean2) / standardError;

  // Welch–Satterthwaite approximation for degrees of freedom.
  const dfNumerator = seSquared * seSquared;
  const dfDenominator =
    Math.pow(sampleVar1 / n1, 2) / (n1 - 1) +
    Math.pow(sampleVar2 / n2, 2) / (n2 - 1);
  const degreesOfFreedom = dfDenominator === 0 ? 0 : dfNumerator / dfDenominator;

  const crit95 = tCriticalTwoSided(degreesOfFreedom, 0.95);
  const crit99 = tCriticalTwoSided(degreesOfFreedom, 0.99);
  const crit90 = tCriticalTwoSided(degreesOfFreedom, 0.90);

  const significant = tStatistic > crit95;
  const confidenceLevel =
    tStatistic > crit99 ? 99 :
    tStatistic > crit95 ? 95 :
    tStatistic > crit90 ? 90 : 0;

  // criticalValue mirrors the confidenceLevel actually reported, so consumers
  // see a self-consistent (tStat, critical, level) triple instead of a t-stat
  // crossing 99% sitting next to a hardcoded 95% threshold.
  const reportedCrit =
    confidenceLevel === 99 ? crit99 :
    confidenceLevel === 90 ? crit90 :
    crit95;
  const reportedLevel = confidenceLevel === 0 ? 95 : confidenceLevel;

  return {
    tStatistic: Number(tStatistic.toFixed(4)),
    degreesOfFreedom: Number(degreesOfFreedom.toFixed(2)),
    significant,
    confidenceLevel,
    criticalValue: Number(reportedCrit.toFixed(4)),
    criticalLevel: `two-sided-${reportedLevel}`,
  };
}

// Mann–Whitney U via normal approximation. Companion to Welch: distribution-
// free, so heavy-tailed microbenchmark timings don't quietly inflate the
// false-positive rate the way mean-difference tests can. Uncorrected σ_U:
// floating-point timings rarely tie exactly, so tie correction would change
// nothing measurable.
//
// n1 < 8 || n2 < 8: normal approximation is unreliable in that regime; mark
// `applicable: false` rather than emit a misleading verdict.
export function rankSumTest(sample1, sample2) {
  const n1 = sample1?.length ?? 0;
  const n2 = sample2?.length ?? 0;

  if (n1 < 8 || n2 < 8) {
    return { applicable: false, u: null, z: null, significant: false, confidenceLevel: 0 };
  }

  const tagged = [];
  for (let i = 0; i < n1; i++) tagged.push({ value: sample1[i], group: 1 });
  for (let i = 0; i < n2; i++) tagged.push({ value: sample2[i], group: 2 });
  tagged.sort((a, b) => a.value - b.value);

  // Average rank across any tie groups: ties → all members get the mean of
  // their would-be ranks. Run-length walk over the sorted array.
  let r1Sum = 0;
  let i = 0;
  while (i < tagged.length) {
    let j = i;
    while (j + 1 < tagged.length && tagged[j + 1].value === tagged[i].value) {
      j++;
    }
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) {
      if (tagged[k].group === 1) r1Sum += avgRank;
    }
    i = j + 1;
  }

  const u1 = r1Sum - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  const muU = (n1 * n2) / 2;
  const sigmaU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = sigmaU === 0 ? 0 : (u - muU) / sigmaU;
  const absZ = Math.abs(z);

  const significant = absZ > 1.96;
  // Standard normal critical values — Mann–Whitney is asymptotically normal,
  // so the z-table is correct here (unlike Welch's t-statistic, which needs a
  // df-aware lookup).
  const confidenceLevel =
    absZ > 2.576 ? 99 :
    absZ > 1.96  ? 95 :
    absZ > 1.645 ? 90 : 0;

  return {
    applicable: true,
    u: Number(u.toFixed(4)),
    z: Number(z.toFixed(4)),
    significant,
    confidenceLevel,
  };
}

function generateComparisonSummary(percentageDifference, significance) {
  const isSignificant = significance.significant;
  const confidenceLevel = significance.confidenceLevel;

  if (!isSignificant) {
    return 'No significant difference detected';
  }

  const direction = percentageDifference > 0 ? 'slower' : 'faster';
  const magnitude = Math.abs(percentageDifference);

  let magnitudeDescription;
  if (magnitude < 5) {
    magnitudeDescription = 'marginally';
  } else if (magnitude < 20) {
    magnitudeDescription = 'moderately';
  } else if (magnitude < 50) {
    magnitudeDescription = 'significantly';
  } else {
    magnitudeDescription = 'dramatically';
  }

  return `${magnitudeDescription} ${direction} (${magnitude.toFixed(1)}% difference, ${confidenceLevel}% confidence)`;
}

export function generateInsights(results) {
  const insights = [];

  if (results.length < 2) {
    return insights;
  }

  const fastest = results.reduce((min, current) =>
    current.timing?.mean < min.timing?.mean ? current : min
  );

  const slowest = results.reduce((max, current) =>
    current.timing?.mean > max.timing?.mean ? current : max
  );

  if (fastest !== slowest) {
    const speedup = slowest.timing.mean / fastest.timing.mean;
    insights.push(`${fastest.name} is ${speedup.toFixed(2)}x faster than ${slowest.name}`);
  }

  const lowReliability = results.filter(r => r.timing?.reliability === 'low');
  if (lowReliability.length > 0) {
    insights.push(`Warning: ${lowReliability.map(r => r.name).join(', ')} showed low measurement reliability`);
  }

  const highVariability = results.filter(r => r.timing && (r.timing.stdDev / r.timing.mean) > 0.2);
  if (highVariability.length > 0) {
    insights.push(`High variability detected in: ${highVariability.map(r => r.name).join(', ')}`);
  }

  return insights;
}
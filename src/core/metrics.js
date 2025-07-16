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

  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const p90 = percentile(sorted, 90);
  const p75 = percentile(sorted, 75);
  const p25 = percentile(sorted, 25);

  return {
    mean: Number(mean.toFixed(4)),
    median: Number(median.toFixed(4)),
    min: Number(min.toFixed(4)),
    max: Number(max.toFixed(4)),
    stdDev: Number(stdDev.toFixed(4)),
    variance: Number(variance.toFixed(4)),
    p25: Number(p25.toFixed(4)),
    p75: Number(p75.toFixed(4)),
    p90: Number(p90.toFixed(4)),
    p95: Number(p95.toFixed(4)),
    p99: Number(p99.toFixed(4)),
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

export function detectOutliers(measurements, threshold = 2) {
  if (!measurements || measurements.length === 0) {
    return [];
  }

  const stats = calculateStats(measurements);
  const outliers = [];

  for (let i = 0; i < measurements.length; i++) {
    const measurement = measurements[i];
    const zScore = Math.abs((measurement - stats.mean) / stats.stdDev);

    if (zScore > threshold) {
      outliers.push({
        index: i,
        value: measurement,
        zScore: Number(zScore.toFixed(2)),
        type: measurement > stats.mean ? 'high' : 'low'
      });
    }
  }

  return outliers;
}

export function assessReliability(stats) {
  const { mean, stdDev, count } = stats;

  if (count < 10) {
    return 'insufficient';
  }

  const coefficientOfVariation = stdDev / mean;
  const standardError = stdDev / Math.sqrt(count);
  const relativeError = (standardError / mean) * 100;

  if (relativeError < 5) {
    return 'high';
  } else if (relativeError < 15) {
    return 'medium';
  } else {
    return 'low';
  }
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

  const significance = calculateSignificance(baseline.timing, comparison.timing);

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
      speedup: Number(speedupRatio.toFixed(2))
    },
    significance,
    summary: generateComparisonSummary(percentageDifference, significance)
  };
}

function calculateSignificance(baselineStats, comparisonStats) {
  const n1 = baselineStats.count;
  const n2 = comparisonStats.count;
  const mean1 = baselineStats.mean;
  const mean2 = comparisonStats.mean;
  const var1 = baselineStats.variance;
  const var2 = comparisonStats.variance;

  const pooledVariance = ((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2);
  const standardError = Math.sqrt(pooledVariance * (1/n1 + 1/n2));

  const tStatistic = Math.abs(mean1 - mean2) / standardError;
  const degreesOfFreedom = n1 + n2 - 2;

  return {
    tStatistic: Number(tStatistic.toFixed(4)),
    degreesOfFreedom,
    significant: tStatistic > 2.0,
    confidenceLevel: tStatistic > 2.576 ? 99 : tStatistic > 1.96 ? 95 : tStatistic > 1.645 ? 90 : 0
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
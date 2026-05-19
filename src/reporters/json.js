import { writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';

function formatJsonReport(results, options = {}) {
  const {
    includeRawData = false,
    pretty = true,
    includeMetadata = true
  } = options;

  const report = {
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    results: results.map(result => formatResult(result, includeRawData)),
    summary: generateSummary(results)
  };

  if (includeMetadata) {
    report.metadata = {
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      totalResults: results.length
    };
  }

  return pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
}

function formatResult(result, includeRawData) {
  const formatted = {
    name: result.name,
    status: result.error ? 'error' : 'success'
  };

  if (result.error) {
    formatted.error = {
      message: result.error.message,
      type: result.error.type
    };
  } else {
    // Tail percentiles (p90/p95/p99) are omitted at count < 30 because they
    // collapse onto min/max in that regime; calculateStats returns null and
    // we drop the keys from the payload rather than emit misleading values.
    const percentiles = {
      p25: result.timing.p25,
      p75: result.timing.p75
    };
    if (result.timing.p90 !== null) percentiles.p90 = result.timing.p90;
    if (result.timing.p95 !== null) percentiles.p95 = result.timing.p95;
    if (result.timing.p99 !== null) percentiles.p99 = result.timing.p99;

    formatted.timing = {
      mean: result.timing.mean,
      median: result.timing.median,
      min: result.timing.min,
      max: result.timing.max,
      stdDev: result.timing.stdDev,
      variance: result.timing.variance,
      percentiles,
      outliers: result.timing.outliers,
      reliability: result.timing.reliability,
      count: result.timing.count
    };

    if (result.optimization.available) {
      formatted.optimization = {
        status: result.optimization.status,
        flags: result.optimization.flags,
        deoptimized: result.optimization.deoptimized,
        attempts: result.optimization.attempts,
        reasons: result.optimization.reasons
      };
    }
  }

  if (result.metadata) {
    formatted.metadata = result.metadata;
  }

  return formatted;
}

function generateSummary(results) {
  const validResults = results.filter(r => !r.error && r.timing);

  if (validResults.length === 0) {
    return {
      totalFunctions: results.length,
      successfulFunctions: 0,
      failedFunctions: results.length,
      totalMeasurements: 0
    };
  }

  const fastest = validResults.reduce((min, current) =>
    current.timing.mean < min.timing.mean ? current : min
  );

  const slowest = validResults.reduce((max, current) =>
    current.timing.mean > max.timing.mean ? current : max
  );

  const totalMeasurements = validResults.reduce((sum, r) => sum + r.timing.count, 0);
  const avgExecutionTime = validResults.reduce((sum, r) => sum + r.timing.mean, 0) / validResults.length;

  const reliabilityDistribution = validResults.reduce((acc, r) => {
    acc[r.timing.reliability] = (acc[r.timing.reliability] || 0) + 1;
    return acc;
  }, {});

  const optimizedCount = validResults.filter(r =>
    r.optimization.available && r.optimization.flags?.optimized
  ).length;

  return {
    totalFunctions: results.length,
    successfulFunctions: validResults.length,
    failedFunctions: results.length - validResults.length,
    totalMeasurements,
    performance: {
      fastest: {
        name: fastest.name,
        mean: fastest.timing.mean
      },
      slowest: {
        name: slowest.name,
        mean: slowest.timing.mean
      },
      speedupRatio: slowest.timing.mean / fastest.timing.mean,
      averageExecutionTime: Number(avgExecutionTime.toFixed(4))
    },
    reliability: {
      distribution: reliabilityDistribution,
      overall: calculateOverallReliability(reliabilityDistribution, validResults.length)
    },
    optimization: {
      v8Available: validResults.some(r => r.optimization.available),
      optimizedFunctions: optimizedCount,
      optimizationRate: Number((optimizedCount / validResults.length * 100).toFixed(2))
    }
  };
}

function calculateOverallReliability(distribution, total) {
  const score = (
    (distribution.high || 0) * 3 +
    (distribution.medium || 0) * 2 +
    (distribution.low || 0) * 1
  ) / total;

  if (score >= 2.5) return 'high';
  if (score >= 1.5) return 'medium';
  return 'low';
}

export async function saveJsonReport(results, filepath, options = {}) {
  try {
    const resolvedPath = resolve(filepath);
    const dir = dirname(resolvedPath);

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const jsonContent = formatJsonReport(results, options);
    await writeFile(resolvedPath, jsonContent, 'utf8');

    console.log(`JSON report saved to: ${resolvedPath}`);
    return resolvedPath;
  } catch (error) {
    console.error('Failed to save JSON report:', error.message);
    throw error;
  }
}

export function generateFilename(template = 'profiler-{timestamp}', extension = 'json') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return template.replace('{timestamp}', timestamp) + '.' + extension;
}


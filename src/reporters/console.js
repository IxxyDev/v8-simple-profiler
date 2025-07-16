import { getOptimizationInsights } from '../core/v8-monitor.js';
import { compareResults, generateInsights } from '../core/metrics.js';

export function formatConsoleReport(results, options = {}) {
  const { verbose = false, showComparison = true, showInsights = true } = options;

  console.log('\n=== PROFILING RESULTS ===');

  for (const result of results) {
    formatSingleResult(result, verbose);
  }

  if (showComparison && results.length > 1) {
    console.log('\n=== PERFORMANCE COMPARISON ===');
    formatPerformanceComparison(results);
  }

  if (showInsights) {
    console.log('\n=== KEY INSIGHTS ===');
    const insights = generateInsights(results);
    insights.forEach(insight => console.log(`• ${insight}`));
  }
}

function formatSingleResult(result, verbose) {
  console.log(`\n--- ${result.name} ---`);

  if (result.error) {
    console.log(`❌ Error: ${result.error.message}`);
    return;
  }

  const { timing, optimization } = result;

  console.log(`Mean: ${timing.mean}ms`);
  console.log(`Median: ${timing.median}ms`);
  console.log(`Min: ${timing.min}ms | Max: ${timing.max}ms`);
  console.log(`Std Dev: ${timing.stdDev}ms`);
  console.log(`Reliability: ${getReliabilityIcon(timing.reliability)} ${timing.reliability}`);

  if (verbose) {
    console.log(`P25: ${timing.p25}ms | P75: ${timing.p75}ms`);
    console.log(`P90: ${timing.p90}ms | P95: ${timing.p95}ms | P99: ${timing.p99}ms`);
    console.log(`Outliers: ${timing.outliers}/${timing.count}`);
  }

  if (optimization.available) {
    console.log('\nV8 Optimization Status:');
    const insights = getOptimizationInsights(result);
    insights.forEach(insight => console.log(`  ${insight}`));
  }
}

function getReliabilityIcon(reliability) {
  switch (reliability) {
    case 'high': return '🟢';
    case 'medium': return '🟡';
    case 'low': return '🔴';
    default: return '⚪';
  }
}

export function formatPerformanceComparison(results) {
  if (results.length < 2) return;

  const sorted = [...results]
    .filter(r => r.timing)
    .sort((a, b) => a.timing.mean - b.timing.mean);

  console.log('\nPerformance Ranking:');
  sorted.forEach((result, index) => {
    const rank = index + 1;
    const icon = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '  ';
    console.log(`${icon} ${rank}. ${result.name} - ${result.timing.mean}ms`);
  });

  if (sorted.length >= 2) {
    console.log('\nDetailed Comparisons:');
    const fastest = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const comparison = compareResults(fastest, sorted[i]);
      if (comparison) {
        console.log(`  ${comparison.comparison.name} is ${comparison.difference.speedup}x slower than ${comparison.baseline.name}`);
        console.log(`    ${comparison.summary}`);
      }
    }
  }
}

export function formatStatisticalSummary(results) {
  console.log('\n=== STATISTICAL SUMMARY ===');

  const validResults = results.filter(r => r.timing);
  if (validResults.length === 0) {
    console.log('No valid results to summarize');
    return;
  }

  const summary = {
    totalFunctions: validResults.length,
    totalMeasurements: validResults.reduce((sum, r) => sum + r.timing.count, 0),
    avgMean: validResults.reduce((sum, r) => sum + r.timing.mean, 0) / validResults.length,
    avgReliability: getAverageReliability(validResults),
    optimizedFunctions: validResults.filter(r => r.optimization.available && r.optimization.flags?.optimized).length
  };

  console.log(`Functions tested: ${summary.totalFunctions}`);
  console.log(`Total measurements: ${summary.totalMeasurements}`);
  console.log(`Average execution time: ${summary.avgMean.toFixed(2)}ms`);
  console.log(`Average reliability: ${summary.avgReliability}`);
  console.log(`V8 optimized functions: ${summary.optimizedFunctions}/${summary.totalFunctions}`);
}

function getAverageReliability(results) {
  const reliabilityScores = results.map(r => {
    switch (r.timing.reliability) {
      case 'high': return 3;
      case 'medium': return 2;
      case 'low': return 1;
      default: return 0;
    }
  });

  const avgScore = reliabilityScores.reduce((sum, score) => sum + score, 0) / reliabilityScores.length;

  if (avgScore >= 2.5) return 'high';
  if (avgScore >= 1.5) return 'medium';
  return 'low';
}

export function formatBenchmarkProgress(current, total, name) {
  const percent = Math.round((current / total) * 100);
  const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
  console.log(`Progress: [${bar}] ${percent}% - ${name}`);
}

export function formatErrorReport(errors) {
  if (errors.length === 0) return;

  console.log('\n=== ERRORS ENCOUNTERED ===');
  errors.forEach(error => {
    console.log(`❌ ${error.context}: ${error.message}`);
    if (error.suggestion) {
      console.log(`   💡 Suggestion: ${error.suggestion}`);
    }
  });
}
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
    // p90/p95/p99 are suppressed below n=30 because the values collapse onto
    // min/max in that regime. Print a one-line note instead so the absence
    // of the percentile line is intentional and visible.
    if (timing.p90 !== null && timing.p95 !== null && timing.p99 !== null) {
      console.log(`P90: ${timing.p90}ms | P95: ${timing.p95}ms | P99: ${timing.p99}ms`);
    } else {
      console.log(`P90/P95/P99: suppressed (n=${timing.count} < 30)`);
    }
    console.log(`Outliers: ${timing.outliers}/${timing.count}`);
  }

  if (optimization.available) {
    console.log('\nV8 Optimization Status:');
    const insights = getOptimizationInsights(result);
    insights.forEach(insight => console.log(`  ${insight}`));
  }

  const warnings = result.metadata?.warnings ?? [];
  if (warnings.length > 0) {
    console.log('\nWarnings:');
    warnings.forEach(w => console.log(`  ⚠ ${w}`));
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

function formatPerformanceComparison(results) {
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
      if (!comparison) continue;
      const { ratio, direction } = comparison.difference;
      const ratioText = ratio === null ? 'n/a' : `${ratio.toFixed(2)}×`;
      const relation = direction === 'same' ? 'matches' : `is ${ratioText} ${direction} than`;
      console.log(`  ${comparison.comparison.name} ${relation} ${comparison.baseline.name}`);
      console.log(`    ${comparison.summary}`);
    }
  }
}


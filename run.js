import { resolve } from 'node:path';
import { createProfiler } from './src/core/profiler.js';
import { formatConsoleReport } from './src/reporters/console.js';

console.log('=== V8 DEOPTIMIZATION PROFILER ===\n');

const benchmarks = [
  { name: 'hotLoop',       path: resolve('./example/hot.js'), exportName: 'hotLoop' },
  { name: 'optimizedLoop', path: resolve('./example/hot.js'), exportName: 'optimizedLoop' },
];

const config = {
  profiling: { warmupRuns: 10, testRuns: 1000, delayBetweenTests: 100 },
  v8:        { enableIntrinsics: true, forceOptimization: true, traceOptimization: true },
  output:    { format: 'console', verbose: false },
  analysis:  { outlierThreshold: 2, showInsights: true },
};

try {
  const profiler = await createProfiler(config);
  const results = await profiler.runBenchmarks(benchmarks);

  formatConsoleReport(results, {
    verbose: config.output.verbose,
    showInsights: config.analysis.showInsights,
  });
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

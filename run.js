import { createProfiler } from './src/core/profiler.js';
import { formatConsoleReport } from './src/reporters/console.js';
import { hotLoop, optimizedLoop } from './example/hot.js';

console.log('=== V8 DEOPTIMIZATION PROFILER ===\n');

const config = {
  profiling: {
    warmupRuns: 10,
    testRuns: 1000,
    delayBetweenTests: 100
  },
  v8: {
    enableIntrinsics: true,
    forceOptimization: true,
    monitorStderr: true
  },
  output: {
    format: 'console',
    verbose: false
  },
  analysis: {
    outlierThreshold: 2,
    showInsights: true
  }
};

const benchmarks = [
  { name: 'hotLoop', fn: hotLoop },
  { name: 'optimizedLoop', fn: optimizedLoop }
];

try {
  const profiler = await createProfiler(config);

  if (!profiler.v8Available) {
    console.log('V8 intrinsics not available. Run with: node --allow-natives-syntax run.js');
  }

  const results = await profiler.runBenchmarks(benchmarks);

  formatConsoleReport(results, {
    verbose: config.output.verbose,
    showInsights: config.analysis.showInsights
  });

  if (results.length >= 2) {
    const hotResult = results.find(r => r.name === 'hotLoop');
    const optResult = results.find(r => r.name === 'optimizedLoop');

    if (hotResult?.timing && optResult?.timing) {
      const ratio = optResult.timing.mean / hotResult.timing.mean;
      console.log('\n=== LEGACY PERFORMANCE ANALYSIS ===');
      console.log(`hotLoop (polymorphic): ${hotResult.timing.mean.toFixed(2)}ms`);
      console.log(`optimizedLoop (monomorphic): ${optResult.timing.mean.toFixed(2)}ms`);
      console.log(`Ratio: ${ratio.toFixed(2)}x (${ratio > 1 ? 'polymorphic is faster' : 'monomorphic is faster'})`);
    }
  }

} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

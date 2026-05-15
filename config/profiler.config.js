// Example JavaScript configuration file
export default {
  profiling: {
    warmupRuns: 15,
    testRuns: 500,
    delayBetweenTests: 100
  },

  output: {
    format: 'console',
    directory: './reports',
    filename: 'benchmark-{timestamp}',
    verbose: true
  },

  analysis: {
    outlierThreshold: 2.5,
    confidenceLevel: 0.95,
    showInsights: true
  },

  v8: {
    enableIntrinsics: true,
    forceOptimization: true,
    traceOptimization: true
  }
};
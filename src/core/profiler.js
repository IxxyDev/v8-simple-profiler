import {
  setupV8Monitoring,
  getOptimizationStatus,
  isV8IntrinsicsAvailable,
  prepareForOptimization,
  optimizeOnNextCall,
} from './v8-monitor.js';
import { calculateStats, detectOutliers, assessReliability } from './metrics.js';
import { delay, withTimeout } from '../utils/async.js';
import { DEFAULT_CONFIG } from '../utils/config.js';

export async function createProfiler(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  return {
    config,
    v8Available: config.v8.enableIntrinsics && isV8IntrinsicsAvailable(),
    measurements: new Map(),

    async runBenchmarks(benchmarks) {
      const results = [];

      if (config.v8.monitorStderr) {
        setupV8Monitoring();
      }

      for (const benchmark of benchmarks) {
        console.log(`\n=== Profiling ${benchmark.name} ===`);

        try {
          const result = await this.runSingleBenchmark(benchmark);
          results.push(result);

          if (config.profiling.delayBetweenTests > 0) {
            await delay(config.profiling.delayBetweenTests);
          }
        } catch (error) {
          console.error(`Error profiling ${benchmark.name}:`, error.message);
          results.push(createErrorResult(benchmark.name, error));
        }
      }

      return results;
    },

    async runSingleBenchmark(benchmark) {
      const { name, fn } = benchmark;

      const shouldForce = this.v8Available && config.v8.forceOptimization;

      // %PrepareFunctionForOptimization must be called before V8 collects
      // type feedback for the function — i.e. before warmup. On Node ≥ 16,
      // skipping this and calling %OptimizeFunctionOnNextCall fatally aborts
      // the process (uncatchable), which is why the old `eval`-by-name
      // implementation only "worked" because its ReferenceError prevented the
      // intrinsic from ever running.
      if (shouldForce) {
        prepareForOptimization(fn);
      }

      console.log(`Warming up ${name}...`);
      await this.warmupFunction(fn, config.profiling.warmupRuns);

      if (shouldForce) {
        optimizeOnNextCall(fn);
        // Trigger call to actually compile the optimized code.
        try {
          await fn();
        } catch (error) {
          console.warn(`Optimization trigger call failed for ${name}:`, error.message);
        }
      }

      console.log(`Measuring ${name}...`);
      const measurements = await this.measureFunction(fn, config.profiling.testRuns);

      const stats = calculateStats(measurements);
      const outliers = detectOutliers(measurements, config.analysis.outlierThreshold);
      const reliability = assessReliability(stats);

      const optimization = this.v8Available
        ? getOptimizationStatus(fn, name)
        : { available: false };

      return {
        name,
        timing: {
          ...stats,
          outliers: outliers.length,
          reliability
        },
        optimization,
        metadata: {
          warmupRuns: config.profiling.warmupRuns,
          testRuns: config.profiling.testRuns,
          timestamp: new Date().toISOString(),
          nodeVersion: process.version,
          v8Version: process.versions.v8
        }
      };
    },

    async warmupFunction(fn, runs = 10) {
      for (let i = 0; i < runs; i++) {
        try {
          await fn();
        } catch (error) {
          console.warn(`Warmup iteration ${i + 1} failed:`, error.message);
        }
      }
    },

    async measureFunction(fn, runs = 1000) {
      const measurements = [];

      for (let i = 0; i < runs; i++) {
        const start = performance.now();

        try {
          await fn();
          const end = performance.now();
          measurements.push(end - start);
        } catch (error) {
          console.warn(`Measurement ${i + 1} failed:`, error.message);
        }

        if (runs > 1000 && i % Math.floor(runs / 10) === 0) {
          console.log(`Progress: ${Math.round((i / runs) * 100)}%`);
        }
      }

      if (measurements.length === 0) {
        throw new Error('No successful measurements recorded');
      }

      return measurements;
    }
  };
}

function createErrorResult(name, error) {
  return {
    name,
    error: {
      message: error.message,
      type: error.constructor.name
    },
    timing: null,
    optimization: { available: false },
    metadata: {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      v8Version: process.versions.v8
    }
  };
}
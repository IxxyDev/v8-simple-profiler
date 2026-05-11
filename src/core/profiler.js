import { fork } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  parseTraceLine,
  optimizationInfo,
  deoptedFunctions,
  clearOptimizationData,
} from './v8-monitor.js';
import { calculateStats, detectOutliers, assessReliability } from './metrics.js';
import { delay } from '../utils/async.js';
import { DEFAULT_CONFIG } from '../utils/config.js';

const RUNNER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'runner',
  'child-runner.js'
);

const DEFAULT_EXPORT_SENTINEL = '__default__';

// `benchmark` shape produced by load-benchmarks:
//   { name: 'hotLoop', path: '/abs/path.js', exportName: 'hotLoop' }
// `exportName === '__default__'` resolves to the module's default export.
export async function createProfiler(options = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, options);

  return {
    config,
    // Kept for backward compatibility with the CLI's pre-flight log. Intrinsics
    // run in the child now, so the answer is always "yes" unless the user
    // disabled them via config.
    v8Available: !!config.v8.enableIntrinsics,

    async runBenchmarks(benchmarks) {
      const results = [];

      for (const benchmark of benchmarks) {
        console.log(`\n=== Profiling ${benchmark.name} ===`);
        try {
          const result = await runInChild(benchmark, config);
          results.push(result);
        } catch (error) {
          console.error(`Error profiling ${benchmark.name}:`, error.message);
          results.push(createErrorResult(benchmark.name, error));
        }

        if (config.profiling.delayBetweenTests > 0) {
          await delay(config.profiling.delayBetweenTests);
        }
      }

      return results;
    },
  };
}

async function runInChild(benchmark, config) {
  // Each benchmark gets fresh parser state so its counters aren't polluted by
  // events from a previous benchmark in the same parent run.
  clearOptimizationData();

  const execArgv = [];
  if (config.v8.enableIntrinsics) execArgv.push('--allow-natives-syntax');
  if (config.v8.monitorStderr) execArgv.push('--trace-opt', '--trace-deopt');

  const child = fork(
    RUNNER_PATH,
    [
      benchmark.path,
      benchmark.exportName,
      String(config.profiling.warmupRuns),
      String(config.profiling.testRuns),
    ],
    {
      execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );

  readline.createInterface({ input: child.stdout }).on('line', parseTraceLine);
  readline.createInterface({ input: child.stderr }).on('line', parseTraceLine);

  const ipcMessage = await new Promise((res, rej) => {
    let received = null;
    child.on('message', m => { received = m; });
    child.on('error', rej);
    child.on('exit', code => {
      if (received) res(received);
      else rej(new Error(`Benchmark child exited (${code}) without sending a result`));
    });
  });

  if (ipcMessage.type === 'error') {
    const err = new Error(ipcMessage.message);
    if (ipcMessage.stack) err.stack = ipcMessage.stack;
    throw err;
  }

  const { timings, failed = 0, optimizationStatus, nodeVersion, v8Version } = ipcMessage;

  const stats = calculateStats(timings);
  const outliers = detectOutliers(timings, config.analysis.outlierThreshold);
  const reliability = assessReliability(stats);

  // Merge intrinsic status (point-in-time, from child) with trace counters
  // (cumulative, parsed from stdout in this process).
  const traceInfo = optimizationInfo.get(benchmark.exportName);
  const optimization = {
    ...optimizationStatus,
    attempts: traceInfo?.attempts ?? 0,
    reasons: traceInfo?.reasons ?? [],
    tiers: traceInfo?.tiers ?? [],
    deoptimized:
      (optimizationStatus && optimizationStatus.deoptimized) ||
      deoptedFunctions.has(benchmark.exportName),
    deoptReasons: traceInfo?.deoptReasons ?? [],
  };

  return {
    name: benchmark.name,
    timing: { ...stats, outliers: outliers.length, reliability },
    optimization,
    metadata: {
      warmupRuns: config.profiling.warmupRuns,
      testRuns: config.profiling.testRuns,
      failedMeasurements: failed,
      timestamp: new Date().toISOString(),
      nodeVersion,
      v8Version,
    },
  };
}

function mergeConfig(defaults, override) {
  const out = JSON.parse(JSON.stringify(defaults));
  for (const key of Object.keys(override)) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])) {
      out[key] = { ...out[key], ...override[key] };
    } else {
      out[key] = override[key];
    }
  }
  return out;
}

function createErrorResult(name, error) {
  return {
    name,
    error: {
      message: error.message,
      type: error.constructor.name,
    },
    timing: null,
    optimization: { available: false },
    metadata: {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      v8Version: process.versions.v8,
    },
  };
}

export { DEFAULT_EXPORT_SENTINEL };

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
import { DEFAULT_CONFIG, mergeConfig } from '../utils/config.js';

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
  if (config.v8.traceOptimization) execArgv.push('--trace-opt', '--trace-deopt');

  const child = fork(
    RUNNER_PATH,
    [
      benchmark.path,
      benchmark.exportName,
      String(config.profiling.warmupRuns),
      String(config.profiling.testRuns),
      String(config.v8.forceOptimization),
    ],
    {
      execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );

  const handleLine = line => {
    if (isV8TraceLine(line)) parseTraceLine(line);
  };
  readline.createInterface({ input: child.stdout }).on('line', handleLine);
  readline.createInterface({ input: child.stderr }).on('line', handleLine);

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

  const {
    timings,
    failed = 0,
    optimizationStatus,
    resolvedName,
    forced,
    nodeVersion,
    v8Version,
    executionMode,
    batchSize,
    mode,
    sinkChecksum,
  } = ipcMessage;

  const stats = calculateStats(timings);
  const outliers = detectOutliers(timings, config.analysis.outlierThreshold);
  const reliability = assessReliability(stats);

  // V8 keys trace records by the function's real .name. For default exports
  // benchmark.exportName is the sentinel '__default__' which never appears in
  // the trace stream — we'd otherwise report attempts:0 for any default export.
  // Anonymous functions (fn.name === '') still can't be attributed; surface
  // that explicitly so consumers can distinguish "didn't optimize" from
  // "can't tell".
  const lookupName = resolvedName || benchmark.exportName;
  const traceInfo = optimizationInfo.get(lookupName);
  const traceAttribution = resolvedName === '' ? 'anonymous-skipped' : 'by-name';
  const optimization = {
    ...optimizationStatus,
    attempts: traceInfo?.attempts ?? 0,
    reasons: traceInfo?.reasons ?? [],
    tiers: traceInfo?.tiers ?? [],
    deoptimized:
      (optimizationStatus && optimizationStatus.deoptimized) ||
      deoptedFunctions.has(lookupName),
    deoptReasons: traceInfo?.deoptReasons ?? [],
    traceAttribution,
    forced: forced ?? config.v8.forceOptimization,
  };

  return {
    name: benchmark.name,
    timing: { ...stats, outliers: outliers.length, reliability, measurements: timings },
    optimization,
    metadata: {
      warmupRuns: config.profiling.warmupRuns,
      testRuns: config.profiling.testRuns,
      failedMeasurements: failed,
      timestamp: new Date().toISOString(),
      nodeVersion,
      v8Version,
      executionMode,
      batchSize,
      mode,
      sinkChecksum,
    },
  };
}

// V8 --trace-opt / --trace-deopt records always open with one of these
// prefixes. Filtering at the readline boundary stops user console.log output
// (which shares stdout/stderr with V8's trace stream) from being misread as
// optimization events when it happens to contain `<JSFunction …>`.
function isV8TraceLine(line) {
  return (
    line.startsWith('[marking ') ||
    line.startsWith('[manually marking ') ||
    line.startsWith('[bailout ')
  );
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

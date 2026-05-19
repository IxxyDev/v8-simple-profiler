import { fork } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createTraceParser } from './v8-monitor.js';
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
      const forwardResults = await runSequence(benchmarks, config);

      if (!config.profiling.runOrderCheck || benchmarks.length < 2) {
        return forwardResults;
      }

      // Order-check pass: rerun the benchmarks in reverse and compare the
      // ranking. If the top-1 differs between orders the ranking is order-
      // dependent, which usually means measurement noise dominates the
      // separation between benchmarks (CPU caches, thermal state, or shared
      // V8 inline-cache feedback across runs).
      console.log('\n=== Run-order check: rerunning in reverse ===');
      const reverseResults = await runSequence([...benchmarks].reverse(), config);

      const forwardRanking = rankByMean(forwardResults);
      const reverseRanking = rankByMean(reverseResults);
      const top1Flipped =
        forwardRanking.length > 0 &&
        reverseRanking.length > 0 &&
        forwardRanking[0] !== reverseRanking[0];

      if (top1Flipped) {
        console.warn(
          `[profiler] run-order check: ranking top-1 flipped between forward (${forwardRanking[0]}) and reverse (${reverseRanking[0]}); results are order-dependent`
        );
        for (const r of forwardResults) {
          if (r.metadata) r.metadata.orderDependent = true;
        }
      }

      return forwardResults;
    },
  };
}

async function runSequence(benchmarks, config) {
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
}

function rankByMean(results) {
  return [...results]
    .filter(r => r.timing && typeof r.timing.mean === 'number')
    .sort((a, b) => a.timing.mean - b.timing.mean)
    .map(r => r.name);
}

// Known-good V8 --trace-opt line used to verify the parser regex still matches
// the running Node's trace format. If V8 reshuffles the format (as it has
// across Node 18/20/Maglev), the parser silently records zero events forever;
// surfacing a 'unknown_format' verdict in metadata lets consumers spot that
// regression instead of trusting empty optimization counters.
const TRACE_PROBE_LINE =
  '[marking 0x22bac9112da1 <JSFunction __traceProbe__ (sfi = 0x157c3d9067b1)> for optimization to MAGLEV, ConcurrencyMode::kConcurrent, reason: hot and stable]';
const TRACE_PROBE_NAME = '__traceProbe__';

function probeTraceParser(parser) {
  parser.parseTraceLine(TRACE_PROBE_LINE);
  return parser.optimizationInfo.has(TRACE_PROBE_NAME) ? 'ok' : 'unknown_format';
}

async function runInChild(benchmark, config) {
  // Each benchmark gets a fresh parser instance so its counters cannot be
  // polluted by events from a previous benchmark in the same parent run. The
  // probe runs against a throwaway parser so its synthetic entry never leaks
  // into the benchmark's real counters.
  const probeParser = createTraceParser();
  const traceParserHealth = probeTraceParser(probeParser);
  const parser = createTraceParser();

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
    if (isV8TraceLine(line)) parser.parseTraceLine(line);
  };
  const stdoutRl = readline.createInterface({ input: child.stdout });
  const stderrRl = readline.createInterface({ input: child.stderr });
  stdoutRl.on('line', handleLine);
  stderrRl.on('line', handleLine);

  // The child sends its IPC result and then calls setImmediate(process.exit).
  // V8 --trace-opt lines written between `send` and `exit` are still in the
  // parent's libuv stdout buffer when the child's 'exit' event fires, so
  // resolving on 'exit' alone drops trailing tier-up records — exactly the
  // events that come from the optimizer settling at the end of the run.
  //
  // Wait until BOTH conditions are met: the IPC message has arrived AND both
  // readline streams have emitted 'close' (which fires only after stdout/
  // stderr are fully drained). The hard timeout guards against a stalled
  // stream so a misbehaving child cannot hang the parent indefinitely.
  const STREAM_DRAIN_TIMEOUT_MS = 5000;
  let streamDrainTimedOut = false;
  const ipcMessage = await new Promise((res, rej) => {
    let received = null;
    let stdoutClosed = false;
    let stderrClosed = false;
    let settled = false;
    let timeoutHandle = null;

    const tryResolve = () => {
      if (settled) return;
      if (received && stdoutClosed && stderrClosed) {
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        res(received);
      }
    };

    const fail = err => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      rej(err);
    };

    child.on('message', m => { received = m; tryResolve(); });
    child.on('error', fail);
    stdoutRl.on('close', () => { stdoutClosed = true; tryResolve(); });
    stderrRl.on('close', () => { stderrClosed = true; tryResolve(); });
    child.on('exit', code => {
      if (!received) {
        fail(new Error(`Benchmark child exited (${code}) without sending a result`));
      }
    });

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      streamDrainTimedOut = true;
      console.warn(
        `[profiler] timed out waiting ${STREAM_DRAIN_TIMEOUT_MS}ms for child stream drain; resolving with current state`
      );
      if (received) {
        settled = true;
        res(received);
      } else {
        fail(new Error('Benchmark child stream drain timed out without a result'));
      }
    }, STREAM_DRAIN_TIMEOUT_MS);
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
  const traceInfo = parser.optimizationInfo.get(lookupName);
  const traceAttribution = resolvedName === '' ? 'anonymous-skipped' : 'by-name';
  const optimization = {
    ...optimizationStatus,
    attempts: traceInfo?.attempts ?? 0,
    reasons: traceInfo?.reasons ?? [],
    tiers: traceInfo?.tiers ?? [],
    deoptimized:
      (optimizationStatus && optimizationStatus.deoptimized) ||
      parser.deoptedFunctions.has(lookupName),
    deoptReasons: traceInfo?.deoptReasons ?? [],
    traceAttribution,
    forced: forced ?? config.v8.forceOptimization,
  };

  const warnings = [];
  if (!config.v8.enableIntrinsics) {
    warnings.push('V8 intrinsics disabled — optimization status and trace counters are unavailable');
  } else if (config.v8.forceOptimization === false) {
    warnings.push('forceOptimization disabled — function may run interpreted; absolute timings will not reflect optimized code');
  }
  if (traceParserHealth === 'unknown_format') {
    warnings.push('V8 --trace-opt format probe failed — optimization attempts/reasons may be empty even when V8 optimized the function');
  }
  if (streamDrainTimedOut) {
    warnings.push('Child stdout/stderr did not drain within timeout — trailing optimization events may be missing');
  }

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
      traceParserHealth,
      streamDrainTimedOut,
      warnings,
    },
  };
}

// V8 --trace-opt / --trace-deopt records always open with one of these
// prefixes. Filtering at the readline boundary stops user console.log output
// Exported for testing — production consumers use it via runInChild.
// (which shares stdout/stderr with V8's trace stream) from being misread as
// optimization events when it happens to contain `<JSFunction …>`.
export function isV8TraceLine(line) {
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

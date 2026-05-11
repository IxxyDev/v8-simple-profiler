// Isolated benchmark runner. Forked from profiler.js so each benchmark gets a
// fresh V8 isolate — that keeps measurement noise out of the parent (parser,
// statistics, reporters, stdout patches) and prevents type-feedback from one
// benchmark from polluting the next.
//
// Communication:
//   stdin/stdout : parent owns stdout — we never write to it ourselves so the
//                  V8 --trace-opt / --trace-deopt records stay clean for the
//                  parent's line parser.
//   stderr       : free for diagnostics from this runner.
//   IPC channel  : structured frames `{ type, … }`. The parent waits for a
//                  single `result` or `error` frame, then drains and exits.
//
// argv (positional, set by parent):
//   [3] benchmarkPath  absolute path to the benchmark module
//   [4] exportName     named export to run, or "__default__"
//   [5] warmupRuns
//   [6] testRuns
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  isV8IntrinsicsAvailable,
  prepareForOptimization,
  optimizeOnNextCall,
  getOptimizationStatus,
} from '../core/v8-monitor.js';

const DEFAULT_EXPORT_SENTINEL = '__default__';

function send(msg) {
  if (typeof process.send === 'function') process.send(msg);
}

async function main() {
  const [, , benchmarkPath, exportName, warmupRunsStr, testRunsStr] = process.argv;
  if (!benchmarkPath || !exportName) {
    send({ type: 'error', message: 'child-runner: missing required argv (path, exportName)' });
    process.exit(2);
  }

  const warmupRuns = Number(warmupRunsStr);
  const testRuns = Number(testRunsStr);
  if (!Number.isFinite(warmupRuns) || !Number.isFinite(testRuns) || warmupRuns < 0 || testRuns < 1) {
    send({ type: 'error', message: `child-runner: invalid warmup/test counts (${warmupRunsStr}, ${testRunsStr})` });
    process.exit(2);
  }

  let mod;
  try {
    mod = await import(pathToFileURL(benchmarkPath).href);
  } catch (err) {
    send({ type: 'error', message: `Failed to import benchmark: ${err.message}`, stack: err.stack });
    process.exit(1);
  }

  const fn = exportName === DEFAULT_EXPORT_SENTINEL ? mod.default : mod[exportName];
  if (typeof fn !== 'function') {
    send({ type: 'error', message: `Export "${exportName}" is not a function in ${benchmarkPath}` });
    process.exit(1);
  }

  const intrinsicsAvailable = isV8IntrinsicsAvailable();

  // Order matters: prepare must precede any call to fn that the optimizer can
  // observe, or V8 may reject the later %OptimizeFunctionOnNextCall.
  if (intrinsicsAvailable) prepareForOptimization(fn);

  try {
    for (let i = 0; i < warmupRuns; i++) await fn();
  } catch (err) {
    send({ type: 'error', message: `Warmup failed: ${err.message}`, stack: err.stack });
    process.exit(1);
  }

  if (intrinsicsAvailable) {
    optimizeOnNextCall(fn);
    try {
      // Trigger compilation while the optimizer still has fresh feedback.
      await fn();
    } catch (err) {
      send({ type: 'error', message: `Optimization trigger failed: ${err.message}` });
      process.exit(1);
    }
  }

  // Pre-allocate to avoid array growth allocations inside the hot loop.
  const timings = new Array(testRuns);
  let failed = 0;
  for (let i = 0; i < testRuns; i++) {
    const start = performance.now();
    try {
      await fn();
      timings[i] = performance.now() - start;
    } catch {
      timings[i] = Number.NaN;
      failed++;
    }
  }

  const validTimings = failed === 0 ? timings : timings.filter(t => Number.isFinite(t));
  if (validTimings.length === 0) {
    send({ type: 'error', message: 'No successful measurements recorded' });
    process.exit(1);
  }

  const optimizationStatus = intrinsicsAvailable
    ? getOptimizationStatus(fn, exportName)
    : { available: false };

  send({
    type: 'result',
    timings: validTimings,
    failed,
    optimizationStatus,
    nodeVersion: process.version,
    v8Version: process.versions.v8,
  });

  // Give Node a tick to flush the IPC message before exiting.
  setImmediate(() => process.exit(0));
}

main().catch(err => {
  send({ type: 'error', message: err.message, stack: err.stack });
  process.exit(1);
});

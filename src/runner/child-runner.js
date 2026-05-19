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
//   [3] benchmarkPath     absolute path to the benchmark module
//   [4] exportName        named export to run, or "__default__"
//   [5] warmupRuns
//   [6] testRuns
//   [7] forceOptimization "true" | "false" — when "false", skip the manual
//                         %PrepareFunctionForOptimization / %OptimizeOnNextCall
//                         handshake so the CLI's --no-optimization flag has an
//                         observable effect.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  isV8IntrinsicsAvailable,
  prepareForOptimization,
  optimizeOnNextCall,
  getOptimizationStatus,
} from '../core/v8-monitor.js';

const DEFAULT_EXPORT_SENTINEL = '__default__';

// Calibration target: pick the smallest batch whose total time crosses this
// threshold so per-call timings stay above the `performance.now()` resolution
// floor (~1µs on most platforms).
const TARGET_BATCH_MS = 1;
const MAX_BATCH = 1 << 20;

// Anti-DCE sink. V8 can constant-fold or eliminate calls whose return value is
// never observed; XOR-ing into a module-level int that we send back over IPC
// forces every iteration's result to escape.
let __sink = 0;

function consume(v) {
  switch (typeof v) {
    case 'number': return (v | 0) ^ 0x9e3779b1;
    case 'string': return (v.length | 0) ^ 0x85ebca6b;
    case 'boolean': return v ? 0x27d4eb2f : 0xc2b2ae35;
    case 'object': return v === null ? 0x165667b1 : 0xd3a2646c;
    case 'undefined': return 0x52dce729;
    default: return 0x38ebc6af;
  }
}

function send(msg) {
  if (typeof process.send === 'function') process.send(msg);
}

async function main() {
  const [, , benchmarkPath, exportName, warmupRunsStr, testRunsStr, forceOptStr] = process.argv;
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

  const forceOptimization = forceOptStr === 'true';

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

  const isAsync = fn.constructor && fn.constructor.name === 'AsyncFunction';
  const executionMode = isAsync ? 'async' : 'sync';

  const intrinsicsAvailable = isV8IntrinsicsAvailable();
  const willForceOptimize = intrinsicsAvailable && forceOptimization;

  // Order matters: prepare must precede any call to fn that the optimizer can
  // observe, or V8 may reject the later %OptimizeFunctionOnNextCall.
  if (willForceOptimize) prepareForOptimization(fn);

  try {
    if (isAsync) {
      for (let i = 0; i < warmupRuns; i++) __sink ^= consume(await fn());
    } else {
      for (let i = 0; i < warmupRuns; i++) __sink ^= consume(fn());
    }
  } catch (err) {
    send({ type: 'error', message: `Warmup failed: ${err.message}`, stack: err.stack });
    process.exit(1);
  }

  if (willForceOptimize) {
    optimizeOnNextCall(fn);
    try {
      // Trigger compilation while the optimizer still has fresh feedback.
      if (isAsync) __sink ^= consume(await fn());
      else __sink ^= consume(fn());
    } catch (err) {
      send({ type: 'error', message: `Optimization trigger failed: ${err.message}` });
      process.exit(1);
    }
  }

  let batchSize = 1;
  try {
    while (batchSize < MAX_BATCH) {
      const t0 = performance.now();
      if (isAsync) {
        for (let i = 0; i < batchSize; i++) __sink ^= consume(await fn());
      } else {
        for (let i = 0; i < batchSize; i++) __sink ^= consume(fn());
      }
      const elapsed = performance.now() - t0;
      if (elapsed >= TARGET_BATCH_MS) break;
      batchSize <<= 1;
    }
  } catch (err) {
    send({ type: 'error', message: `Calibration failed: ${err.message}`, stack: err.stack });
    process.exit(1);
  }

  const timings = new Array(testRuns);
  let failed = 0;
  if (isAsync) {
    for (let i = 0; i < testRuns; i++) {
      const start = performance.now();
      try {
        for (let j = 0; j < batchSize; j++) __sink ^= consume(await fn());
        timings[i] = (performance.now() - start) / batchSize;
      } catch {
        timings[i] = Number.NaN;
        failed++;
      }
    }
  } else {
    for (let i = 0; i < testRuns; i++) {
      const start = performance.now();
      try {
        for (let j = 0; j < batchSize; j++) __sink ^= consume(fn());
        timings[i] = (performance.now() - start) / batchSize;
      } catch {
        timings[i] = Number.NaN;
        failed++;
      }
    }
  }

  const validTimings = failed === 0 ? timings : timings.filter(t => Number.isFinite(t));
  if (validTimings.length === 0) {
    send({ type: 'error', message: 'No successful measurements recorded' });
    process.exit(1);
  }

  const optimizationStatus = intrinsicsAvailable
    ? getOptimizationStatus(fn)
    : { available: false };

  send({
    type: 'result',
    timings: validTimings,
    failed,
    optimizationStatus,
    // V8's --trace-opt records key the function by its real .name; for default
    // exports the parent can't derive this from exportName ('__default__').
    resolvedName: typeof fn.name === 'string' ? fn.name : '',
    forced: forceOptimization,
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    executionMode,
    batchSize,
    mode: batchSize === 1 ? 'per-call' : 'per-batch',
    sinkChecksum: __sink,
  });

  // Give Node a tick to flush the IPC message before exiting.
  setImmediate(() => process.exit(0));
}

main().catch(err => {
  send({ type: 'error', message: err.message, stack: err.stack });
  process.exit(1);
});

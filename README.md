# v8-simple-profiler

[![CI](https://github.com/IxxyDev/v8-simple-profiler/actions/workflows/ci.yml/badge.svg)](https://github.com/IxxyDev/v8-simple-profiler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A516-43853d)

A small Node.js profiler that demonstrates and measures V8's optimization behavior — specifically the cost of polymorphic vs monomorphic code paths.

It runs two functions back-to-back, captures execution time across many runs, applies basic statistics (median, percentiles, std dev, outlier handling), and reports how V8's optimizer treated each function.

## Why this exists

I work on performance-critical frontend code (Canvas-heavy editors, real-time dashboards) and run into V8 deoptimization patterns regularly. Most explanations of monomorphic/polymorphic ICs are either too academic or hand-wavy. I wanted a small, runnable demo that:

- Shows the effect on real timing, not just on theory
- Uses honest measurement (warm-up, percentiles, outlier detection — not just `console.time` averages)
- Surfaces V8's actual optimization decisions via intrinsics (`%GetOptimizationStatus` and friends)

It's also a sanity-check tool: drop in a function, see whether V8 keeps it optimized or bails out.

## What it measures

Two functions are profiled sequentially, with a configurable delay between them so V8 state from one function doesn't bleed into the next.

The headline example, `example/polymorphism-only.js`, isolates inline-cache cost:

- **`monomorphicCall`** — reads `.x` from a pre-allocated 4-element array whose objects share one hidden class. V8's IC at the access site stays monomorphic.
- **`polymorphicCall`** — reads `.x` from a pre-allocated 4-element array whose objects have 4 distinct hidden classes. Same accessor, same iteration count, same allocation footprint; only the IC degrades to a 4-way polymorphic lookup.

A second, larger example (`example/hot.js`) is included as a "mixed workload" demo. It pairs `hotLoop` (polymorphic, allocating four different value types into an array) against `optimizedLoop` (monomorphic numbers). Its ratio reflects _both_ IC degradation _and_ allocation/GC pressure, so it tends to look more dramatic than a pure IC effect — handy for showing the combined cost, but not a clean comparison.

The profiler reports:

- Mean / median / min / max / std dev / p95 / p99 execution times
- Reliability classification (low / medium / high) based on relative standard error of the mean
- V8 optimization status per function (when intrinsics are enabled)
- Performance comparison with statistical significance (Welch-style t-statistic)

## Quick start

```bash
npm install
npm start                                          # runs the default (example/hot.js)
node src/cli/index.js -b example/polymorphism-only.js   # headline mono-vs-poly demo
npm test                                           # run unit tests
```

Each benchmark is executed in a forked child process. The parent forwards
the V8 flags it needs (`--allow-natives-syntax`, `--trace-opt`,
`--trace-deopt`) to the child via `execArgv`, so you do not have to pass
them yourself. The child's V8 trace is piped back to the parent through
`stdout` and parsed line-by-line — that's how the per-function
optimization attempts and deopt reasons end up in the final report.

To opt out, set `v8.enableIntrinsics: false` (skips
`--allow-natives-syntax`) or `v8.traceOptimization: false` (skips the
trace flags) in your config.

## CLI

The package exposes a `v8-profiler` binary (declared in `package.json#bin`). Invoke it directly:

```bash
node src/cli/index.js --runs 5000 --format all --verbose

# Or, after `npm link`:
v8-profiler --config ./profiler.config.js --format json
```

Or via npm script aliases:

```bash
npm run cli              # default run
npm run cli:help         # full flag list
npm run benchmark        # uses config/profiler.config.js
npm run benchmark:json   # writes JSON to ./reports/
npm run benchmark:csv    # writes CSV to ./reports/
```

Available flags:

| Flag                  | Description                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `-c, --config <path>` | Path to config file (`.json`, `.js`, `.mjs`)                                                               |
| `-f, --format <type>` | `console` (default), `json`, `csv`, or `all`                                                               |
| `-o, --output <dir>`  | Output directory for file reports (default `./reports`)                                                    |
| `-w, --warmup <runs>` | Warm-up iterations                                                                                         |
| `-r, --runs <count>`  | Measurement iterations                                                                                     |
| `-d, --delay <ms>`    | Delay between functions                                                                                    |
| `-v, --verbose`       | Include percentiles, outliers, stack traces on errors                                                      |
| `--no-v8`             | Disable V8 intrinsics                                                                                      |
| `--no-optimization`   | Skip `%OptimizeFunctionOnNextCall`                                                                         |
| `--threshold <n>`     | Outlier detection threshold (z-score, default `2`)                                                         |
| `--filename <tpl>`    | Filename template, supports `{timestamp}`                                                                  |
| `--run-order-check`   | Rerun in reverse and flag the result set as order-dependent if the ranking flips (doubles wall-clock time) |

> V8 intrinsics (`%GetOptimizationStatus`, `%OptimizeFunctionOnNextCall`) require Node to be started with `--allow-natives-syntax`. Without it the timing pipeline still works — you just lose the per-function optimization status block.

### Configuration file

The CLI auto-discovers `profiler.config.{js,mjs,json}` at the project root or under `./config/`. Example:

```js
// config/profiler.config.js
export default {
  profiling: {
    warmupRuns: 15,
    testRuns: 500,
    delayBetweenTests: 100,
  },
  output: {
    format: 'console', // or 'json', 'csv', 'all'
    directory: './reports',
    verbose: true,
  },
  analysis: {
    outlierThreshold: 2.5,
    showInsights: true,
  },
  v8: {
    enableIntrinsics: true,
    forceOptimization: true,
  },
};
```

Precedence: CLI flags > config file > built-in defaults.

## Project layout

```
src/
├── core/
│   ├── profiler.js      # Profiling orchestration
│   ├── metrics.js       # Statistical analysis
│   └── v8-monitor.js    # V8 intrinsics monitoring
├── reporters/
│   ├── console.js       # Formatted console output
│   ├── json.js          # JSON export
│   └── csv.js           # CSV export
├── utils/
│   ├── config.js        # Configuration management
│   └── async.js         # Async helpers
└── cli/
    └── index.js         # CLI entry point
```

## Sample output

Running the headline polymorphism-only example:

```
=== PROFILING RESULTS ===

--- monomorphicCall ---
Mean: 0.42ms   Median: 0.40ms
Reliability: high

--- polymorphicCall ---
Mean: 0.58ms   Median: 0.56ms
Reliability: high

=== PERFORMANCE COMPARISON ===
polymorphicCall is 1.40× slower than monomorphicCall
  moderately slower (40.2% difference, 99% confidence)
```

Exact numbers will vary by hardware and V8 version, but on modern V8 the ratio typically lands in the 1.2–1.6× range — that is the pure IC cost, with allocation and GC held constant.

The `example/hot.js` mixed workload reports a larger gap (often 2–3×) because it folds allocation pressure into the same measurement.

## Async benchmarks

Functions declared with `async`/that return a `Promise` are detected and awaited
in the timing loop. Be aware that each iteration then includes one
microtask/event-loop tick, so absolute numbers from async benchmarks are not
directly comparable to sync ones — interpret the ratio between async
benchmarks, not the raw means.

## Requirements

- Node.js ≥ 16
- macOS, Linux, or Windows

## License

MIT — see [LICENSE](LICENSE).

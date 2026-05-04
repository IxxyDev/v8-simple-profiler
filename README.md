# v8-simple-profiler

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
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

Two functions are profiled sequentially, with a configurable delay between them so V8 state from one function doesn't bleed into the next:

- **`hotLoop`** — polymorphic: same operations applied to four different types in deterministic blocks. V8 *can* still partially optimize each block, but the function ends up with polymorphic inline caches, generic code paths, and (depending on type feedback) deopt events.
- **`optimizedLoop`** — monomorphic: same shape of work, but only on numbers.

The profiler reports:

- Mean / median / min / max / std dev / p95 / p99 execution times
- Reliability classification (low / medium / high) based on relative standard error of the mean
- V8 optimization status per function (when intrinsics are enabled)
- Performance comparison with statistical significance (Welch-style t-statistic)

## Quick start

```bash
npm install
npm start          # basic run
npm test           # run unit tests
```

For deeper V8 inspection (the scripts below already pass the right Node flags):

```bash
npm run analyze        # V8 intrinsics enabled (--allow-natives-syntax)
npm run profile        # --trace-opt --trace-deopt
npm run profile-deep   # all of the above + verbose deopt info
```

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

| Flag | Description |
| --- | --- |
| `-c, --config <path>` | Path to config file (`.json`, `.js`, `.mjs`) |
| `-f, --format <type>` | `console` (default), `json`, `csv`, or `all` |
| `-o, --output <dir>` | Output directory for file reports (default `./reports`) |
| `-w, --warmup <runs>` | Warm-up iterations |
| `-r, --runs <count>` | Measurement iterations |
| `-d, --delay <ms>` | Delay between functions |
| `-v, --verbose` | Include percentiles, outliers, stack traces on errors |
| `--no-v8` | Disable V8 intrinsics |
| `--no-optimization` | Skip `%OptimizeFunctionOnNextCall` |
| `--threshold <n>` | Outlier detection threshold (z-score, default `2`) |
| `--filename <tpl>` | Filename template, supports `{timestamp}` |

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

```
=== PROFILING RESULTS ===

--- hotLoop ---
Mean: 1.18ms   Median: 0.91ms
Min: 0.78ms    Max: 5.49ms
Std Dev: 0.73ms
Reliability: medium

--- optimizedLoop ---
Mean: 0.43ms   Median: 0.34ms
Min: 0.27ms    Max: 1.25ms
Std Dev: 0.25ms
Reliability: medium

=== COMPARISON ===
optimizedLoop is 2.73× faster than hotLoop
  (172.9% difference, 99% confidence)
```

## Requirements

- Node.js ≥ 16
- macOS, Linux, or Windows

## License

ISC

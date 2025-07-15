# V8 Deoptimization Profiler

A lightweight Node.js profiler that analyzes V8 JavaScript engine optimization behavior. It demonstrates the performance difference between monomorphic (single type) and polymorphic (multiple types) code, helping developers understand V8's optimization strategies.

## What It Does

The profiler compares two functions:
- **hotLoop**: Polymorphic function that uses 4 different data types in deterministic blocks
- **optimizedLoop**: Monomorphic function that uses only numbers

It measures execution time, analyzes V8 optimization status, and provides insights into why certain code patterns perform better.

## Prerequisites

- **Node.js**: v16.0.0 or higher
- **Operating System**: macOS, Linux, or Windows

## How to Run

**Basic Profiling** (no special flags needed):
```bash
npm run start
```

**Full Analysis** (with V8 optimization status):
```bash
npm run analyze
```

**Debug Mode** (with V8 trace output):
```bash
npm run profile
```

**Verbose Debug** (detailed deoptimization info):
```bash
npm run profile-deep
```

### Understanding the Output

The profiler will show:
- Performance comparison between polymorphic and monomorphic code
- V8 optimization flags (with `analyze` mode)
- Detailed execution table with deoptimization markers

## Available Scripts

- `start` - Basic performance analysis without V8 intrinsics
- `analyze` - Full analysis with optimization status (requires `--allow-natives-syntax`)
- `profile` - Detailed V8 trace output for debugging
- `profile-deep` - Verbose V8 trace with deoptimization details
- `profile-prof` - Generate V8 profiler output

## Example Output

```
=== PERFORMANCE ANALYSIS ===
hotLoop (polymorphic): 1180.08ms
optimizedLoop (monomorphic): 360.43ms
Ratio: 0.31x (monomorphic is faster)

=== V8 OPTIMIZATION STATUS ===
hotLoop status: 81
  Flags: optimized, optimized_osr, is_function

optimizedLoop status: 81
  Flags: optimized, optimized_osr, is_function

=== KEY INSIGHTS ===
✓ hotLoop: Optimized
✓ optimizedLoop: Optimized
→ OSR (On-Stack Replacement) detected
```

## Key Insights

- **Monomorphic code** (single type) is typically 3x faster than polymorphic code
- **OSR (On-Stack Replacement)** is commonly used for long-running loops
- **Deterministic type blocks** perform better than random type switching
- V8's adaptive optimization can sometimes make "deoptimized" code perform well
- **Status 81** typically means: optimized + OSR + is_function
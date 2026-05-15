export const optimizationInfo = new Map();
export const deoptedFunctions = new Set();

// V8 emits two flavours of optimization markers:
//   [marking 0x… <JSFunction foo (sfi = …)> for optimization to MAGLEV, …, reason: hot and stable]
//   [manually marking 0x… <JSFunction foo (sfi = …)> for optimization to TURBOFAN_JS, ConcurrencyMode::kSynchronous]
// The "manually" variant has no `reason:` field. We capture the tail between
// the tier and the closing `]` and extract `reason:` in a second step.
//
// Anonymous functions appear as `<JSFunction (sfi = …)>` (no name) and are
// intentionally skipped — there is no identifier to attribute counters to.
const OPT_PATTERN = /\[(?:manually\s+)?marking\s+0x[0-9a-f]+\s+<JSFunction\s+([^\s<>(]+)\s+\([^)]*\)>\s+for optimization to\s+([A-Z_]+)([^\]]*)\]/g;
const DEOPT_PATTERN = /\[bailout\s+\(kind:\s*([^,]+),\s*reason:\s*([^)]+)\):[^<]*<JSFunction\s+([^\s<>(]+)\s+\([^)]*\)>/g;
const REASON_TAIL = /reason:\s*(.+?)\s*$/;

// V8 intrinsics must be invoked from a scope that can see the function
// argument. The previous implementation interpolated the benchmark name into
// an eval() string, which fails because the named identifier doesn't exist in
// this module's scope — the error was silently swallowed and intrinsics never
// actually ran. Building helpers via `new Function('fn', ...)` makes the
// function argument the resolved identifier inside the intrinsic call.
//
// On modern V8 (Node ≥ 16), %OptimizeFunctionOnNextCall must be preceded by
// %PrepareFunctionForOptimization or V8 aborts the process (fatal, not a
// catchable exception). The lifecycle is:
//   prepareForOptimization(fn) → warmup calls → optimizeOnNextCall(fn) →
//   trigger call → getOptimizationStatus(fn)
function makeIntrinsic(body) {
  try {
    return new Function('fn', body);
  } catch {
    return null;
  }
}

const intrinsicPrepare = makeIntrinsic('%PrepareFunctionForOptimization(fn)');
const intrinsicOptimize = makeIntrinsic('return %OptimizeFunctionOnNextCall(fn)');
const intrinsicStatus = makeIntrinsic('return %GetOptimizationStatus(fn)');

let intrinsicsAvailableCache = null;

export function parseTraceLine(line) {
  if (line.indexOf('<JSFunction') === -1) return;

  for (const match of line.matchAll(OPT_PATTERN)) {
    const [, funcName, tier, tail] = match;
    const reasonMatch = tail.match(REASON_TAIL);
    const reason = reasonMatch ? reasonMatch[1] : 'manual';
    const info = optimizationInfo.get(funcName) ?? { attempts: 0, reasons: [], tiers: [] };
    info.attempts++;
    info.reasons.push(reason);
    info.tiers.push(tier);
    optimizationInfo.set(funcName, info);
  }

  for (const match of line.matchAll(DEOPT_PATTERN)) {
    const [, , reason, funcName] = match;
    deoptedFunctions.add(funcName);
    const info = optimizationInfo.get(funcName) ?? { attempts: 0, reasons: [], tiers: [] };
    info.deoptReasons = info.deoptReasons ?? [];
    info.deoptReasons.push(reason.trim());
    optimizationInfo.set(funcName, info);
  }
}

// Exposed only for tests: feed a chunk through the parser. Splits on `\n` and
// dispatches each line to parseTraceLine directly. Not part of the public API.
export function ingestTraceChunkForTesting(chunk) {
  const text = typeof chunk === 'string' ? chunk : chunk?.toString?.('utf8');
  if (!text) return;
  for (const line of text.split('\n')) {
    if (line) parseTraceLine(line);
  }
}

export function getOptimizationStatus(fn, name) {
  if (!isV8IntrinsicsAvailable() || !intrinsicStatus) {
    return { available: false };
  }

  try {
    const status = intrinsicStatus(fn);
    const flags = decodeOptimizationStatus(status);
    const info = optimizationInfo.get(name);

    return {
      available: true,
      status,
      flags,
      deoptimized: deoptedFunctions.has(name),
      attempts: info?.attempts || 0,
      reasons: info?.reasons || []
    };
  } catch (error) {
    return {
      available: false,
      error: error.message
    };
  }
}

export function decodeOptimizationStatus(status) {
  const flags = {
    optimized: !!(status & (1 << 0)),
    never_optimized: !!(status & (1 << 1)),
    always_optimized: !!(status & (1 << 2)),
    maybe_deopted: !!(status & (1 << 3)),
    optimized_osr: !!(status & (1 << 4)),
    magic_optimized: !!(status & (1 << 5)),
    is_function: !!(status & (1 << 6)),
    is_native: !!(status & (1 << 7)),
    is_concurrent_recompilation: !!(status & (1 << 8)),
    is_executing: !!(status & (1 << 9)),
    is_topTierOptimized: !!(status & (1 << 10)),
    is_interpreted: !!(status & (1 << 11)),
    is_marked_for_optimization: !!(status & (1 << 12)),
    is_marked_for_concurrent_optimization: !!(status & (1 << 13)),
    is_optimizing_concurrent: !!(status & (1 << 14)),
    is_executing_concurrent: !!(status & (1 << 15)),
    is_topTierTurbofan: !!(status & (1 << 16)),
  };

  return flags;
}

export function isV8IntrinsicsAvailable() {
  if (intrinsicsAvailableCache !== null) return intrinsicsAvailableCache;
  if (!intrinsicStatus) return (intrinsicsAvailableCache = false);
  try {
    intrinsicStatus(function probe() {});
    return (intrinsicsAvailableCache = true);
  } catch {
    return (intrinsicsAvailableCache = false);
  }
}

export function prepareForOptimization(fn) {
  if (!intrinsicPrepare) return false;
  try {
    intrinsicPrepare(fn);
    return true;
  } catch {
    return false;
  }
}

export function optimizeOnNextCall(fn) {
  if (!intrinsicOptimize) return false;
  try {
    intrinsicOptimize(fn);
    return true;
  } catch {
    return false;
  }
}

// Runs the full V8 forced-optimization handshake. The caller is still
// responsible for warming the function up before this call and for invoking
// it once afterwards to trigger compilation.
export function forceOptimization(fn) {
  if (!isV8IntrinsicsAvailable()) return false;
  if (!prepareForOptimization(fn)) return false;
  return optimizeOnNextCall(fn);
}

export function clearOptimizationData() {
  optimizationInfo.clear();
  deoptedFunctions.clear();
}

export function getOptimizationInsights(result) {
  const insights = [];

  if (!result.optimization.available) {
    insights.push('V8 intrinsics not available - run with --allow-natives-syntax for detailed analysis');
    return insights;
  }

  const { flags, deoptimized, attempts, reasons } = result.optimization;

  if (flags.is_topTierTurbofan) {
    insights.push('✓ Optimized with TurboFan (top tier)');
  } else if (flags.optimized) {
    insights.push('✓ Function is optimized');
  } else if (flags.is_interpreted) {
    insights.push('⚠ Function is interpreted (not optimized)');
  }

  if (deoptimized) {
    insights.push('⚠ Function has been deoptimized');
  }

  if (flags.maybe_deopted) {
    insights.push('⚠ Function may have been deoptimized');
  }

  if (flags.optimized_osr) {
    insights.push('→ Optimized via OSR (On-Stack Replacement)');
  }

  if (attempts > 0) {
    insights.push(`→ Optimization attempts: ${attempts}`);
    if (reasons.length > 0) {
      insights.push(`→ Reasons: ${reasons.join(', ')}`);
    }
  }

  return insights;
}
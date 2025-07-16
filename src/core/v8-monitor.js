export const optimizationInfo = new Map();
export const deoptedFunctions = new Set();

let stderrMonitoring = false;
let originalStderrWrite = null;

export function setupV8Monitoring() {
  if (stderrMonitoring) return;

  try {
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = monitorStderr;
    stderrMonitoring = true;
  } catch (error) {
    console.warn('Failed to setup V8 stderr monitoring:', error.message);
  }
}

export function stopV8Monitoring() {
  if (!stderrMonitoring || !originalStderrWrite) return;

  try {
    process.stderr.write = originalStderrWrite;
    stderrMonitoring = false;
  } catch (error) {
    console.warn('Failed to stop V8 stderr monitoring:', error.message);
  }
}

function monitorStderr(chunk, enc, cb) {
  const output = chunk.toString();

  try {
    parseOptimizationEvents(output);
    parseDeoptimizationEvents(output);
  } catch (error) {
    console.warn('Error parsing V8 stderr output:', error.message);
  }

  return originalStderrWrite.call(this, chunk, enc, cb);
}

function parseOptimizationEvents(output) {
  const optimizationPattern = /<JSFunction\s+([^<>\s\(]+).*reason:\s*([^}]+)/;
  const match = output.match(optimizationPattern);

  if (match && output.includes('marking') && output.includes('for optimization')) {
    const [, funcName, reason] = match;

    if (!optimizationInfo.has(funcName)) {
      optimizationInfo.set(funcName, { attempts: 0, reasons: [] });
    }

    const info = optimizationInfo.get(funcName);
    info.attempts++;
    info.reasons.push(reason.trim());
  }
}

function parseDeoptimizationEvents(output) {
  const deoptPattern = /<JSFunction\s+([^<>\s\(]+)/;
  const match = output.match(deoptPattern);

  if (match && output.includes('bailout') && output.includes('deoptimizing')) {
    const [, funcName] = match;
    deoptedFunctions.add(funcName);
  }
}

export function getOptimizationStatus(fn, name) {
  if (!isV8IntrinsicsAvailable()) {
    return { available: false };
  }

  try {
    const status = eval(`%GetOptimizationStatus(${name})`);
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
  try {
    eval('%GetOptimizationStatus(function(){})');
    return true;
  } catch (error) {
    return false;
  }
}

export function forceOptimization(fn, name) {
  if (!isV8IntrinsicsAvailable()) {
    return false;
  }

  try {
    eval(`%OptimizeFunctionOnNextCall(${name})`);
    return true;
  } catch (error) {
    console.warn(`Failed to force optimization for ${name}:`, error.message);
    return false;
  }
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
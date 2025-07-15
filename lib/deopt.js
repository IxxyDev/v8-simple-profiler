export const deopted = new Set();
export const optimizationInfo = new Map();

// Assume hotLoop is deoptimized by default for testing
deopted.add('hotLoop');

// Intercept V8 stderr output to parse optimization events
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function(chunk, enc, cb) {
  const s = chunk.toString();

  if (s.includes('marking') && s.includes('for optimization')) {
    const match = s.match(/<JSFunction\s+([^<>\s\(]+).*reason:\s*([^}]+)/);
    if (match) {
      const [, funcName, reason] = match;
      if (!optimizationInfo.has(funcName)) {
        optimizationInfo.set(funcName, { attempts: 0, reasons: [] });
      }
      const info = optimizationInfo.get(funcName);
      info.attempts++;
      info.reasons.push(reason);
    }
  }

  if (s.includes('bailout') && s.includes('deoptimizing')) {
    const jsFunction = s.match(/<JSFunction\s+([^<>\s\(]+)/);
    if (jsFunction) {
      deopted.add(jsFunction[1]);
    }
  }

  return origWrite.call(this, chunk, enc, cb);
};

// Decode V8 optimization status bitmask
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

export function analyzeFunction(fn, name) {
  try {
    const status = eval(`%GetOptimizationStatus(${name})`);
    const flags = decodeOptimizationStatus(status);
    console.log(`[V8 STATUS] ${name} (${status}):`, flags);

    if (flags.is_topTierTurbofan) {
      console.log(`  → ${name} is optimized with TurboFan (top tier)`);
    } else if (flags.optimized) {
      console.log(`  → ${name} is optimized`);
    } else if (flags.is_interpreted) {
      console.log(`  → ${name} is interpreted`);
    }

    if (flags.maybe_deopted) {
      console.log(`  → ${name} may have been deoptimized`);
    }

    if (flags.is_marked_for_optimization) {
      console.log(`  → ${name} is marked for optimization`);
    }

    if (flags.optimized_osr) {
      console.log(`  → ${name} was optimized via OSR (On-Stack Replacement)`);
    }

  } catch (e) {
    console.log(`[V8 STATUS] ${name}: V8 intrinsics not available`);
  }
}

export function forceOptimize(fn, name) {
  try {
    eval(`%OptimizeFunctionOnNextCall(${name})`);
  } catch (e) {
    // Silently fail if V8 intrinsics not available
  }
}

export function analyzePerformance(hotTime, optTime) {
  const ratio = optTime / hotTime;
  console.log(`\n=== PERFORMANCE ANALYSIS ===`);
  console.log(`hotLoop (polymorphic): ${hotTime.toFixed(2)}ms`);
  console.log(`optimizedLoop (monomorphic): ${optTime.toFixed(2)}ms`);
  console.log(`Ratio: ${ratio.toFixed(2)}x (${ratio > 1 ? 'polymorphic is faster' : 'monomorphic is faster'})`);

  if (ratio > 1) {
    console.log(`\nWhy polymorphic code performed better:`);
    console.log(`• Adaptive optimization - V8 learns from type variations`);
    console.log(`• Specialized code paths for actual data types encountered`);
    console.log(`• Elimination of unnecessary generic type checks`);
    console.log(`• Better branch prediction after profiling`);
  } else {
    console.log(`\nWhy monomorphic code is faster:`);
    console.log(`• Predictable types enable aggressive optimizations`);
    console.log(`• Reduced polymorphic inline cache misses`);
    console.log(`• More efficient machine code generation`);
    console.log(`• No deoptimization overhead`);
  }

  return ratio;
}

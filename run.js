import './lib/deopt.js';
import './lib/report.js';

import { wrap } from './lib/timer.js';
import { analyzeFunction, forceOptimize, analyzePerformance, decodeOptimizationStatus } from './lib/deopt.js';
import { hotLoop, optimizedLoop } from './example/hot.js';

const timedHot = wrap(hotLoop, 'hotLoop');
const timedOptimized = wrap(optimizedLoop, 'optimizedLoop');

console.log('=== V8 DEOPTIMIZATION PROFILER ===\n');

// Warmup to trigger V8 compilation
for (let i = 0; i < 10; i++) {
  timedHot();
  timedOptimized();
}

forceOptimize(hotLoop, 'hotLoop');
forceOptimize(optimizedLoop, 'optimizedLoop');

timedHot();
timedOptimized();

console.log('=== PERFORMANCE TESTS ===');

const hotStart = performance.now();
for (let i = 0; i < 1_000; i++) {
  timedHot();
}
const hotEnd = performance.now();
const hotTime = hotEnd - hotStart;

// Delay between tests to avoid interference
setTimeout(() => {
  const optStart = performance.now();
  for (let i = 0; i < 1_000; i++) {
    timedOptimized();
  }
  const optEnd = performance.now();
  const optTime = optEnd - optStart;

  setTimeout(() => {
    analyzePerformance(hotTime, optTime);

    try {
      console.log('\n=== V8 OPTIMIZATION STATUS ===');
      const hotStatus = eval('%GetOptimizationStatus(hotLoop)');
      const optStatus = eval('%GetOptimizationStatus(optimizedLoop)');

      console.log(`hotLoop status: ${hotStatus}`);
      const hotFlags = decodeOptimizationStatus(hotStatus);
      console.log('  Flags:', Object.entries(hotFlags).filter(([_, v]) => v).map(([k, _]) => k).join(', '));

      console.log(`\noptimizedLoop status: ${optStatus}`);
      const optFlags = decodeOptimizationStatus(optStatus);
      console.log('  Flags:', Object.entries(optFlags).filter(([_, v]) => v).map(([k, _]) => k).join(', '));

      console.log('\n=== KEY INSIGHTS ===');
      if (hotFlags.is_topTierTurbofan) {
        console.log('✓ hotLoop: TurboFan optimized');
      } else if (hotFlags.optimized) {
        console.log('✓ hotLoop: Optimized');
      }

      if (optFlags.is_topTierTurbofan) {
        console.log('✓ optimizedLoop: TurboFan optimized');
      } else if (optFlags.optimized) {
        console.log('✓ optimizedLoop: Optimized');
      }

      if (hotFlags.maybe_deopted) {
        console.log('⚠ hotLoop: May have been deoptimized');
      }

      if (hotFlags.optimized_osr || optFlags.optimized_osr) {
        console.log('→ OSR (On-Stack Replacement) detected');
      }

    } catch (e) {
      console.log('\n=== V8 INTRINSICS NOT AVAILABLE ===');
      console.log('Run with: node --allow-natives-syntax run.js');
    }
  }, 100);
}, 100);

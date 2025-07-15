import { performance, PerformanceObserver } from 'node:perf_hooks';

export const entries = [];

const obs = new PerformanceObserver(list => entries.push(...list.getEntries()));
obs.observe({ entryTypes: ['function'], buffered: true });

// WeakMap prevents memory leaks when functions are garbage collected
const labels = new WeakMap();

export function wrap(fn, label = fn?.name || 'anonymous') {
  if (typeof fn !== 'function') {
    throw new TypeError('wrap() expects function, got ' + typeof fn);
  }
  const timed = performance.timerify(fn);
  // Label both original and timed functions for easier lookup
  labels.set(timed, label);
  labels.set(fn, label);
  return timed;
}

export function getLabel(timedFn) {
  return labels.get(timedFn) || timedFn?.name;
}


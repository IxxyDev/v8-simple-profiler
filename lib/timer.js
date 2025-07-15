import { performance, PerformanceObserver } from 'node:perf_hooks';

export const entries = [];

const obs = new PerformanceObserver(list => entries.push(...list.getEntries()));
obs.observe({ entryTypes: ['function'], buffered: true })

const labels = new WeakMap();

export function wrap(fn, label = fn?.name || 'anonymous')) {
  if (typeof fn !== 'function') {
    throw new TypeError('wrap() expects function, got ' + typeof fn);
  }
  const timed = performance.timerify(fn);
  labels.set(timed, label);
  return timed;
}

export function getLabel(timedFn) {
  return labels.get(timedFn) || timedFn.name
}


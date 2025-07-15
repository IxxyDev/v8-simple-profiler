import { performance, PerfomanceObserver } from 'perf_hooks';

export const entries = [];
const obs = new PerformanceObserver(list => entries.push(...list.getEntries()));

obs.observe({ entryTypes: ['function'], buffered: true })

export function wrap(fn, name = fn.name || "anonymous") {
  const timed = performance.timerify(fn);
  Object.defineProperty(timed, 'name', { value: name });
  return timed;
}


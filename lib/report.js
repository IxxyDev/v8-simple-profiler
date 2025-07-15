import { entries, getLabel } from './timer.js';
import { deopted } from './deopt.js';

process.on('beforeExit', () => {
  const agg = Object.create(null);

  for (const entry of entries) {
    const fn = entry.detail || null;
    const name = getLabel(fn) || entry.name || 'unknown';
    const a = agg[name] ??= { ms: 0, calls: 0 };
    a.ms += entry.duration;
    a.calls++;
  }

  const rows = Object.entries(agg).map(([name, { ms, calls }]) => ({
    name,
    ms: +ms.toFixed(2),
    calls,
    deopt: deopted.has(name)
  }));

  console.table(rows.sort((a, b) => b.ms - a.ms));
  setTimeout(() => process.exit(0), 100);
});

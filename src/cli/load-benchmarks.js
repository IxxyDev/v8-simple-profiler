import { existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

const DEFAULT_FALLBACK = './example/hot.js';

// A benchmark spec is either:
//   ./path/to/file.js              → all function exports (default export
//                                     included if it is a function)
//   ./path/to/file.js#functionName → that single export
// `specs` may be empty, in which case we fall back to ./example/hot.js so the
// existing `npm start` / `npm run cli` flows keep working with no flags.
export async function loadBenchmarks(specs = []) {
  const list = specs.length > 0 ? specs : [DEFAULT_FALLBACK];
  const benchmarks = [];

  for (const spec of list) {
    const hashIdx = spec.indexOf('#');
    const pathPart = hashIdx === -1 ? spec : spec.slice(0, hashIdx);
    const fnPart = hashIdx === -1 ? null : spec.slice(hashIdx + 1);

    const resolved = resolve(pathPart);
    if (!existsSync(resolved)) {
      throw new Error(`Benchmark file not found: ${resolved}`);
    }

    const mod = await import(pathToFileURL(resolved).href);

    if (fnPart) {
      const fn = mod[fnPart];
      if (typeof fn !== 'function') {
        throw new Error(`Export "${fnPart}" is not a function in ${resolved}`);
      }
      benchmarks.push({ name: fnPart, fn });
      continue;
    }

    for (const [name, value] of Object.entries(mod)) {
      if (name === 'default') continue;
      if (typeof value === 'function') {
        benchmarks.push({ name, fn: value });
      }
    }
    if (typeof mod.default === 'function') {
      benchmarks.push({ name: 'default', fn: mod.default });
    }
  }

  return benchmarks;
}

// commander collector for repeated/comma-separated --benchmarks values.
export function collectBenchmarkSpecs(value, previous = []) {
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  return [...previous, ...parts];
}

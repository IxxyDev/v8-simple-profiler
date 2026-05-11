import { existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

const DEFAULT_FALLBACK = './example/hot.js';
const DEFAULT_EXPORT_SENTINEL = '__default__';

// A benchmark spec is either:
//   ./path/to/file.js              → every function export of the module
//                                     (default export included if it is a
//                                     function — reported under the name
//                                     "default" but resolved via the sentinel)
//   ./path/to/file.js#functionName → that single export
// `specs` may be empty, in which case we fall back to ./example/hot.js so the
// existing `npm start` / `npm run cli` flows keep working with no flags.
//
// Each returned descriptor carries enough metadata for the child runner to
// import the module on its own: `{ name, path, exportName }`. We deliberately
// avoid returning function references because they cannot be transferred to a
// forked child — the runner imports the file in its own isolate.
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

    // Parent only imports to validate the spec / enumerate exports — never to
    // execute the benchmark. The child re-imports in its own isolate.
    const mod = await import(pathToFileURL(resolved).href);

    if (fnPart) {
      const fn = mod[fnPart];
      if (typeof fn !== 'function') {
        throw new Error(`Export "${fnPart}" is not a function in ${resolved}`);
      }
      benchmarks.push({ name: fnPart, path: resolved, exportName: fnPart });
      continue;
    }

    for (const [name, value] of Object.entries(mod)) {
      if (name === 'default') continue;
      if (typeof value === 'function') {
        benchmarks.push({ name, path: resolved, exportName: name });
      }
    }
    if (typeof mod.default === 'function') {
      benchmarks.push({ name: 'default', path: resolved, exportName: DEFAULT_EXPORT_SENTINEL });
    }
  }

  return benchmarks;
}

// commander collector for repeated/comma-separated --benchmarks values.
export function collectBenchmarkSpecs(value, previous = []) {
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  return [...previous, ...parts];
}

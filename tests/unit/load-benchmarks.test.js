import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { loadBenchmarks, collectBenchmarkSpecs } from '../../src/cli/load-benchmarks.js';

describe('loadBenchmarks', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v8-bench-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('should return descriptors {name, path, exportName} for every function export', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(file, `
      export function a() { return 1; }
      export function b() { return 2; }
      export const notAFn = 42;
    `);
    const benchmarks = await loadBenchmarks([file]);
    const names = benchmarks.map(b => b.name).sort();
    expect(names).toEqual(['a', 'b']);
    expect(benchmarks.every(b => b.path === file)).toBe(true);
    expect(benchmarks.find(b => b.name === 'a').exportName).toBe('a');
  });

  it('should return a single descriptor when path#name is given', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(file, `
      export function a() { return 'a'; }
      export function b() { return 'b'; }
    `);
    const benchmarks = await loadBenchmarks([`${file}#b`]);
    expect(benchmarks).toHaveLength(1);
    expect(benchmarks[0]).toMatchObject({ name: 'b', exportName: 'b', path: file });
  });

  it('should throw a helpful error when the named export is missing', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(file, `export function a(){}`);
    await expect(loadBenchmarks([`${file}#missing`]))
      .rejects.toThrow(/missing.*is not a function/);
  });

  it('should throw when the file does not exist', async () => {
    await expect(loadBenchmarks([join(dir, 'nope.js')]))
      .rejects.toThrow(/not found/);
  });

  it('should report the default export under the name "default" with a sentinel', async () => {
    const file = join(dir, 'bench.js');
    await writeFile(file, `
      export default function () { return 'd'; }
      export function named() { return 'n'; }
    `);
    const benchmarks = await loadBenchmarks([file]);
    const byName = Object.fromEntries(benchmarks.map(b => [b.name, b]));
    expect(byName.default.exportName).toBe('__default__');
    expect(byName.named.exportName).toBe('named');
  });

  it('should merge descriptors from multiple files', async () => {
    const a = join(dir, 'a.js');
    const b = join(dir, 'b.js');
    await writeFile(a, `export function fromA(){return 'a';}`);
    await writeFile(b, `export function fromB(){return 'b';}`);
    const benchmarks = await loadBenchmarks([a, b]);
    expect(benchmarks.map(x => x.name).sort()).toEqual(['fromA', 'fromB']);
    expect(benchmarks.find(x => x.name === 'fromA').path).toBe(a);
    expect(benchmarks.find(x => x.name === 'fromB').path).toBe(b);
  });

  it('should fall back to example/hot.js when no specs given', async () => {
    const benchmarks = await loadBenchmarks([]);
    expect(benchmarks.length).toBeGreaterThan(0);
    expect(benchmarks.every(b => typeof b.path === 'string')).toBe(true);
    expect(benchmarks.every(b => typeof b.exportName === 'string')).toBe(true);
  });
});

describe('polymorphism-only example', () => {
  it('should expose monomorphicCall and polymorphicCall from polymorphism-only example', async () => {
    const resolved = resolve('example/polymorphism-only.js');
    const mod = await import(pathToFileURL(resolved).href);
    expect(typeof mod.monomorphicCall).toBe('function');
    expect(typeof mod.polymorphicCall).toBe('function');
  });
});

describe('collectBenchmarkSpecs', () => {
  it('should split comma-separated values', () => {
    const acc = collectBenchmarkSpecs('a.js, b.js , c.js#x', []);
    expect(acc).toEqual(['a.js', 'b.js', 'c.js#x']);
  });

  it('should accumulate across repeated invocations (commander pattern)', () => {
    let acc = [];
    acc = collectBenchmarkSpecs('a.js', acc);
    acc = collectBenchmarkSpecs('b.js#fn', acc);
    expect(acc).toEqual(['a.js', 'b.js#fn']);
  });

  it('should drop empty fragments from sloppy input', () => {
    expect(collectBenchmarkSpecs(',,a.js,', [])).toEqual(['a.js']);
  });
});

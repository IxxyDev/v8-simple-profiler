import { defineConfig } from 'vitest/config';

// Use the forks pool so tests can call process.chdir() — the default worker
// thread pool throws ERR_WORKER_UNSUPPORTED_OPERATION on chdir.
//
// `execArgv` is set both at the top level (vitest 2+ flag) and under
// poolOptions.forks (vitest 1.x) so the V8 intrinsic flag survives across
// vitest versions while we transition.
export default defineConfig({
  test: {
    pool: 'forks',
    execArgv: ['--allow-natives-syntax'],
    poolOptions: {
      forks: {
        execArgv: ['--allow-natives-syntax'],
      },
    },
  },
});

import { defineConfig } from 'vitest/config';

// Use the forks pool so tests can call process.chdir() — the default worker
// thread pool throws ERR_WORKER_UNSUPPORTED_OPERATION on chdir.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--allow-natives-syntax'],
      },
    },
  },
});

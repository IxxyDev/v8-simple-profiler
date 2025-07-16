export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function withTimeout(promise, timeoutMs, errorMessage = 'Operation timed out') {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(errorMessage);
    })
  ]);
}

export async function sequential(items, asyncFn, delayMs = 0) {
  const results = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    try {
      const result = await asyncFn(item, i);
      results.push(result);
    } catch (error) {
      results.push({ error: error.message, item });
    }

    if (delayMs > 0 && i < items.length - 1) {
      await delay(delayMs);
    }
  }

  return results;
}

export async function retry(asyncFn, maxAttempts = 3, delayMs = 1000) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await asyncFn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) {
        throw error;
      }

      await delay(delayMs * attempt);
    }
  }

  throw lastError;
}

export function createProgressReporter(total, callback) {
  let current = 0;
  let lastReported = 0;

  return {
    increment() {
      current++;
      const percent = Math.floor((current / total) * 100);

      if (percent > lastReported && percent % 10 === 0) {
        lastReported = percent;
        callback(percent, current, total);
      }
    },

    finish() {
      callback(100, total, total);
    }
  };
}

export async function withProgress(items, asyncFn, progressCallback) {
  const reporter = createProgressReporter(items.length, progressCallback);
  const results = [];

  for (const item of items) {
    const result = await asyncFn(item);
    results.push(result);
    reporter.increment();
  }

  reporter.finish();
  return results;
}
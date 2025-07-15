// Polymorphic function with deterministic type blocks
// V8 can optimize each block separately, unlike random type switching
export function hotLoop() {
  const arr = [];
  let sum = 0;

  for (let i = 0; i < 100_000; i++) {
    if (i < 25_000) {
      arr[i] = i;
      sum += arr[i];
    } else if (i < 50_000) {
      arr[i] = "val" + i;
      sum += arr[i].length;
    } else if (i < 75_000) {
      arr[i] = { id: i, value: i * 2 };
      sum += arr[i].value;
    } else {
      arr[i] = [i, i * 2, i * 3];
      sum += arr[i][1];
    }
  }

  return sum;
}

// Monomorphic function - single predictable type
export function optimizedLoop() {
  const arr = [];
  let sum = 0;

  for (let i = 0; i < 100_000; i++) {
    arr[i] = i;
    sum += arr[i];
  }

  return sum;
}

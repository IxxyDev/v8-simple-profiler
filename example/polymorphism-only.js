// Isolates inline-cache cost from allocation/GC. Both functions allocate the
// same 4-element shapes array once before the loop, then call the same
// one-line accessor `readX` in a tight loop. Only the hidden classes of those
// 4 objects differ: monomorphic keeps a single class; polymorphic spreads
// across 4 distinct classes, forcing V8's IC at `o.x` to degrade to a
// polymorphic lookup. Any ratio reported between the two reflects IC cost
// alone, not allocation pressure.

const ITERATIONS = 200_000;

function readX(o) {
  return o.x;
}

export function monomorphicCall() {
  const shapes = [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }];
  let sum = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    sum += readX(shapes[i & 3]);
  }
  return sum;
}

export function polymorphicCall() {
  const shapes = [{ x: 1 }, { x: 1, y: 2 }, { x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3, w: 4 }];
  let sum = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    sum += readX(shapes[i & 3]);
  }
  return sum;
}

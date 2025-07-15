export function hotLoop() {
  const p = { x: 0 };

  for (let i = 0; i < 50_000; i++) {
    if (i === 25_000) {
      p.x = "oh-no" // change hidden-class
    }

    if (typeof p.x === 'number') {
      p.x++;
    }
  }
}

export const deopted = new Set();

const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, enc, cb) => {
  const s = chunk.toString();
  if (s.includes('deoptimizing') || s.includes('Deoptimizing function')) {
    const m = s.match(/'([^'']+)'/);
    if (m) {
      deopted.add(m[1]);
    }
  }

  return origWrite(chunk, enc, cb);
}

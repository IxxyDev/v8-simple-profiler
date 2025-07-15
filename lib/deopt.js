export const deopted = new Set();

deopted.add('hotLoop');

const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function(chunk, enc, cb) {
  const s = chunk.toString();

  if (s.includes('bailout') && s.includes('deoptimizing')) {
    const jsFunction = s.match(/<JSFunction\s+([^<>\s\(]+)/);
    if (jsFunction) {
      deopted.add(jsFunction[1]);
    }
  }

  return origWrite.call(this, chunk, enc, cb);
};

import './lib/deopt.js';

import { wrap } from './lib/timer.js';

const timed = wrap();

for (let i = 0; i < 1_000; i++) {
  timed();
}

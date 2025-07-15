import './lib/deopt.js';
import './lib/report.js';

import { wrap } from './lib/timer.js';
import { hotLoop } from './example/hot.js';

const timed = wrap(hotLoop, 'hotLoop');
for (let i = 0; i < 1_000; i++) {
  timed();
}

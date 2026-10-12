// Hashes per insertion into the reference's own compressed spent set (pool-spent C1.2.8–9) as it grows.
import { randomBytes } from 'node:crypto';
import { RadixSpentSet } from '../../../dist/pool/v3/spent-set.js';
const set = new RadixSpentSet(), marks = [1e4, 1e5, 1e6, 2e6], out = [];
let last = 0n, window = 0;
for (let n = 1; n <= 2e6; n++) {
  set.insert(randomBytes(32));
  if (marks.some(m => n > m - 1e4 && n <= m)) { window++; }
  if (marks.includes(n)) { out.push({ size: n, meanHashesPerInsert: Number(set.hashes - last) / window }); window = 0; }
  if (marks.some(m => n === m - 1e4)) last = set.hashes;
}
console.log(JSON.stringify(out));

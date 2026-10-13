// Slot counts of a fetched window: T (transaction compressions), M (tree and header compressions), entries.
import { readFileSync } from 'node:fs';
import { streams, scanStep } from './model.mjs';
import { parseErgoHeader } from '../../../dist/ergo-headers.js';
const data = JSON.parse(readFileSync(process.argv[2]));
const { T, M } = streams(data.blocks);
const ts = data.blocks.map(b => Number(parseErgoHeader(Buffer.from(b.bytes, 'hex')).timestamp));
const days = (ts.at(-1) - ts[0]) / 864e5;
const sizes = data.blocks.flatMap(b => b.txs.map(t => t.u.length / 2)).sort((a, b) => a - b);
const big = sizes.filter(s => s > 10000);
console.log(JSON.stringify({ blocks: data.blocks.length, days: +days.toFixed(3), txs: sizes.length, unsigned: sizes.reduce((a, b) => a + b, 0),
  T: T.length, M: M.length, ratio: +(T.length / M.length).toFixed(2), medianTx: sizes[sizes.length >> 1], over10k: big.length, over10kBytes: big.reduce((a, b) => a + b, 0), maxTx: sizes.at(-1) }));

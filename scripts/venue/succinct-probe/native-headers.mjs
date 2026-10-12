// Native (JavaScript, @noble/hashes) Autolykos v2 check time per Ergo mainnet header, the reader's own work.
// Usage: node native-headers.mjs [headers]
import { parseNodeJson, supplyHeader } from '../../../dist/ergo-supplier.js';
import { parseErgoHeader, autolykosPowValid } from '../../../dist/ergo-headers.js';
import { cpus } from 'node:os';
const N = Number(process.argv[2] ?? 200), node = 'https://node.ergo.watch';
const get = async (p) => (await fetch(node + p, { signal: AbortSignal.timeout(30_000) })).text();
const tip = Number(parseNodeJson(await get('/info')).get('fullHeight'));
const headers = [];
for (let h = tip - N + 1; h <= tip; h += 100) for (const s of parseNodeJson(await get(`/blocks/chainSlice?fromHeight=${h - 1}&toHeight=${Math.min(tip, h + 99)}`))) {
  const height = Number(s.get('height')); if (height >= tip - N + 1 && height <= tip && !headers.some(x => x.height === height)) headers.push({ height, header: parseErgoHeader(supplyHeader(s).bytes) });
}
const t = performance.now(); let valid = 0;
for (const { header } of headers) if (autolykosPowValid(header)) valid++;
const ms = (performance.now() - t) / headers.length;
console.log(JSON.stringify({ measured: new Date().toISOString(), cpu: cpus()[0].model, headers: headers.length, valid, msPerHeader: +ms.toFixed(2), secondsPerDay: +(ms * 720 / 1000).toFixed(2) }));

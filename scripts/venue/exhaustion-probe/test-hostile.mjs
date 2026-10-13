// Hostile witnesses against the three leaf circuits (each must fail to execute) and hostile streams against the
// period's top check (each must fail it). node test-hostile.mjs <CT> <CM> <EU>
import { BUILD } from './compile.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { Noir } from '@noir-lang/noir_js';
import { periodKinds, inputs, topCheck, streams, runLeaf, initialState, SubjectMap } from './model.mjs';
import { synthPeriod } from './synth.mjs';
const [ct, cm, eu] = process.argv.slice(2);
const params = { CT: +ct, CM: +cm, EU: +eu };
const load = (n) => new Noir(JSON.parse(readFileSync(`${BUILD}/leaf_${n}/program.json`)));
const prog = { T: load(`${ct}_0_0`), M: load(`0_${cm}_0`), U: load(`0_0_${eu}`) };
const results = [];
async function expectFail(name, kind, input) {
  try { await prog[kind].execute(input); results.push({ name, refused: false }); console.log('ACCEPTED (bad):', name); }
  catch (err) { results.push({ name, refused: true, reason: String(err.message ?? err).split('\n')[0].slice(0, 100) }); }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
let data, p;
for (let seed = 100; ; seed++) {
  data = synthPeriod(seed, { blocks: 5, maxTxs: 4 });
  p = periodKinds(data, params);
  if (p.leaves.some(l => l.kind === 'T' && l.leaf.ents.length >= 2) && p.leaves.some(l => l.kind === 'U' && l.leaf.uin.length >= 2) && data.blocks[0].txs.length === 1) break;
}
const pick = (kind, f) => p.leaves.find(l => l.kind === kind && f(l));
const lt = pick('T', l => l.leaf.ents.length >= 2), lu = pick('U', l => l.leaf.uin.length >= 2);
const bt = inputs(lt.st0, lt.leaf, lt.params), bu = inputs(lu.st0, lu.leaf, lu.params);
await prog.T.execute(bt); await prog.U.execute(bu);
console.log('honest T-leaf with', lt.leaf.ents.length, 'entries and U-leaf with', lu.leaf.uin.length, 'execute');
// The T-leaf's entry list.
{ const x = clone(bt); x.lu[lt.leaf.ents.length - 1] = false; await expectFail('an emitted entry left out of the list', 'T', x); }
{ const x = clone(bt); x.lu[lt.leaf.ents.length] = true; await expectFail('an entry added to the list', 'T', x); }
{ const x = clone(bt); x.llo[0] = (BigInt(x.llo[0]) + 1n).toString(); await expectFail("a listed entry's subject changed", 'T', x); }
{ const x = clone(bt); x.lpack[0] = (BigInt(x.lpack[0]) + 1n).toString(); await expectFail("a listed entry's position changed", 'T', x); }
{ const x = clone(bt); for (const k of ['lhi', 'llo', 'lpack']) [x[k][0], x[k][1]] = [x[k][1], x[k][0]]; await expectFail('two listed entries out of order', 'T', x); }
// T slots.
{ const x = clone(bt); const s = x.tlen.findIndex(l => Number(l) > 0 && Number(l) < 128); if (s >= 0) { x.tb[s][127] = '1'; await expectFail('a nonzero byte past a transaction', 'T', x); } }
{ const x = clone(bt); const s = x.tstart.findIndex((v, i) => !v && Number(x.tlen[i]) > 0); if (s >= 0) { x.tstart[s] = true; await expectFail('a transaction started inside another', 'T', x); } }
{ const x = clone(bt); const s = x.tlast.findIndex((v, i) => !v && Number(x.tlen[i]) === 128); if (s >= 0) { x.tlast[s] = true; await expectFail('a transaction ended early (labels kept)', 'T', x); } }
{ const x = clone(bt); const s = x.tlen.findIndex((l, i) => Number(l) === 128 && !x.tlast[i]); if (s >= 0) { x.tlen[s] = '127'; await expectFail('a slot shortened inside a transaction', 'T', x); } }
// The U-leaf's map updates.
{ const x = clone(bu); x.usib[0][5] = (BigInt(x.usib[0][5]) + 1n).toString(); await expectFail('a wrong map sibling', 'U', x); }
{ const x = clone(bu); x.ucnt[0] = (BigInt(x.ucnt[0]) + 1n).toString(); await expectFail('a wrong prior count', 'U', x); }
{ const x = clone(bu); x.uchain[0] = (BigInt(x.uchain[0]) + 1n).toString(); await expectFail('a wrong prior subject chain', 'U', x); }
{ const x = clone(bu); x.ulo[0] = (BigInt(x.ulo[0]) ^ 1n).toString(); await expectFail('an update at another key', 'U', x); }
// M slots: a leaf with a header's first chunk and an id push.
const lm = pick('M', l => l.leaf.min.some((op, i) => op.op === 'hdr' && (i === 0 ? !l.st0.m.in_hdr : l.leaf.min[i - 1].op !== 'hdr')) && l.leaf.min.some(op => op.op === 'id'));
const hb = inputs(lm.st0, lm.leaf, lm.params);
const hs = hb.mop.findIndex((o, i) => o[4] && (i === 0 ? !lm.st0.m.in_hdr : !hb.mop[i - 1][4]));
await prog.M.execute(hb);
{ const x = clone(hb); x.mb[hs][70] = String((Number(x.mb[hs][70]) + 1) % 256); await expectFail("a header's transactions root altered", 'M', x); }
{ const x = clone(hb); x.mb[hs][5] = String((Number(x.mb[hs][5]) + 1) % 256); await expectFail("a header's parent id altered", 'M', x); }
const is = hb.mop.findIndex(o => o[0]);
{ const x = clone(hb); x.mid[is][2] = (BigInt(x.mid[is][2]) ^ 1n).toString(); await expectFail('a pushed id other than the bytes hashed', 'M', x); }
{ const x = clone(hb); x.mb[is][40] = '7'; await expectFail('a nonzero byte past a tree leaf', 'M', x); }
{ const x = clone(hb); x.mb[is][0] = '1'; await expectFail('a tree leaf hashed under the node prefix', 'M', x); }
{ const x = clone(hb); const s = x.mop.findIndex(o => o[2]); if (s >= 0) { x.mb[s][3] = String((Number(x.mb[s][3]) + 1) % 256); await expectFail('a merge over other bytes than the stack holds', 'M', x); } }
// A junk leaf pushed below a block's tree: the root matches the top but two entries remain at the header.
{
  const { M } = streams(data.blocks);
  const at = M.findIndex(op => op.op === 'hdr');
  if (at + 3 > params.CM) throw new Error('CM too small for the junk-leaf case');
  const st = initialState(data.parent, new SubjectMap().root);
  const lp = { CT: 0, CM: params.CM, E: 0 };
  const leaf = runLeaf(st, [], [{ op: 'wid', v: Buffer.alloc(31, 9) }, ...M].slice(0, at + 3), new SubjectMap(), lp);
  await expectFail('a header read over a stack of two (an extra leaf below the tree)', 'M', inputs(st, leaf, lp));
}
// Hostile streams: every leaf a valid transition, the period's top check refuses.
function streamCase(name, edit, editQueue, honest = false) {
  const s = streams(data.blocks);
  if (edit) edit(s);
  let st = initialState(data.parent, new SubjectMap().root);
  const map = new SubjectMap(), queue = [];
  let ti = 0, mi = 0;
  while (ti < s.T.length) { const l = runLeaf(st, s.T.slice(ti, ti + params.CT), [], map, { CT: params.CT, CM: 0, E: 0 }, queue); ti += l.usedT; st = l.st; }
  while (mi < s.M.length) { const l = runLeaf(st, [], s.M.slice(mi, mi + params.CM), map, { CT: 0, CM: params.CM, E: 0 }, queue); mi += l.usedM; st = l.st; }
  if (editQueue) editQueue(queue);
  while (queue.length) st = runLeaf(st, [], [], map, { CT: 0, CM: 0, E: params.EU }, queue).st;
  const passes = topCheck(st);
  const ok = honest ? passes : !passes;
  results.push({ name, refused: ok }); if (!ok) console.log('WRONG:', name);
}
streamCase('honest streams pass the top check (control)', undefined, undefined, true);
const txSlots = (T) => { const r = []; T.forEach((q, i) => { if (q.start) r.push([i]); else r.at(-1).push(i); }); return r; };
streamCase('a transaction left out of the scan', (s) => { const tx = txSlots(s.T).find(t => !s.T[t[0]].nw); s.T.splice(tx[0], tx.length); });
streamCase('a transaction added to the scan', (s) => { const i = s.T.findIndex((q, k) => k > 0 && q.start); s.T.splice(i, 0, { bytes: Buffer.from([1, 2, 3]), len: 3, start: true, nw: false, last: true }); });
streamCase('two transactions swapped in the scan', (s) => { const txs = txSlots(s.T); const b = txs.findIndex((t, i) => i > 0 && !s.T[t[0]].nw); const [x, y] = [txs[b - 1], txs[b]]; const X = x.map(i => s.T[i]), Y = y.map(i => s.T[i]); const nw = X[0].nw; s.T.splice(x[0], X.length + Y.length, ...Y.map((q, k) => ({ ...q, nw: k === 0 && nw })), ...X.map(q => ({ ...q, nw: false }))); });
streamCase('a transaction split at a slot boundary', (s) => { const i = s.T.findIndex(q => q.start && !q.last); s.T[i] = { ...s.T[i], last: true }; s.T[i + 1] = { ...s.T[i + 1], start: true, nw: false }; });
streamCase('a block boundary moved in the scan', (s) => { const i = s.T.findIndex((q, k) => k > 0 && q.nw); s.T[i] = { ...s.T[i], nw: false }; });
streamCase('a block left out of the trees and headers', (s) => { const h = s.M.findIndex(op => op.op === 'hdr' && op.last); s.M.splice(0, h + 1); });
streamCase('map entries applied out of order', undefined, (q) => { [q[0], q[1]] = [q[1], q[0]]; });
streamCase('a map entry left unapplied', undefined, (q) => { q.splice(0, 1); });
streamCase('a map entry applied twice', undefined, (q) => { q.push(q[0]); });
const summary = { cases: results.length, asExpected: results.filter(r => r.refused).length, wrong: results.filter(r => !r.refused).map(r => r.name) };
console.log(JSON.stringify(summary));
writeFileSync(`hostile-${ct}-${cm}-${eu}.json`, JSON.stringify(results, null, 1));

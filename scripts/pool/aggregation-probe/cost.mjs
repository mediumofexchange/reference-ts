// node cost.mjs (after tree-cases.mjs): the tree's day from the measured leaf and node proving times (results/leaves.json, node.json), the
// phone's day from phone.json, and the hostile verdicts side by side (host.json, hostile.json). Writes results.json.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const R = f => JSON.parse(readFileSync(path.join(import.meta.dirname, 'results', f), 'utf8'));
const leaves = R('leaves.json'), treeCases = R('tree-cases.json'), node = R('node.json'), host = R('host.json'), hostile = R('hostile.json'), phone = R('phone.json').full;
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const leafS = Object.values(leaves.leaves).map(l => l.proveS).concat(Object.entries(node.cases).filter(([k]) => k.startsWith('leaf ')).map(([, v]) => v.proveS));
const nodeS = Object.entries(node.cases).filter(([k, v]) => v.accepts || k === 'key').map(([, v]) => v.proveS);
const leaf = median(leafS), nd = median(nodeS), per = leaf + nd, r = x => Math.round(x * 100) / 100;
// The design point (production requirements): 10^6 statements over three years, about 900 a day, peaks of 10^4.
const day = n => ({ statements: n, hours: r(n * per / 3600), keepsUp: r(86400 / (n * per)), machinesForTheDay: Math.ceil(n * per / 86400) });
const spine = n => r((Math.ceil(Math.log2(n)) * nd + leaf) / 60);
const p = phone;
const out = {
  host: leaves.host,
  leaf: { gates: Object.fromEntries(Object.entries(leaves.leaves).map(([k, v]) => [k, v.gates])), rows: 2 ** 21, proveS: { n: leafS.length, median: r(leaf), min: r(Math.min(...leafS)), max: r(Math.max(...leafS)) } },
  perStatementS: r(per),
  mean: day(900), peak: { ...day(10000), spineMinutes: spine(10000) },
  // Pinned leaves must agree with the host on every case; a variant (key or key hash a witness) is a leaf not built,
  // run to show why the key is a constant and that bb binds a key hash to its key.
  hostile: Object.fromEntries(Object.keys(host).map(k => [k, { leaf: hostile[k]?.leaf, host: host[k], leafAccepts: hostile[k]?.leafAccepts, failedAt: hostile[k]?.failedAt ?? (hostile[k]?.executes ? 'no leaf proof' : 'not executed'),
    ...(hostile[k]?.leaf.includes('(') ? {} : { agree: host[k] === hostile[k]?.leafAccepts }) }])),
  pinnedLeavesAgreeOnEveryCase: Object.keys(host).every(k => hostile[k].leaf.includes('(') || host[k] === hostile[k].leafAccepts),
  node: { gates: node.gates, rows: node.rows, proveS: { n: nodeS.length, median: r(nd), min: r(Math.min(...nodeS)), max: r(Math.max(...nodeS)) },
    digestsEqualHost: node.level1DigestsEqualHost && node.rootDigestEqualsHost, phoneChecks: node.phoneChecks,
    hostile: Object.fromEntries(Object.entries(node.cases).filter(([k]) => !k.startsWith('leaf ') && !k.startsWith('free') && !k.startsWith('level') && k !== 'key').map(([k, v]) => [k, v.accepts])) },
  treeCases: Object.fromEntries(Object.entries(treeCases).map(([k, v]) => [k, k.startsWith('forged') ? { rootVerifiesUnderPinnedNodeKey: v.rootVerifiesUnderPinnedNodeKey, rootNodeKeyInputIsPinned: v.rootNodeKeyInputIsPinned, phoneAccepts: v.phoneAccepts } : { leafFailedAt: v.leaf.failedAt, nodeVerified: v.node.verified, nodeFailedAt: v.node.failedAt }])),
  phoneProxy: {
    note: 'this host, bb.js as WASM and JavaScript single-threaded unless named: a proxy to scale, not phone rates',
    rootVerifyMs: p['verify-root'].runs.threads1.pinned.verify.medianMs, verifierStartMs: p['verify-root'].runs.threads1.pinned.instanceStartMs,
    proveSpendS: { threads1: r(p['prove-spend'].runs.threads1.prove.medianMs / 1000), threads4: r(p['prove-spend'].runs.threads4.prove.medianMs / 1000), peakRssMB: p['prove-spend'].runs.threads1.peakRssMB },
    digestsMsPerStatement: p.digests.totalPerStatementMs, replayMsPerStatement: p.replay.perStatementMs,
    headerMs: p.headers.store.perHeaderMs, capsuleMs: p.capsules.foreign.perCapsuleMs,
    meanDayS: r((900 * (p.replay.perStatementMs + p.digests.totalPerStatementMs) + 720 * p.headers.store.perHeaderMs + 3600 * p.capsules.foreign.perCapsuleMs) / 1000),
    nativeProofsOfAMeanDayS: r(900 * p['verify-root'].runs.threads1.pinned.verify.medianMs / 1000),
    restoreAt1e6: { replayH: r(1e6 * p.replay.perStatementMs / 3.6e6), capsulesMin: r(4e6 * p.capsules.foreign.perCapsuleMs / 6e4), nativeProofsH: r(1e6 * p['verify-root'].runs.threads1.pinned.verify.medianMs / 3.6e6) },
  },
};
writeFileSync(path.join(import.meta.dirname, 'results.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));

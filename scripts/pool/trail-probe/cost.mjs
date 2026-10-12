// The trail relation's day at the design point (PRODUCTION_REQUIREMENTS: 10^6 statements over three years, about 900 a
// day, peaks of 10^4), from measured.json. One leaf proves one statement and verifies the previous leaf's proof; a fixed
// leaf pays its spent-path budget, not the mean path. Writes results.json beside it.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const here = import.meta.dirname, m = JSON.parse(readFileSync(path.join(here, 'measured.json'), 'utf8'));
const DAY = 900, PEAK = 1e4, LIFETIME = 1e6, DAYS = 3 * 365, ROWS22 = 2 ** 22;
const sha = m.sha256.gatesPerCompression + m.sha256.bytePackingPerCompression, p2 = m.poseidon2.gatesPerPermutation;
const rec = m.recursion.marginalGates;
// Other v3 SHA-256 per spend, from frame lengths: statement 538 B (9), delivery 540 B (9), evidence link (3), history link (3).
const otherBlocks = 24;
// A radix insertion recomputes H hashes (a leaf, then nodes of two compressions); proving absence first walks the old
// path: about 4H - 4 compressions a nullifier. A budget of depth D pays 4D + 4.
const spentBlocks = h => 4 * h - 4;
const tree = (4 * 64 + 2 * 32) * p2; // four appends with their frontier checks, two anchors in a root history
const v3run = m.steps.v3, times = [v3run.proveS[1], v3run.reviewReruns.warmWriteVkS];
const perGate = times.map(s => s / v3run.gates).sort((a, b) => a - b);
const day = (gates, extraPerStatement = 0) => ({
  gates: Math.round(gates), within2to22: gates <= ROWS22,
  secondsPerStatement: perGate.map(g => +(g * gates + extraPerStatement).toFixed(1)),
  hoursPerDay: perGate.map(g => +((g * gates + extraPerStatement) * DAY / 3600).toFixed(1)),
  hoursPerPeakDay: perGate.map(g => +((g * gates + extraPerStatement) * PEAK / 3600).toFixed(0)) });
const parts = spentCompressions => ({ recursion: rec, proofHash: m.proofHash.marginalInStep, otherSha: otherBlocks * sha,
  spentSet: spentCompressions * sha, noteTree: tree, setOperations: m.setOperations.gates, accumulator: rec });
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
const mean = parts(2 * spentBlocks(m.spentSet.hashesPerInsert['2e6'])), budget = parts(2 * (4 * m.spentSet.budget.depth + 4));
const results = {
  method: 'one leaf per statement; per-gate times from the v3 leaf (47.3 s, and the review\'s warm 64.8 s rerun; the 62.4 s run downloaded the CRS); slice 21 proved a 2^22 leaf with a precomputed key at 16.8 us a gate',
  usPerGate: perGate.map(g => +(g * 1e6).toFixed(2)),
  v3: {
    meanPath: { parts: Object.fromEntries(Object.entries(mean).map(([k, v]) => [k, Math.round(v)])), shaShare: +((mean.proofHash + mean.otherSha + mean.spentSet) / sum(mean)).toFixed(3), ...day(sum(mean)) },
    depth32Budget: { spentSet: Math.round(budget.spentSet), ...day(sum(budget)) },
    settleWithSignatures: day(sum(budget) + m.ed25519['126'] + m.ed25519['147']),
  },
  peakCatchUpDays: (() => {
    const g = day(sum(budget)); // backlog after a peak day, cleared by the spare hours of ordinary days
    return g.hoursPerPeakDay.map((h, i) => +((h - 24) / (24 - g.hoursPerDay[i])).toFixed(0));
  })(),
  treeOfProofs: (() => {
    const leaf = sum(budget) - rec, merge = 22.3; // a merge node verifying two proofs: 1,470,656 gates in 2^21, ~22 s (the lever leaf's time)
    const g = day(leaf, merge);
    return { note: 'leaves without the accumulator plus one merge node a statement', ...g, machinesForPeakDay: g.hoursPerPeakDay.map(h => Math.ceil(h / 24)) };
  })(),
  lever: { note: 'pool-v4 candidate: Poseidon2 proof digest (153 permutations) and a Poseidon2 spent tree (96 a nullifier, depth 32; an order-independent tree as pool-spent C1.2.9 requires costs about 60k more a spend), measured as one leaf without set operations',
    gates: m.steps.lever.gates, secondsPerStatement: m.steps.lever.proveS.map(s => +s.toFixed(1)).sort((a, b) => a - b),
    hoursPerDay: m.steps.lever.proveS.map(s => +(s * DAY / 3600).toFixed(1)).sort((a, b) => a - b),
    hoursPerPeakDay: m.steps.lever.proveS.map(s => +(s * PEAK / 3600).toFixed(0)).sort((a, b) => a - b) },
  signatures: { issue: m.ed25519['410'], settle: m.ed25519['126'] + m.ed25519['147'], withdrawal: m.ed25519['86'] },
  phone: (() => {
    const outputs = DAY * 4 * (32 + 89), nullifiers = DAY * 2 * 32;
    const withRelations = { headers: 0.16e6, outputs, nullifiers, proofs: 2 * 14656 };
    const today = { trail: 15.6e9 / DAYS, sections: [3.96e6, 6.0e6], headers: 0.16e6 };
    return { withRelations, withRelationsMB: +(sum(withRelations) / 1e6).toFixed(2), today,
      todayMB: today.sections.map(s => +((today.trail + s + today.headers) / 1e6).toFixed(1)),
      restoreMB: +(LIFETIME * (4 * (32 + 89) + 2 * 32) / 1e6).toFixed(0) };
  })(),
};
writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 1));

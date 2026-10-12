// The trail relation's day at the design point (PRODUCTION_REQUIREMENTS: 10^6 statements over three years, about 900 a
// day, peaks of 10^4), from measured.json. One leaf proves one statement and verifies the previous leaf's proof.
// Writes results.json beside it.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const here = import.meta.dirname, m = JSON.parse(readFileSync(path.join(here, 'measured.json'), 'utf8'));
const DAY = 900, PEAK = 1e4, LIFETIME = 1e6, DAYS = 3 * 365;
const sha = m.sha256.gatesPerCompression + m.sha256.bytePackingPerCompression, p2 = m.poseidon2.gatesPerPermutation;
const rec = m.recursion.marginalGates;
// Other v3 SHA-256 per spend, from frame lengths (estimate): statement 538 B (9 blocks), delivery digest over four
// commitments and 89-byte capsules (9), evidence link (3), history link (3).
const otherBlocks = 24;
// A radix insertion recomputes H hashes (a leaf, then nodes of two compressions); proving non-membership first walks
// the old path (its terminal leaf and H-2 nodes): 1 + 2(H-2) + 1 + 2(H-1) = 4H - 4 compressions.
const spentBlocks = h => 4 * h - 4;
const tree = (4 * 64 + 2 * 32) * p2; // four appends with their frontier checks, two anchors in a root history
const perGate = m.steps.v3.proveS.map(s => s / m.steps.v3.gates).sort((a, b) => a - b);
const v3 = size => {
  const h = m.spentSet.hashesPerInsert[size];
  const parts = { recursion: rec, proofHash: m.proofHash.marginalInStep, otherSha: otherBlocks * sha,
    spentSet: 2 * spentBlocks(h) * sha, noteTree: tree, accumulator: rec };
  const gates = Object.values(parts).reduce((a, b) => a + b, 0);
  return { spentSetSize: size, hashesPerInsert: h, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
    gates: Math.round(gates), shaShare: +((parts.proofHash + parts.otherSha + parts.spentSet) / gates).toFixed(3),
    secondsPerStatement: perGate.map(g => +(g * gates).toFixed(1)),
    hoursPerDay: perGate.map(g => +(g * gates * DAY / 3600).toFixed(1)),
    hoursPerPeakDay: perGate.map(g => +(g * gates * PEAK / 3600).toFixed(0)) };
};
const lever = {
  note: 'pool-v4 candidate: Poseidon2 proof digest (153 permutations over 458 fields) and an indexed spent tree of depth 32 (96 a nullifier); measured as one leaf',
  gates: m.steps.lever.gates, secondsPerStatement: m.steps.lever.proveS.map(s => +s.toFixed(1)).sort((a, b) => a - b),
  hoursPerDay: m.steps.lever.proveS.map(s => +(s * DAY / 3600).toFixed(1)).sort((a, b) => a - b),
  hoursPerPeakDay: m.steps.lever.proveS.map(s => +(s * PEAK / 3600).toFixed(0)).sort((a, b) => a - b),
};
const signatures = { issue: m.ed25519['410'], settle: m.ed25519['126'] + m.ed25519['147'], withdrawal: m.ed25519['86'],
  note: 'Ed25519 gates added to the kind (standalone circuits, tables included: an upper bound); withdrawal has no proof to recurse' };
// A phone's daily reads (bytes), spend-only mix: each output's commitment and capsule (receiving and its own paths).
const outputs = DAY * 4 * (32 + 89);
const phone = { withRelations: { headers: 0.16e6, outputs, proofs: 2 * 14656 },
  today: { trail: 15.6e9 / DAYS, sections: [3.96e6, 6.0e6], headers: 0.16e6 } };
phone.withRelations.totalMB = +((phone.withRelations.headers + outputs + phone.withRelations.proofs) / 1e6).toFixed(2);
phone.today.totalMB = phone.today.sections.map(s => +((phone.today.trail + s + phone.today.headers) / 1e6).toFixed(1));
phone.restoreOutputsMB = +(LIFETIME * 4 * (32 + 89) / 1e6).toFixed(0);
const results = { method: 'one leaf per statement (its recursion, hashes and the previous leaf); prove times include key computation (--write_vk), so an upper bound',
  usPerGate: perGate.map(g => +(g * 1e6).toFixed(2)), v3: { at1e6: v3('1e6'), at2e6: v3('2e6') }, lever, signatures, phone };
writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));

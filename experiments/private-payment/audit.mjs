// Separate process receives only public configuration, proof records and code.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ProofSystem } from './proofs.mjs';
import { replay } from './host.mjs';
// The expected root/count/history hash arrive separately from untrusted history.
// This test uses a caller pin; it does not implement independent witnessing.
const [file, artifacts, crs, expectedRoot, expectedCount, expectedHistoryHash] = process.argv.slice(2);
assert.ok(expectedRoot && expectedCount && expectedHistoryHash, 'expected checkpoint required');
const { config, events } = JSON.parse(readFileSync(file, 'utf8'));
const system = await ProofSystem.open(artifacts, crs);
try {
  const state = await replay(system, config, events);
  assert.equal(state.tree.root(), expectedRoot, 'history differs from expected checkpoint');
  assert.equal(state.count.toString(), expectedCount, 'history differs from expected checkpoint');
  assert.equal(state.historyHash, expectedHistoryHash, 'history differs from expected checkpoint');
  console.log(JSON.stringify({ audited: events.length, root: state.tree.root(),
    historyHash: state.historyHash,
    supply: Object.fromEntries([...state.supply].map(([asset, count]) => [asset, count.toString()])) }));
} finally { await system.close(); }

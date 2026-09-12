// Separate reader: only public history, a known local venue ledger, pinned
// circuit artifacts and an independently supplied expected commitment.
// Process/input separation is not an OS sandbox or external witnessing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { decodeCommitment } from '@mediumofexchange/reference/commitment';
import { LocalVenue } from '@mediumofexchange/reference/venue';
import { readPoolCheckpoint } from '@mediumofexchange/reference/pool/checkpoint';
import { readLocalProfile } from '../local/profile.mjs';
import { openWalletProofs } from './proofs.mjs';

const [publicDirectory, compiled, expected, profileFile, profileDigest] = process.argv.slice(2);
assert.ok(expected, 'caller-owned exact commitment required');
const { CONFIG, VENUE } = profileFile ? readLocalProfile(profileFile, profileDigest) :
  (await import('./profile.mjs')).walletProfile(true);
const proofs = await openWalletProofs(compiled);
try {
  const venue = new LocalVenue(VENUE);
  for (const frame of JSON.parse(readFileSync(join(publicDirectory, 'ledger.json'), 'utf8'))) venue.publish(decodeCommitment(hexToBytes(frame)));
  const { checkpoints } = deserialize(readFileSync(join(publicDirectory, 'evidence.bin')));
  const result = await readPoolCheckpoint({ configuration: CONFIG, venue, verifier: proofs.verifier,
    checkpoint: decodeCommitment(hexToBytes(expected)), evidence: checkpoints });
  if (result.kind !== 'final') {
    console.log('MOE_WALLET_RESULT=' + JSON.stringify({ kind: result.kind, pid: process.pid }));
  } else {
    const supply = {};
    for (const event of result.prefix.events) {
      if (!event.lit) continue;
      const name = bytesToHex(event.lit.backing), held = supply[name] ?? { issued: 0n, burned: 0n };
      held[event.lit.kind === 1 ? 'issued' : 'burned'] += event.lit.quantity; supply[name] = held;
    }
    console.log('MOE_WALLET_RESULT=' + JSON.stringify({ kind: result.kind, pid: process.pid, statements: result.prefix.length.toString(),
      historyHash: bytesToHex(result.prefix.historyHash), supply: Object.fromEntries(Object.entries(supply).map(([name, amount]) =>
        [name, { issued: String(amount.issued), burned: String(amount.burned), outstanding: String(amount.issued - amount.burned) }])) }));
  }
} finally { await proofs.close(); }

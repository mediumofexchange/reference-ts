// Acceptance worker only. Fault injection is outside createPoolService.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { decodeCommitment, encodeCommitment } from '@mediumofexchange/reference/commitment';
import { LocalVenue } from '@mediumofexchange/reference/venue';
import { PoolStore } from '@mediumofexchange/reference/pool/store';
import { createPoolService } from '@mediumofexchange/reference/pool/service-http';
import { ADMIN, CONFIG, IdealVerifier, OPERATOR_SECRET, TERMS, VENUE, WALLET } from './fixture.mjs';

const [database, ledgerFile, fault] = process.argv.slice(2);
if (!database || !ledgerFile || !process.send || !['none', 'drop-commit'].includes(fault)) throw new Error('invalid acceptance worker arguments');
// A known local ledger fixture, restored from publication output, never inferred
// from the operator journal. This is not an authenticated external venue adapter.
const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : [];
const venue = new LocalVenue(VENUE);
for (const entry of ledger) venue.publish(decodeCommitment(hexToBytes(entry)));
const publish = venue.publish.bind(venue);
venue.publish = commitment => {
  const result = publish(commitment);
  ledger.push(bytesToHex(encodeCommitment(commitment)));
  writeFileSync(ledgerFile, JSON.stringify(ledger));
  return result;
};
const store = new PoolStore(database, CONFIG, OPERATOR_SECRET, venue, new IdealVerifier());
if ((await store.view()).latest === undefined) {
  await store.activate('opening', [TERMS]);
  await store.publish();
}
const server = createPoolService(store, { walletToken: WALLET, adminToken: ADMIN });
let dropped = false;
server.prependListener('request', (_request, response) => {
  const end = response.end;
  response.end = function (chunk, ...args) {
    if (fault === 'drop-commit' && !dropped && typeof chunk === 'string') {
      const reply = JSON.parse(chunk);
      if (response.statusCode === 200 && reply.kind === 'committed') {
        dropped = true;
        // The service has completed store.commit before calling response.end.
        // Retain the exact original response for comparison, then lose the wire reply.
        process.send({ kind: 'dropped', body: chunk });
        response.destroy();
        return this;
      }
    }
    return end.call(this, chunk, ...args);
  };
});
await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
process.send({ kind: 'ready', pid: process.pid, baseUrl: `http://127.0.0.1:${server.address().port}/`, restoredPublications: ledger.length });
process.on('message', message => {
  if (message?.kind !== 'stop') return;
  server.close(error => {
    store.close();
    if (error) throw error;
    process.disconnect();
  });
  server.closeAllConnections();
});
process.on('disconnect', () => {
  server.closeAllConnections();
  server.close();
  store.close();
});

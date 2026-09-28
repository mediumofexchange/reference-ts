// Synthetic acceptance worker. Fault injection is outside the runtime service.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { NoteTree } from '../../../dist/pool/note-tree.js';
import { prepareExactOutput } from '../../../dist/pool/v3/capsules.js';
import { encodeRecord } from '../../../dist/pool/v3/records.js';
import { createV3Service } from '../../../dist/pool/v3/service-http.js';
import { V3OperatorJournal } from '../../../dist/pool/v3/store.js';
import { rootTermsSignatureMessage } from '../../../dist/pool/v3/terms.js';
import { authorizeIssue, issueTask, spendTask } from '../../../dist/pool/v3/witness.js';
import { FixtureVenue } from '../../../dist/record-venue.js';
import { ADMIN, WALLET, backing, configuration, domain, fill, load, operator, reference, save, terms, verifier } from './service-fixture.mjs';

const [directory, fault] = process.argv.slice(2);
if (!directory || !process.send || !['none', 'drop-commit'].includes(fault)) throw new Error('invalid acceptance worker arguments');
const issuerSecret = fill(15), operatorSecret = fill(16), ledgerFile = join(directory, 'venue.v8');
// Restore the separately saved venue ledger, never derive it from the journal.
const restored = existsSync(ledgerFile);
const venue = restored ? FixtureVenue.from(load(ledgerFile)) : FixtureVenue.reference(reference.label, reference.lag);
const restoredPublications = venue.export().records.length;
const publish = venue.publishRecord.bind(venue);
venue.publishRecord = async (...args) => { await publish(...args); save(ledgerFile, venue.export()); };
const journal = new V3OperatorJournal(join(directory, 'journal.sqlite'), { configuration, venue, reference, verifier, secret: operatorSecret });
if (!restored) {
  const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
  const header = { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] };
  const context = { domain, header }, request = load(join(directory, 'request.v8'));
  const out = (id, value) => prepareExactOutput(fill(21), domain, fill(id), backing, value);
  const record = task => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
    proof: fill(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
  const funded = out(31, 10n), pad = out(32, 0n), tree = new NoteTree(); tree.append(funded.cm);
  const input = { note: funded, anchor: tree.root(), path: tree.path(0n) };
  // Files consumed by the separate client contain only signed terms and public
  // records: no issuer/operator secret, funding note opening or receiver seed.
  save(join(directory, 'public.v8'), { signed,
    issue: encodeRecord(authorizeIssue(record(issueTask(context, funded)), issuerSecret)),
    payment: encodeRecord(record(spendTask(context, [input, { ...input, note: pad }],
      [out(33, 1n), request, out(34, 2n), out(35, 0n)]))),
    tail: encodeRecord(authorizeIssue(record(issueTask(context, out(36, 5n))), issuerSecret)) });
  await journal.open('genesis', signed); await journal.publish();
}
const server = createV3Service(journal, { walletToken: WALLET, adminToken: ADMIN });
let dropped = false, stopping = false;
server.prependListener('request', (_request, response) => {
  const end = response.end;
  response.end = function (chunk, ...args) {
    if (fault === 'drop-commit' && !dropped && typeof chunk === 'string') {
      const reply = JSON.parse(chunk);
      if (response.statusCode === 200 && reply.kind === 'committed') {
        dropped = true;
        process.send({ kind: 'dropped', body: chunk });
        response.destroy(); return this;
      }
    }
    return end.call(this, chunk, ...args);
  };
});
await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
process.send({ kind: 'ready', pid: process.pid, baseUrl: `http://127.0.0.1:${server.address().port}/`, restoredPublications });
const stop = () => {
  if (stopping) return; stopping = true;
  server.close(error => { journal.close(); if (error) throw error; if (process.connected) process.disconnect(); });
  server.closeAllConnections();
};
process.on('message', message => { if (message?.kind === 'stop') stop(); });
process.on('disconnect', stop);

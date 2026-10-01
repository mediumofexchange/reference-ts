// C2.10.9 and C2.8.2 process-restart acceptance for the v3 operator journal:
// an abrupt exit before and after the COMMIT of an opening, an admission and a
// checkpoint, then a fresh process's exact retry, publication from the outbox
// and a monotonic signed counter. Synthetic venue and proof oracle; abrupt
// exits exercise SQLite transaction boundaries, not power loss, physical
// custody, rollback resistance, real proofs or live venue operation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';

const { DatabaseSync } = await import('node:sqlite');
const { ed25519 } = await import('@noble/curves/ed25519.js');
const { NoteTree } = await import('../../../dist/pool/note-tree.js');
const { prepareExactOutput } = await import('../../../dist/pool/v3/capsules.js');
const { adoptedDomain } = await import('../../../dist/pool/v3/configuration.js');
const { encodeRecord } = await import('../../../dist/pool/v3/records.js');
const { V3OperatorJournal } = await import('../../../dist/pool/v3/store.js');
const { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } = await import('../../../dist/pool/v3/terms.js');
const { authorizeIssue, issueTask, spendTask } = await import('../../../dist/pool/v3/witness.js');
const { FixtureVenue, LOCAL_REFERENCE } = await import('../../../dist/record-venue.js');
const { decodeCommitment, encodeCommitment } = await import('../../../dist/venue-records.js');
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const script = fileURLToPath(import.meta.url), b = n => new Uint8Array(32).fill(n);
const domain = adoptedDomain(), issuerSecret = b(15), operatorSecret = b(16);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const reference = { context: LOCAL_REFERENCE, label: b(12), lag: 2n };
const verifier = { verify: (kind, _inputs, proof) => proof[0] === kind };
const save = (file, value) => writeFileSync(file, serialize(value));
const load = file => deserialize(readFileSync(file));
const record = task => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: b(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const events = db => Number(db.prepare('SELECT COUNT(*) AS n FROM events').get().n);

function statements(backing) {
  const context = { domain, header: { domain, venue: undefined, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
  const out = (id, value) => prepareExactOutput(b(21), domain, b(id), backing, value);
  return venueId => {
    context.header.venue = venueId;
    const funded = out(31, 10n), pad = out(32, 0n), tree = new NoteTree(); tree.append(funded.cm);
    const input = { note: funded, anchor: tree.root(), path: tree.path(0n) };
    return { issue: encodeRecord(authorizeIssue(record(issueTask(context, funded)), issuerSecret)),
      payment: encodeRecord(record(spendTask(context, [input, { ...input, note: pad }], [out(33, 7n), out(34, 1n), out(35, 2n), out(36, 0n)]))) };
  };
}

async function worker(directory, operation, phase, action) {
  const path = join(directory, `${operation}-${phase}.sqlite`), fixturePath = `${path}.fixture`;
  if (action === 'setup') {
    const venue = FixtureVenue.reference(reference.label, reference.lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, replacementRule: issuer, configuration: domain, venue: venue.id, interval: 20n,
      payout: { thing: 'crash fixture units', quantumExponent: 0, perUnit: 1n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
    // The opening crashes in a journal with no events yet; the others after it was published.
    if (operation !== 'open') {
      const journal = new V3OperatorJournal(path, { venue, reference, verifier, secret: operatorSecret });
      try {
        await journal.open('genesis', signed); await journal.publish();
        if (operation === 'commit') await journal.submit(statements(rootTermsName(terms))(venue.id).issue);
      } finally { journal.close(); }
    }
    save(fixturePath, { signed, venue: venue.export() }); return;
  }
  // The venue as the previous process left it: a journal refuses a clock behind what it observed.
  const fixture = load(fixturePath), venuePath = `${path}.venue`;
  const venue = FixtureVenue.from(existsSync(venuePath) ? load(venuePath) : fixture.venue);
  const records = statements(rootTermsName(fixture.signed.terms))(venue.id);
  const journal = new V3OperatorJournal(path, { venue, reference, verifier, secret: operatorSecret });
  // A reopened journal waits the lag before it signs or admits again (C2.8.2).
  venue.advance(venue.witnessedIndex() + reference.lag); save(venuePath, venue.export());
  const act = () => operation === 'open' ? journal.open('genesis', fixture.signed)
    : operation === 'submit' ? journal.submit(records.issue) : journal.commit('c2');
  if (action === 'crash') {
    // Arm only the COMMIT of the transaction that appends this operation's
    // journal event; the deliberate exit leaves the handle open, without rollback or close.
    const db = new DatabaseSync(path), before = events(db); db.close();
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql.trim().toUpperCase() !== 'COMMIT' || events(this) === before) return original.call(this, sql);
      if (phase === 'before') process.exit(71);
      original.call(this, sql);
      process.exit(72);
    };
    await act();
    assert.fail('operation did not reach its crash boundary');
  }
  try {
    const first = await act();
    const result = { first: operation === 'submit' ? first : encodeCommitment(first) };
    if (operation !== 'submit') {
      // The outbox publishes the exact signed bytes; the next checkpoint takes the next sequence.
      await journal.publish();
      assert.ok(venue.export().records.some(r => r.kind === 1 && Buffer.from(r.record).equals(Buffer.from(result.first))),
        'the outbox publishes the exact signed commitment');
      if (operation === 'commit') {
        await journal.submit(records.payment);
        result.next = decodeCommitment(encodeCommitment(await journal.commit('c3'))).sequence;
      }
    }
    save(venuePath, venue.export()); save(`${path}.${action}`, result);
  } finally { journal.close(); }
}

if (process.argv[2] === '--worker') {
  await worker(...process.argv.slice(3));
} else {
  const scratchPath = join(root, 'scratch'); mkdirSync(scratchPath, { recursive: true });
  assert.equal(realpathSync(scratchPath), scratchPath, 'scratch must not be redirected');
  const scratch = realpathSync(scratchPath), directory = realpathSync(mkdtempSync(join(scratch, 'v3-journal-crash-')));
  const runFile = promisify(execFile);
  const run = async (operation, phase, action) => {
    const expected = action === 'crash' ? (phase === 'before' ? 71 : 72) : 0;
    try {
      await runFile(process.execPath, [script, '--worker', directory, operation, phase, action],
        { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
      assert.equal(expected, 0, 'worker must reach deliberate exit');
    } catch (error) {
      if (expected === 0) throw error;
      assert.equal(error.code, expected, `${operation}/${phase}/${action}: ${error.stderr ?? error.message}`);
      assert.equal(error.killed, false, 'worker must exit at COMMIT, not time out');
    }
  };
  try {
    const firsts = {};
    for (const operation of ['open', 'submit', 'commit']) for (const phase of ['before', 'after']) {
      const path = join(directory, `${operation}-${phase}.sqlite`);
      await run(operation, phase, 'setup');
      const setupEvents = operation === 'open' ? 0 : (() => { const db = new DatabaseSync(path); try { return events(db); } finally { db.close(); } })();
      await run(operation, phase, 'crash');
      const db = new DatabaseSync(path);
      try { assert.equal(events(db), setupEvents + (phase === 'before' ? 0 : 1), `${operation}/${phase}: rollback before COMMIT, persistence after`); }
      finally { db.close(); }
      await run(operation, phase, 'restore'); await run(operation, phase, 'retry');
      const restored = load(`${path}.restore`);
      assert.deepEqual(load(`${path}.retry`), restored, 'a fresh process must reproduce the exact saved reply');
      // Signatures are deterministic: a rolled-back command re-signs the same bytes it would have kept.
      firsts[operation] ??= restored.first;
      assert.deepEqual(restored.first, firsts[operation], `${operation}: the same reply before and after COMMIT`);
      if (operation === 'open') assert.equal(decodeCommitment(restored.first).sequence, 1n);
      if (operation === 'commit') { assert.equal(decodeCommitment(restored.first).sequence, 2n); assert.equal(restored.next, 3n); }
      console.log(`PASS v3 journal ${operation}/${phase}: abrupt COMMIT exit, exact restart and retry.`);
    }
    console.log('V3 journal crash check passed: six abrupt exits; synthetic process evidence only.');
  } finally {
    const target = realpathSync(directory);
    assert.ok(dirname(target) === scratch && target.startsWith(scratch + sep) && target.startsWith(join(scratch, 'v3-journal-crash-')),
      'refusing cleanup outside this crash-check directory');
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// C4.2/5 and pool-fees C1.2.5 process-restart acceptance (request, fulfillment,
// payment, receipt, reproof, offline export and restore, and a read's commits to its evidence and
// kept replay files) with a synthetic venue and proof oracle.
// Abrupt process exits exercise SQLite transaction boundaries, not power loss,
// physical custody, rollback resistance, real proofs or live venue operation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';

const { DatabaseSync } = await import('node:sqlite');
const { ed25519 } = await import('@noble/curves/ed25519.js');
const { NoteTree } = await import('../../../dist/pool/note-tree.js');
const { prepareExactOutput } = await import('../../../dist/pool/v3/capsules.js');
const { adoptedConfiguration, adoptedDomain } = await import('../../../dist/pool/v3/configuration.js');
const { encodeRecord } = await import('../../../dist/pool/v3/records.js');
const { decodeReceipt } = await import('../../../dist/pool/v3/commitments.js');
const { V3OperatorJournal } = await import('../../../dist/pool/v3/store.js');
const { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } = await import('../../../dist/pool/v3/terms.js');
const { V3Wallet } = await import('../../../dist/pool/v3/wallet-store.js');
const { walletBackupDigest } = await import('../../../dist/pool/v3/wallet-backup.js');
const { authorizeIssue, issueTask, spendTask } = await import('../../../dist/pool/v3/witness.js');
const { FixtureVenue, LOCAL_REFERENCE } = await import('../../../dist/record-venue.js');
const { encodeCommitment, encodeReplacement, replacementMessage } = await import('../../../dist/venue-records.js');
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const script = fileURLToPath(import.meta.url), b = n => new Uint8Array(32).fill(n);
const configuration = adoptedConfiguration(), domain = adoptedDomain(), issuerSecret = b(15), operatorSecret = b(16), successorSecret = b(18);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const reference = { context: LOCAL_REFERENCE, label: b(12), lag: 2n };
const verifier = { verify: (kind, _inputs, proof) => proof[0] === kind };
// The wallet's verifier declares its circuits, so its reads keep their state in a file beside its database.
const declared = { ...verifier, identities: configuration.circuits };
const save = (file, value) => writeFileSync(file, serialize(value));
const load = file => deserialize(readFileSync(file));
const publicRequest = out => ({ domain, opening: out.opening, cm: out.cm, capsule: out.capsule });
const record = task => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: b(task.kind), authorization: new Uint8Array(), capsules: task.capsules });

const prove = async task => record(task);
const backupKey = b(83); // public fixture key, never funds
const order = fixture => ({ request: fixture.payee, value: 7n });

async function worker(directory, operation, phase, action) {
  const path = join(directory, `${operation}-${phase}.sqlite`), fixturePath = `${path}.fixture`;
  if (action === 'setup') {
    const venue = FixtureVenue.reference(reference.label, reference.lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, replacementRule: issuer, configuration: domain, venue: venue.id, interval: 20n,
      payout: { thing: 'crash fixture units', quantumExponent: 0, perUnit: 1n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
    const backing = rootTermsName(terms), wallet = new V3Wallet(path, { venue, reference, verifier: declared });
    const fixture = { backing, signed, venue: venue.export() };
    if (operation === 'export' || operation === 'import') {
      fixture.request = wallet.request('invoice', backing, 7n);
      if (operation === 'import') { fixture.backup = wallet.exportBackup(backupKey); fixture.digest = walletBackupDigest(fixture.backup); }
    } else if (operation !== 'request') {
      const journal = new V3OperatorJournal(`${path}.journal`, { venue, reference, verifier, secret: operatorSecret });
      try {
        await journal.open('genesis', signed); await journal.publish();
        const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
        const out = (id, value) => prepareExactOutput(b(21), domain, b(id), backing, value);
        if (operation === 'fulfillment') {
          fixture.request = wallet.request('invoice', backing, 7n);
          const funded = out(31, 10n), pad = out(32, 0n), tree = new NoteTree(); tree.append(funded.cm);
          await journal.submit(encodeRecord(authorizeIssue(record(issueTask(context, funded)), issuerSecret)));
          const input = { note: funded, anchor: tree.root(), path: tree.path(0n) };
          await journal.submit(encodeRecord(record(spendTask(context, [input, { ...input, note: pad }],
            [out(33, 1n), fixture.request, out(34, 2n), out(35, 0n)]))));
        } else {
          // The wallet pays from its own issued note; the payee's request is public bytes only.
          await journal.submit(encodeRecord(authorizeIssue(record(issueTask(context, wallet.request('fund', backing, 10n))), issuerSecret)));
          fixture.payee = publicRequest(out(40, 7n));
        }
        fixture.checkpoint = await journal.commit('payment'); await journal.publish();
        fixture.package = (await journal.package()).package;
        if (operation === 'reproof') {
          // The payment is saved in A's segment; B takes over from A's package, which lacks it.
          fixture.prepared = (await wallet.prepare('shop', order(fixture), fixture.package, signed, prove)).record;
          const effective = venue.witnessedIndex() + 2n * reference.lag + 2n, successorKey = ed25519.getPublicKey(successorSecret);
          const unsigned = { role: 1, successor: successorKey, predecessor: backing, effective,
            signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
          const message = replacementMessage(backing, unsigned);
          await venue.publishRecord(2, backing, encodeReplacement(backing,
            { ...unsigned, signature: ed25519.sign(message, issuerSecret), successorSignature: ed25519.sign(message, successorSecret) }));
          venue.advance(effective);
          const successor = new V3OperatorJournal(`${path}.successor`, { venue, reference, verifier, secret: successorSecret });
          try {
            await successor.takeover('takeover', signed, fixture.package); await successor.publish(); await successor.adopt();
            fixture.package = (await successor.package()).package;
          } finally { successor.close(); }
        }
        if (operation === 'receipt') {
          // The operator admitted the saved record; its reply to the wallet is what the crash loses.
          fixture.receipt = await journal.submit((await wallet.prepare('shop', order(fixture), fixture.package, signed, prove)).record);
        }
        if (operation === 'read') {
          // The wallet reads the first checkpoint and keeps it; the crash interrupts its read of the second.
          await wallet.sync(fixture.package, signed);
          await journal.submit(encodeRecord(authorizeIssue(record(issueTask(context, wallet.request('more', backing, 5n))), issuerSecret)));
          fixture.checkpoint = await journal.commit('more'); await journal.publish();
          fixture.package = (await journal.package()).package;
        }
        fixture.venue = venue.export();
      } finally { journal.close(); }
    }
    wallet.close(); save(fixturePath, fixture); return;
  }
  // What this process's reads verify: kept state that stands is not verified again.
  let verified = 0;
  const counted = { identities: declared.identities, verify: (...args) => { verified++; return verifier.verify(...args); } };
  const fixture = load(fixturePath), venue = FixtureVenue.from(fixture.venue), reader = { venue, reference, verifier: counted };
  const wallet = new V3Wallet(path, reader);
  if (action === 'crash') {
    // Initialization has committed. Arm only the operation's own COMMIT; the
    // deliberate exit leaves its DB handle open, without rollback or close. The wallet's
    // evidence and kept replay files commit before it; only the wallet's database (or the
    // restore's staging file) is armed. A read arms one of those two files instead: the evidence
    // file's first COMMIT (the package's import) or the replay file's (its walk closing), which
    // its digest follows.
    const original = DatabaseSync.prototype.exec;
    const armed = operation !== 'read' ? location => !/.(evidence|replay)$/.test(location) :
      location => location.endsWith(phase === 'evidence' ? '.evidence' : '.replay');
    DatabaseSync.prototype.exec = function (sql) {
      if (sql.trim().toUpperCase() !== 'COMMIT' || !this.location() || !armed(this.location())) return original.call(this, sql);
      if (operation === 'request') {
        const row = this.prepare('SELECT * FROM receiver_requests WHERE alias=?').get('invoice');
        const seed = this.prepare('SELECT seed FROM wallet_identity WHERE id=1').get().seed;
        // Capture public candidate bytes only; the fixture never exports seed
        // or request randomness. Before-COMMIT candidate must not survive.
        save(`${path}.candidate`, publicRequest(prepareExactOutput(seed, domain, row.request_id, row.backing, BigInt(row.value))));
      }
      // The candidate record is public bytes; before COMMIT it must not survive.
      if (operation === 'payment' || operation === 'reproof') {
        save(`${path}.candidate`, this.prepare('SELECT record FROM payer_payments WHERE alias=?').get('shop').record);
      }
      // The encrypted export commits with the source's freeze; before COMMIT neither survives.
      if (operation === 'export') save(`${path}.candidate`, this.prepare('SELECT export FROM wallet_custody WHERE id=1').get().export);
      if (phase !== 'after' && phase !== 'digest') process.exit(71);
      original.call(this, sql);
      process.exit(72);
    };
    if (operation === 'request') wallet.request('invoice', fixture.backing, 7n);
    else if (operation === 'payment') await wallet.prepare('shop', order(fixture), fixture.package, fixture.signed, prove);
    else if (operation === 'reproof') await wallet.reprove('shop', fixture.package, fixture.signed, prove);
    else if (operation === 'receipt') await wallet.submit('shop', { submit: async () => decodeReceipt(fixture.receipt) });
    else if (operation === 'export') wallet.exportBackup(backupKey);
    // The restore's one COMMIT installs identity, state and provenance together in its staging file.
    else if (operation === 'import') V3Wallet.restoreBackup(`${path}.restored`, reader, fixture.backup, backupKey, fixture.digest);
    else if (operation === 'read') await wallet.sync(fixture.package, fixture.signed);
    else await wallet.fulfill('invoice', fixture.package, fixture.signed);
    assert.fail('operation did not reach its crash boundary');
  }
  try {
    if (operation === 'request') save(`${path}.${action}`, wallet.request('invoice', fixture.backing, 7n));
    else if (operation === 'read') {
      const view = await wallet.sync(fixture.package, fixture.signed);
      save(`${path}.${action}`, { checkpoint: view.checkpoint, holdings: view.holdings.map(h => [h.value, h.status]).sort(([a], [c]) => Number(a - c)), verified });
    } else if (operation === 'export') {
      // A lost export reply retries the exact committed bytes; an uncommitted export froze nothing.
      assert.equal(wallet.custody().frozen, !(action === 'restore' && phase === 'before'));
      save(`${path}.${action}`, wallet.exportBackup(backupKey));
    } else if (operation === 'import') {
      // An interrupted restore leaves nothing at the destination, so it is retried
      // there; once it exists, custody's provenance confirms a lost reply.
      const target = `${path}.restored`;
      assert.equal(existsSync(target), action === 'retry');
      const restored = existsSync(target) ? new V3Wallet(target, reader) : V3Wallet.restoreBackup(target, reader, fixture.backup, backupKey, fixture.digest);
      try {
        assert.deepEqual(restored.custody(), { frozen: false, restoredFrom: fixture.digest });
        save(`${path}.${action}`, restored.request('invoice', fixture.backing, 7n));
      } finally { restored.close(); }
    } else if (operation === 'payment') {
      const prior = wallet.payment('shop');
      if (action === 'restore' && phase === 'before') {
        assert.equal(prior, undefined, 'an uncommitted payment reserves nothing');
        save(`${path}.${action}`, await wallet.prepare('shop', order(fixture), fixture.package, fixture.signed, prove));
      } else {
        assert.ok(prior, 'committed payment must survive a lost reply');
        save(`${path}.${action}`, prior);
        // An exact alias retry reads the saved record without evidence or proving.
        assert.deepEqual(await wallet.prepare('shop', order(fixture), new Uint8Array(), fixture.signed, undefined), prior);
      }
    } else if (operation === 'reproof') {
      // An uncommitted reproof leaves the original record; a committed one is returned as saved.
      const prior = wallet.payment('shop');
      if (action === 'restore' && phase === 'before') assert.deepEqual(prior.record, fixture.prepared);
      else assert.notDeepEqual(prior.record, fixture.prepared, 'committed reproof must survive a lost reply');
      save(`${path}.${action}`, await wallet.reprove('shop', fixture.package, fixture.signed, prove));
    } else if (operation === 'receipt') {
      // An uncommitted receipt is asked for again (the operator answers an exact retry
      // with its original reply); a committed one is returned without asking.
      const prior = wallet.payment('shop'), uncommitted = action === 'restore' && phase === 'before';
      assert.equal(prior.receipt === undefined, uncommitted);
      save(`${path}.${action}`, await wallet.submit('shop', { submit: async () => {
        assert.ok(uncommitted, 'a saved receipt must not be asked for again'); return decodeReceipt(fixture.receipt);
      } }));
    } else {
      const prior = wallet.fulfillment('invoice');
      if (action === 'restore' && phase === 'before') {
        assert.equal(prior, undefined);
        save(`${path}.${action}`, await wallet.fulfill('invoice', fixture.package, fixture.signed));
      } else {
        assert.ok(prior, 'committed fulfillment must survive a lost reply');
        save(`${path}.${action}`, prior);
        await assert.rejects(wallet.fulfill('invoice', fixture.package, fixture.signed), { code: 'CONFLICT' });
      }
    }
  } finally { wallet.close(); }
}

if (process.argv[2] === '--worker') {
  await worker(...process.argv.slice(3));
} else {
  const scratchPath = join(root, 'scratch'); mkdirSync(scratchPath, { recursive: true });
  assert.equal(realpathSync(scratchPath), scratchPath, 'scratch must not be redirected');
  const scratch = realpathSync(scratchPath), directory = realpathSync(mkdtempSync(join(scratch, 'v3-wallet-crash-')));
  const runFile = promisify(execFile);
  const run = async (operation, phase, action) => {
    const expected = action === 'crash' ? (phase === 'after' || phase === 'digest' ? 72 : 71) : 0;
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
    for (const operation of ['request', 'fulfillment', 'payment', 'receipt', 'reproof', 'export', 'import']) for (const phase of ['before', 'after']) {
      const path = join(directory, `${operation}-${phase}.sqlite`);
      await run(operation, phase, 'setup'); await run(operation, phase, 'crash');
      const staged = operation === 'import' ? readdirSync(directory).filter(name => name.startsWith(`${operation}-${phase}.sqlite.restored.restore-`) && !/-(wal|shm)$/.test(name)) : [];
      if (operation === 'import') {
        // Only the staging file, never the destination, survives a crash; it holds plaintext state.
        assert.equal(existsSync(`${path}.restored`), false); assert.equal(staged.length, 1);
      }
      const fixture = load(`${path}.fixture`), db = new DatabaseSync(operation === 'import' ? join(directory, staged[0]) : path);
      try {
        if (operation === 'export') {
          assert.equal(db.prepare('SELECT export IS NOT NULL AS frozen FROM wallet_custody').get().frozen, phase === 'before' ? 0 : 1);
        }
        if (operation === 'import') {
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='wallet_identity'").get().n, phase === 'before' ? 0 : 1);
        }
        const tables = { request: ['receiver_requests'], fulfillment: ['receiver_fulfilled'], payment: ['payer_payments', 'payer_inputs'],
          receipt: [], reproof: ['payer_superseded'], export: [], import: [] };
        for (const table of tables[operation]) {
          assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, phase === 'before' ? 0 : 1);
        }
        if (operation === 'receipt') {
          assert.equal(db.prepare('SELECT receipt IS NOT NULL AS saved FROM payer_payments').get().saved, phase === 'before' ? 0 : 1);
        }
        if (operation === 'fulfillment' && phase === 'after') {
          const row = db.prepare('SELECT * FROM receiver_fulfilled').get();
          assert.deepEqual(row.checkpoint, encodeCommitment(fixture.checkpoint));
          assert.deepEqual(row.terms, fixture.signed.terms); assert.deepEqual(row.signature, fixture.signed.signature);
          assert.equal(row.judging_index, fixture.venue.witnessedIndex.toString());
        }
      } finally { db.close(); }
      await run(operation, phase, 'restore'); await run(operation, phase, 'retry');
      const restored = load(`${path}.restore`);
      assert.deepEqual(load(`${path}.retry`), restored, 'fresh process must reproduce exact saved result');
      if (operation === 'request') {
        if (phase === 'after') assert.deepEqual(restored, load(`${path}.candidate`));
        else assert.notEqual(restored.cm, load(`${path}.candidate`).cm, 'uncommitted candidate must not be reused');
      } else if (operation === 'payment') {
        assert.equal(restored.status, 'prepared'); assert.equal(restored.payee, fixture.payee.cm);
        if (phase === 'after') assert.deepEqual(restored.record, load(`${path}.candidate`));
        else assert.notDeepEqual(restored.record, load(`${path}.candidate`), 'uncommitted candidate must not be reused');
      } else if (operation === 'reproof') {
        // The same inputs, outputs and canonical view reprove to the same stand-in record.
        assert.equal(restored.status, 'prepared'); assert.deepEqual(restored.record, load(`${path}.candidate`));
        assert.deepEqual(restored.superseded.map(old => old.record), [fixture.prepared]);
      } else if (operation === 'export') {
        if (phase === 'after') assert.deepEqual(restored, load(`${path}.candidate`));
        else assert.notDeepEqual(restored, load(`${path}.candidate`), 'uncommitted export must not be reused');
      } else if (operation === 'receipt') assert.deepEqual(restored, decodeReceipt(fixture.receipt));
      else if (operation === 'import') assert.deepEqual(restored, fixture.request);
      else assert.deepEqual(restored, { request: fixture.request, checkpoint: fixture.checkpoint,
        judgingIndex: fixture.venue.witnessedIndex, terms: fixture.signed });
      console.log(`PASS v3 wallet ${operation}/${phase}: abrupt COMMIT exit, exact restart and retry.`);
    }
    // A read commits its evidence file, then its kept replay file, then that file's digest (storage decision
    // item 6). Exiting before either commit leaves the first checkpoint's kept state standing, so the next
    // read verifies the new record only; exiting between the replay commit and its digest leaves a file its
    // digest does not name, which is discarded and replayed in full. Every case reads the same view.
    for (const phase of ['evidence', 'replay', 'digest']) {
      const path = join(directory, `read-${phase}.sqlite`);
      await run('read', phase, 'setup');
      const digest = readFileSync(`${path}.replay.sha256`, 'utf8');
      await run('read', phase, 'crash');
      assert.equal(readFileSync(`${path}.replay.sha256`, 'utf8'), digest, 'no crash point records a new digest');
      await run('read', phase, 'restore'); await run('read', phase, 'retry');
      const fixture = load(`${path}.fixture`), restored = load(`${path}.restore`);
      assert.deepEqual(restored, { checkpoint: fixture.checkpoint, holdings: [[5n, 'available'], [10n, 'available']], verified: phase === 'digest' ? 2 : 1 });
      assert.deepEqual(load(`${path}.retry`), { ...restored, verified: 0 }, 'a later process reads the kept state and verifies nothing');
      console.log(`PASS v3 wallet read/${phase}: abrupt exit at the ${phase === 'evidence' ? 'evidence' : 'replay'} file's COMMIT, same view after restart.`);
    }
    console.log('V3 wallet crash check passed: seventeen abrupt exits; synthetic process evidence only.');
  } finally {
    const target = realpathSync(directory);
    assert.ok(dirname(target) === scratch && target.startsWith(scratch + sep) && target.startsWith(join(scratch, 'v3-wallet-crash-')),
      'refusing cleanup outside this crash-check directory');
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

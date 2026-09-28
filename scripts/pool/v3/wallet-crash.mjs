// C4.2/5 and pool-fees C1.2.5 process-restart acceptance with a synthetic venue and proof oracle.
// Abrupt process exits exercise SQLite transaction boundaries, not power loss,
// physical custody, rollback resistance, real proofs or live venue operation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.log('SKIP v3 wallet crash check: Node.js 24 or newer is required.');
  process.exit(0);
}
const { DatabaseSync } = await import('node:sqlite');
const { ed25519 } = await import('@noble/curves/ed25519.js');
const { hexToBytes } = await import('@noble/hashes/utils.js');
const { NoteTree } = await import('../../../dist/pool/note-tree.js');
const { prepareExactOutput } = await import('../../../dist/pool/v3/capsules.js');
const { configurationHash, RELATIONS } = await import('../../../dist/pool/v3/configuration.js');
const { encodeRecord } = await import('../../../dist/pool/v3/records.js');
const { V3OperatorJournal } = await import('../../../dist/pool/v3/store.js');
const { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } = await import('../../../dist/pool/v3/terms.js');
const { V3Wallet } = await import('../../../dist/pool/v3/wallet-store.js');
const { authorizeIssue, issueTask, spendTask } = await import('../../../dist/pool/v3/witness.js');
const { FixtureVenue, LOCAL_REFERENCE } = await import('../../../dist/record-venue.js');
const { encodeCommitment } = await import('../../../dist/venue-records.js');
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const script = fileURLToPath(import.meta.url), b = n => new Uint8Array(32).fill(n);
const configuration = { helper: hexToBytes('44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8'),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) };
const domain = configurationHash(configuration), issuerSecret = b(15), operatorSecret = b(16);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const reference = { context: LOCAL_REFERENCE, label: b(12), lag: 2n };
const verifier = { verify: (kind, _inputs, proof) => proof[0] === kind };
const save = (file, value) => writeFileSync(file, serialize(value));
const load = file => deserialize(readFileSync(file));
const publicRequest = out => ({ domain, opening: out.opening, cm: out.cm, capsule: out.capsule });
const record = task => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: b(task.kind), authorization: new Uint8Array(), capsules: task.capsules });

const prove = async task => record(task);
const order = fixture => ({ request: fixture.payee, value: 7n });

async function worker(directory, operation, phase, action) {
  const path = join(directory, `${operation}-${phase}.sqlite`), fixturePath = `${path}.fixture`;
  if (action === 'setup') {
    const venue = FixtureVenue.reference(reference.label, reference.lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: 20n,
      payout: { thing: 'crash fixture units', quantumExponent: 0, perUnit: 1n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
    const backing = rootTermsName(terms), wallet = new V3Wallet(path, { configuration, venue, reference, verifier });
    const fixture = { backing, signed, venue: venue.export() };
    if (operation !== 'request') {
      const journal = new V3OperatorJournal(`${path}.journal`, { configuration, venue, reference, verifier, secret: operatorSecret });
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
        fixture.venue = venue.export();
      } finally { journal.close(); }
    }
    wallet.close(); save(fixturePath, fixture); return;
  }
  const fixture = load(fixturePath), venue = FixtureVenue.from(fixture.venue);
  const wallet = new V3Wallet(path, { configuration, venue, reference, verifier });
  if (action === 'crash') {
    // Initialization has committed. Arm only the operation's own COMMIT; the
    // deliberate exit leaves its DB handle open, without rollback or close.
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql.trim().toUpperCase() !== 'COMMIT') return original.call(this, sql);
      if (operation === 'request') {
        const row = this.prepare('SELECT * FROM receiver_requests WHERE alias=?').get('invoice');
        const seed = this.prepare('SELECT seed FROM wallet_identity WHERE id=1').get().seed;
        // Capture public candidate bytes only; the fixture never exports seed
        // or request randomness. Before-COMMIT candidate must not survive.
        save(`${path}.candidate`, publicRequest(prepareExactOutput(seed, domain, row.request_id, row.backing, BigInt(row.value))));
      }
      // The candidate record is public bytes; before COMMIT it must not survive.
      if (operation === 'payment') save(`${path}.candidate`, this.prepare('SELECT record FROM payer_payments WHERE alias=?').get('shop').record);
      if (phase === 'before') process.exit(71);
      original.call(this, sql);
      process.exit(72);
    };
    if (operation === 'request') wallet.request('invoice', fixture.backing, 7n);
    else if (operation === 'payment') await wallet.prepare('shop', order(fixture), fixture.package, fixture.signed, prove);
    else await wallet.fulfill('invoice', fixture.package, fixture.signed);
    assert.fail('operation did not reach its crash boundary');
  }
  try {
    if (operation === 'request') save(`${path}.${action}`, wallet.request('invoice', fixture.backing, 7n));
    else if (operation === 'payment') {
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
    for (const operation of ['request', 'fulfillment', 'payment']) for (const phase of ['before', 'after']) {
      const path = join(directory, `${operation}-${phase}.sqlite`);
      await run(operation, phase, 'setup'); await run(operation, phase, 'crash');
      const fixture = load(`${path}.fixture`), db = new DatabaseSync(path);
      try {
        const tables = { request: ['receiver_requests'], fulfillment: ['receiver_fulfilled'], payment: ['payer_payments', 'payer_inputs'] };
        for (const table of tables[operation]) {
          assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, phase === 'before' ? 0 : 1);
        }
        if (operation === 'fulfillment' && phase === 'after') {
          const row = db.prepare('SELECT * FROM receiver_fulfilled').get();
          assert.deepEqual(row.package, fixture.package);
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
      } else assert.deepEqual(restored, { request: fixture.request, checkpoint: fixture.checkpoint,
        judgingIndex: fixture.venue.witnessedIndex, package: fixture.package, terms: fixture.signed });
      console.log(`PASS v3 wallet ${operation}/${phase}: abrupt COMMIT exit, exact restart and retry.`);
    }
    console.log('V3 wallet crash check passed: six abrupt exits; synthetic process evidence only.');
  } finally {
    const target = realpathSync(directory);
    assert.ok(dirname(target) === scratch && target.startsWith(scratch + sep) && target.startsWith(join(scratch, 'v3-wallet-crash-')),
      'refusing cleanup outside this crash-check directory');
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

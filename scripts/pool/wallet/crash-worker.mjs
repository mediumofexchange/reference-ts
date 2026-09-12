// Test-only COMMIT interception keeps crash callbacks out of the wallet API.
// No close/finally runs after process.exit. Expected private state is retained
// only in this harness's disposable local directory. Successful worker output
// contains only the operation and phase.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.log('SKIP pool wallet crash worker: Node.js 24 or newer is required.');
  process.exit(0);
}

const [operation, phase, file, action] = process.argv.slice(2);
if (!['request', 'pending', 'receipt', 'fulfillment', 'capability', 'credentials', 'invitation', 'pairing', 'inbox', 'export', 'import'].includes(operation) || !['before', 'after'].includes(phase) ||
  typeof file !== 'string' || !['crash', 'restore'].includes(action)) {
  console.error('usage: crash-worker.mjs <request|pending|receipt|fulfillment|capability|credentials|invitation|pairing|inbox|export|import> <before|after> <database> <crash|restore>');
  process.exit(2);
}

const [assertModule, fs, v8, sqlite, hashes, commitment, venueModule, walletModule, pairingModule, tlsModule, notes, treeModule, field, statement,
  segmentModule, receiptModule, codec, fixture] = await Promise.all([
  import('node:assert/strict'), import('node:fs'), import('node:v8'), import('node:sqlite'),
  import('@noble/hashes/sha2.js'), import('@mediumofexchange/reference/commitment'),
  import('@mediumofexchange/reference/venue'), import('@mediumofexchange/reference/pool/wallet-store'),
  import('@mediumofexchange/reference/pool/wallet-pairing'), import('./tls.mjs'),
  import('@mediumofexchange/reference/pool/notes'), import('@mediumofexchange/reference/pool/note-tree'),
  import('@mediumofexchange/reference/pool/field'), import('@mediumofexchange/reference/pool/statement'),
  import('@mediumofexchange/reference/pool/segment'), import('@mediumofexchange/reference/pool/receipt'),
  import('@mediumofexchange/reference/pool/store-codec'), import('../service/fixture.mjs'),
]);
const assert = assertModule.default;
const { AUTHORITY, DOMAIN, CONFIG, VENUE, OPERATOR, OPERATOR_SECRET, TERMS, IdealVerifier, issue } = fixture;
const { PoolWalletStore } = walletModule, backing = TERMS.backing.name;
let wallet = new PoolWalletStore(file, AUTHORITY);
const { walletBackupDigest } = await import('@mediumofexchange/reference/pool/wallet-backup');
const backupKey = new Uint8Array(32).fill(83); // public fixture key, never funds
const expectedFile = `${file}.expected`;
const endpoint = 'https://localhost/delivery/invoice';
const pairingAlias = 'receiver-invoice';
const frame = value => statement.encodeStatement(DOMAIN, value);
const copy = value => v8.deserialize(v8.serialize(value));

async function provisionPairing(expected) {
  expected.tls = await tlsModule.generateWalletTls();
  assert.equal(wallet.installDeliveryCredentials(expected.tls, 0n), 1n);
  expected.credentials = wallet.deliveryCredentials();
  expected.invitation = wallet.deliveryInvitation('invoice', endpoint);
  expected.pairingDigest = pairingModule.walletPairingDigest(expected.invitation);
  expected.token = pairingModule.decodeWalletPairing(expected.invitation).token;
  assert.equal(wallet.acceptPairing(pairingAlias, expected.invitation, expected.pairingDigest, expected.request), expected.pairingDigest);
}

async function baseline() {
  // The root already committed in construction. Predict the two counter
  // derivations before request() writes anything, to expose counter reuse.
  const secret = wallet.derive('request-secret', [1n]);
  const request = { id: 'invoice', backing, value: 7n, owner: notes.ownerOf(secret) };
  const expected = { request, secret, nextOwner: notes.ownerOf(wallet.derive('request-secret', [2n])) };
  if (operation === 'request') return expected;
  assert.deepEqual(wallet.request('invoice', backing, 7n), request);
  if (operation === 'capability') return expected;
  if (operation === 'credentials') {
    expected.oldTls = await tlsModule.generateWalletTls();
    assert.equal(wallet.installDeliveryCredentials(expected.oldTls, 0n), 1n);
    expected.oldCredentials = wallet.deliveryCredentials();
    expected.oldToken = wallet.deliveryToken('invoice');
    expected.newTls = await tlsModule.generateWalletTls();
    return expected;
  }
  if (operation === 'invitation') {
    expected.tls = await tlsModule.generateWalletTls();
    assert.equal(wallet.installDeliveryCredentials(expected.tls, 0n), 1n);
    expected.credentials = wallet.deliveryCredentials();
    expected.endpoint = endpoint;
    return expected;
  }
  if (operation === 'pairing') {
    expected.tls = await tlsModule.generateWalletTls();
    assert.equal(wallet.installDeliveryCredentials(expected.tls, 0n), 1n);
    expected.credentials = wallet.deliveryCredentials();
    expected.invitation = wallet.deliveryInvitation('invoice', endpoint);
    expected.pairingDigest = pairingModule.walletPairingDigest(expected.invitation);
    expected.token = pairingModule.decodeWalletPairing(expected.invitation).token;
    return expected;
  }
  const changeRequest = wallet.request('change', backing, 3n);
  const opening = { backing, value: 7n, owner: request.owner, rho: wallet.derive('output-rho', [11n]) };
  const change = { backing, value: 3n, owner: changeRequest.owner, rho: wallet.derive('output-rho', [11n], 1) };
  const input = { backing, value: 10n, owner: notes.ownerOf(99n), rho: 100n };
  const tree = new treeModule.NoteTree(); tree.appendAll([notes.commitmentOf(DOMAIN, input)]);
  const publicInputs = [...field.limbsOf(DOMAIN), ...field.limbsOf(AUTHORITY.segment), AUTHORITY.scopeRoot,
    tree.root(), tree.root(), 11n, 12n, notes.commitmentOf(DOMAIN, opening), notes.commitmentOf(DOMAIN, change)];
  const payment = { kind: statement.SPEND, publicInputs,
    proof: hashes.sha256(statement.statementBytes(DOMAIN, statement.SPEND, publicInputs)) };
  const segment = new segmentModule.Segment(CONFIG, { domain: DOMAIN, venue: VENUE, operator: OPERATOR,
    sequence: 1n, entries: [{ backing, link: backing }] }, [], new IdealVerifier());
  segment.register(TERMS.backing, TERMS.signature);
  await segment.admit(issue(notes.commitmentOf(DOMAIN, input)));
  const accepted = await segment.admit(payment);
  const receipt = receiptModule.signPoolReceipt(OPERATOR_SECRET, AUTHORITY, accepted, 0n);
  const directory = segment.directory(), trail = segment.trail();
  const checkpoint = { commitment: commitment.signCommitment(OPERATOR_SECRET, 1n, commitment.directoryRoot(directory)), directory,
    snapshots: [{ backing, header: trail.header, historyHash: segment.historyHash(), issued: 10n, burned: 0n, backings: trail.backings }],
    history: { trail, length: segment.length } };
  Object.assign(expected, { payment, opening, change, receipt, checkpoint, changeRequest, changeSecret: wallet.secret('change') });
  if (operation !== 'pending') wallet.prepare('pay', payment, opening, change);
  if (operation === 'fulfillment') await wallet.submit('pay', { submit: async () => receipt });
  if (operation === 'export' || operation === 'import') {
    await wallet.submit('pay', { submit: async () => receipt });
    await provisionPairing(expected);
    wallet.receiveDelivery('invoice', delivery(expected));
    await wallet.fulfill('invoice', delivery(expected), evidence(expected));
    expected.nextAfterRecovery = notes.ownerOf(wallet.derive('request-secret', [3n]));
    if (operation === 'import') expected.backup = wallet.exportBackup(backupKey);
  }
  return expected;
}

function evidence(expected) {
  const venue = new venueModule.LocalVenue(VENUE); venue.publish(expected.checkpoint.commitment);
  return { configuration: CONFIG, venue, verifier: new IdealVerifier(), checkpoint: expected.checkpoint.commitment,
    evidence: [expected.checkpoint] };
}
function delivery(expected) {
  return { statement: expected.payment, opening: expected.opening, receipt: expected.receipt };
}
async function submit(expected) {
  return wallet.submit('pay', { submit: async input => {
    assert.deepEqual(input.domain, DOMAIN);
    assert.deepEqual(frame(input.statement), frame(expected.payment));
    // A client owns its submitted copy; mutating it cannot affect retained
    // statement bytes or the receipt validation against the original.
    input.statement.proof.fill(0); input.domain.fill(0);
    return copy(expected.receipt);
  } });
}
async function perform(expected) {
  if (operation === 'export') return wallet.exportBackup(backupKey);
  if (operation === 'import') return PoolWalletStore.restoreBackup(`${file}.restored`, AUTHORITY,
    expected.backup, backupKey, walletBackupDigest(expected.backup));
  if (operation === 'credentials') return wallet.installDeliveryCredentials(expected.newTls, 1n);
  if (operation === 'invitation') return wallet.deliveryInvitation('invoice', expected.endpoint);
  if (operation === 'pairing') return wallet.acceptPairing(pairingAlias, expected.invitation,
    expected.pairingDigest, expected.request);
  if (operation === 'request') return wallet.request('invoice', backing, 7n);
  if (operation === 'capability') return wallet.deliveryToken('invoice');
  if (operation === 'inbox') return wallet.receiveDelivery('invoice', delivery(expected));
  if (operation === 'pending') return wallet.prepare('pay', expected.payment, expected.opening, expected.change);
  if (operation === 'receipt') return submit(expected);
  return wallet.fulfill('invoice', delivery(expected), evidence(expected));
}

function assertRequests(expected) {
  assert.deepEqual(wallet.request('invoice', backing, 7n), expected.request);
  assert.equal(wallet.secret('invoice'), expected.secret);
  assert.throws(() => wallet.request('invoice', backing, 8n), { code: 'CONFLICT' });
  if (operation === 'request') {
    assert.equal(wallet.request('next', backing, 7n).owner, expected.nextOwner);
    assert.notEqual(expected.nextOwner, expected.request.owner);
  } else {
    assert.deepEqual(wallet.request('change', backing, 3n), expected.changeRequest);
    assert.equal(wallet.secret('change'), expected.changeSecret);
  }
}
function assertPending(expected, withReceipt) {
  const pending = wallet.pending('pay');
  assert.deepEqual(frame(pending.statement), frame(expected.payment));
  assert.deepEqual(pending.opening, expected.opening);
  assert.deepEqual(pending.change, expected.change);
  assert.equal(pending.receipt === undefined ? undefined : codec.encodeStoredReceipt(pending.receipt),
    withReceipt ? codec.encodeStoredReceipt(expected.receipt) : undefined);
  wallet.prepare('pay', expected.payment, expected.opening, expected.change);
  // Probe each reservation separately, including the second input.
  for (const index of [7, 8]) {
    const conflict = copy(expected.payment); conflict.publicInputs[index] = 13n;
    assert.throws(() => wallet.prepare(`other-${index}`, conflict, expected.opening, expected.change), { code: 'CONFLICT' });
    assert.throws(() => wallet.pending(`other-${index}`), { code: 'UNKNOWN' });
  }
  const changed = copy(expected.payment); changed.proof.fill(0);
  assert.throws(() => wallet.prepare('pay', changed, expected.opening, expected.change), { code: 'CONFLICT' });
  assert.throws(() => wallet.prepare('pay', expected.payment, expected.opening), { code: 'CONFLICT' });
  pending.statement.proof.fill(0); pending.opening.backing.fill(0); pending.change.backing.fill(0);
  assert.deepEqual(frame(wallet.pending('pay').statement), frame(expected.payment));
  assert.deepEqual(wallet.pending('pay').opening, expected.opening);
  assert.deepEqual(wallet.pending('pay').change, expected.change);
}

try {
  if (action === 'crash') {
    const expected = await baseline();
    fs.writeFileSync(expectedFile, v8.serialize(expected), { mode: 0o600, flag: 'wx' });
    const original = sqlite.DatabaseSync.prototype.exec;
    // Setup has completed. Only the single target wallet transaction remains.
    sqlite.DatabaseSync.prototype.exec = function (sql) {
      if (sql.trim().toUpperCase() !== 'COMMIT') return original.call(this, sql);
      // Restore initializes a distinct empty wallet first; interrupt only the
      // transaction that imports the complete old identity and its provenance.
      if (operation === 'import' && this.prepare('SELECT restored_from FROM wallet_custody WHERE singleton=1').get().restored_from === null) return original.call(this, sql);
      if (operation === 'export') {
        expected.backup = this.prepare('SELECT export FROM wallet_custody WHERE singleton=1').get().export;
        fs.writeFileSync(expectedFile, v8.serialize(expected), { mode: 0o600 });
      }
      if (operation === 'capability') {
        expected.token = this.prepare('SELECT token FROM wallet_delivery_tokens WHERE id=?').get('invoice').token;
        fs.writeFileSync(expectedFile, v8.serialize(expected), { mode: 0o600 });
      }
      if (operation === 'invitation') {
        expected.token = this.prepare('SELECT token FROM wallet_delivery_tokens WHERE id=?').get('invoice').token;
        expected.invitation = pairingModule.encodeWalletPairing({ profile: pairingModule.WALLET_PAIRING_PROFILE,
          domain: Buffer.from(DOMAIN).toString('hex'), request: pairingModule.walletRequestText(expected.request),
          generation: '1', endpoint: expected.endpoint, token: expected.token, cert: expected.tls.cert });
        fs.writeFileSync(expectedFile, v8.serialize(expected), { mode: 0o600 });
      }
      if (phase === 'before') process.exit(71);
      original.call(this, sql);
      process.exit(71);
    };
    await perform(expected);
    throw new Error('target transaction never reached COMMIT');
  }
  const expected = v8.deserialize(fs.readFileSync(expectedFile)), survived = phase === 'after';
  if (operation === 'export' || operation === 'import') {
    let bytes = expected.backup;
    if (operation === 'export') {
      assert.equal(wallet.custody().frozen, survived);
      bytes = wallet.exportBackup(backupKey);
      if (survived) assert.deepEqual(bytes, Uint8Array.from(expected.backup));
      assert.equal(wallet.custody().frozen, true);
      assert.throws(() => wallet.prepare('pay', expected.payment, expected.opening, expected.change), { code: 'CONFLICT' });
      wallet.close();
      wallet = PoolWalletStore.restoreBackup(`${file}.restored`, AUTHORITY, bytes, backupKey, walletBackupDigest(bytes));
    } else {
      assert.equal(wallet.custody().frozen, true); wallet.close();
      wallet = new PoolWalletStore(`${file}.restored`, AUTHORITY);
      if (!survived) {
        assert.equal(wallet.custody().restoredFrom, undefined);
        assert.throws(() => wallet.secret('invoice'), { code: 'UNKNOWN' });
        assert.throws(() => wallet.pending('pay'), { code: 'UNKNOWN' });
        // This destination never acquired the source identity. After inspecting
        // it, explicitly select a new path; never overwrite or blind retry.
        wallet.close();
        wallet = PoolWalletStore.restoreBackup(`${file}.retry`, AUTHORITY, bytes, backupKey, walletBackupDigest(bytes));
      }
    }
    assert.equal(wallet.custody().restoredFrom, walletBackupDigest(bytes));
    assertRequests(expected); assertPending(expected, true);
    assert.equal(wallet.deliveryToken('invoice'), expected.token);
    assert.deepEqual(wallet.deliveryCredentials(), expected.credentials);
    assert.equal(wallet.pairing(pairingAlias), expected.invitation);
    assert.deepEqual(wallet.inbox('invoice'), delivery(expected));
    assert.deepEqual(wallet.fulfillment('invoice').opening, expected.opening);
    await assert.rejects(wallet.fulfill('invoice', delivery(expected), evidence(expected)), { code: 'CONFLICT' });
    assert.equal(wallet.request('next', backing, 7n).owner, expected.nextAfterRecovery);
  } else if (operation === 'credentials') {
    assert.deepEqual(wallet.deliveryCredentials(), survived ? { ...expected.newTls, generation: 2n } : expected.oldCredentials);
    const oldBinding = { generation: 1n, certificateDigest: pairingModule.walletCertificateDigest(expected.oldTls.cert) };
    assert.equal(wallet.authorizesDelivery('invoice', expected.oldToken, oldBinding), !survived);
    assert.equal(await perform(expected), 2n);
    assert.equal(wallet.authorizesDelivery('invoice', expected.oldToken, oldBinding), false);
    const newBinding = { generation: 2n, certificateDigest: pairingModule.walletCertificateDigest(expected.newTls.cert) };
    const freshToken = wallet.deliveryToken('invoice');
    assert.equal(wallet.authorizesDelivery('invoice', freshToken, newBinding), true);
    assert.equal(await perform(expected), 2n);
    assert.deepEqual(wallet.deliveryCredentials(), { ...expected.newTls, generation: 2n });
    assert.equal(wallet.authorizesDelivery('invoice', freshToken, newBinding), true);
  } else if (operation === 'invitation') {
    const binding = { generation: 1n, certificateDigest: pairingModule.walletCertificateDigest(expected.tls.cert) };
    assert.equal(wallet.authorizesDelivery('invoice', expected.token, binding), survived);
    const invitation = await perform(expected), parsed = pairingModule.decodeWalletPairing(invitation);
    if (survived) assert.equal(invitation, expected.invitation);
    else assert.notEqual(parsed.token, expected.token);
    assert.equal(await perform(expected), invitation);
    assert.equal(wallet.authorizesDelivery('invoice', parsed.token, binding), true);
  } else if (operation === 'pairing') {
    if (survived) assert.equal(wallet.pairing(pairingAlias), expected.invitation);
    else assert.throws(() => wallet.pairing(pairingAlias), { code: 'UNKNOWN' });
    assert.equal(await perform(expected), expected.pairingDigest);
    assert.equal(await perform(expected), expected.pairingDigest);
    assert.equal(wallet.pairing(pairingAlias), expected.invitation);
  } else if (operation === 'capability') {
    assert.deepEqual(wallet.request('invoice', backing, 7n), expected.request);
    assert.equal(wallet.authorizesDelivery('invoice', expected.token), survived);
    const token = wallet.deliveryToken('invoice');
    if (survived) assert.equal(token, expected.token);
    else assert.notEqual(token, expected.token);
    assert.equal(wallet.deliveryToken('invoice'), token);
    assert.equal(wallet.authorizesDelivery('invoice', token), true);
    assert.equal(wallet.fulfillment('invoice'), undefined);
  } else if (operation === 'request') {
    if (survived) assert.equal(wallet.secret('invoice'), expected.secret);
    else assert.throws(() => wallet.secret('invoice'), { code: 'UNKNOWN' });
    assertRequests(expected);
  } else {
    assertRequests(expected);
    if (operation === 'pending' && !survived) {
      assert.throws(() => wallet.pending('pay'), { code: 'UNKNOWN' });
      // If either reservation survived without its pending row, this fails.
      wallet.prepare('pay', expected.payment, expected.opening, expected.change);
    }
    assertPending(expected, operation === 'fulfillment' || (operation === 'receipt' && survived));
    if (operation === 'receipt') {
      assert.equal(codec.encodeStoredReceipt(await submit(expected)), codec.encodeStoredReceipt(expected.receipt));
      assert.equal(codec.encodeStoredReceipt(await submit(expected)), codec.encodeStoredReceipt(expected.receipt));
      assertPending(expected, true);
    }
    if (operation === 'inbox') {
      assert.deepEqual(wallet.inbox('invoice'), survived ? delivery(expected) : undefined);
      const acknowledged = await perform(expected);
      assert.equal(await perform(expected), acknowledged);
      assert.deepEqual(wallet.inbox('invoice'), delivery(expected));
      assert.equal(wallet.fulfillment('invoice'), undefined);
    }
    if (operation === 'fulfillment') {
      assert.deepEqual(wallet.received('invoice'), survived ? expected.opening : undefined);
      assert.equal(wallet.fulfillment('invoice') === undefined, !survived);
      if (!survived) assert.equal((await perform(expected)).kind, 'final');
      await assert.rejects(perform(expected), { code: 'CONFLICT' });
      assert.deepEqual(wallet.received('invoice'), expected.opening);
      const saved = wallet.fulfillment('invoice');
      assert.deepEqual(saved.opening, expected.opening);
      assert.equal(codec.encodeStoredReceipt(saved.receipt), codec.encodeStoredReceipt(expected.receipt));
      assert.deepEqual(commitment.encodeCommitment(saved.checkpoint), commitment.encodeCommitment(expected.checkpoint.commitment));
      wallet.received('invoice').backing.fill(0);
      assert.deepEqual(wallet.received('invoice'), expected.opening);
      const db = new sqlite.DatabaseSync(file, { readOnly: true });
      try {
        const rows = db.prepare('SELECT receipt, checkpoint FROM wallet_fulfilled').all();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].receipt, codec.encodeStoredReceipt(expected.receipt));
        assert.equal(rows[0].checkpoint, Buffer.from(commitment.encodeCommitment(expected.checkpoint.commitment)).toString('hex'));
      } finally { db.close(); }
    }
  }
  console.log(JSON.stringify({ restored: operation, phase }));
} finally { wallet.close(); }

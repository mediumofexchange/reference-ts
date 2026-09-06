// Child process for store-crash.mjs. It deliberately exits from the store's
// durability hook, modelling an abrupt process death at each journal phase.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.log('SKIP pool store crash worker: Node.js 24 or newer is required.');
  process.exit(0);
}

const [{ PoolStore }, storeCodec, { ed25519 }, { sha256 }, { bytesToHex }, backing, commitment, statement,
  venueModule, fieldModule] = await Promise.all([
  import('../../dist/pool/store.js'),
  import('../../dist/pool/store-codec.js'),
  import('@noble/curves/ed25519.js'),
  import('@noble/hashes/sha2.js'),
  import('@noble/hashes/utils.js'),
  import('../../dist/backing.js'),
  import('../../dist/commitment.js'),
  import('../../dist/pool/statement.js'),
  import('../../dist/venue.js'),
  import('../../dist/pool/field.js'),
]);

const mode = process.argv[2], path = process.argv[3], phase = process.argv[4];
if (!['opening', 'receipt', 'commit'].includes(mode) || typeof path !== 'string' || !['applied', 'stored', 'committed', 'none'].includes(phase)) {
  console.error('usage: store-crash-worker.mjs <opening|receipt|commit> <database> <applied|stored|committed|none>');
  process.exit(2);
}

const fill = byte => new Uint8Array(32).fill(byte);
const CONFIG = Object.freeze({
  issue: { bytecode: fill(0x11), vk: fill(0x12) },
  spend: { bytecode: fill(0x13), vk: fill(0x14) },
  burn: { bytecode: fill(0x15), vk: fill(0x16) },
  helper: fill(0x17),
});
const DOMAIN = statement.configurationHash(CONFIG);
const VENUE = fill(0x33);
const OPERATOR_SECRET = new Uint8Array(32).fill(7), OPERATOR = ed25519.getPublicKey(OPERATOR_SECRET);
const BACKER_SECRET = new Uint8Array(32).fill(1), BACKER = ed25519.getPublicKey(BACKER_SECRET);

class Oracle {
  accept(value) { return value; }
  async verify(kind, inputs, proof) {
    return bytesToHex(proof) === bytesToHex(sha256(statement.statementBytes(DOMAIN, kind, inputs)));
  }
}

function terms() {
  const value = backing.makeBacking({ obligor: BACKER,
    payout: { thing: 'EUR', quantumExponent: -2, perUnit: 100n }, reliance: [],
    evidence: { setting: 'pool', operator: OPERATOR, construction: 'moe/pool/v2', configuration: DOMAIN,
      witnessing: { venue: VENUE, interval: 1n }, replacementRule: BACKER } });
  return { backing: value, signature: backing.signBacking(BACKER_SECRET, value) };
}

function hookFor(target) {
  return target === 'none' ? undefined : at => {
    if (at === target) process.exit(71);
  };
}

function store(file, venue, oracle, target = 'none') {
  return new PoolStore(file, CONFIG, OPERATOR_SECRET, venue, oracle, hookFor(target));
}

function issueFor(trail, termsValue, output = 101n) {
  const own = statement.segmentAuthority(trail.header);
  const inputs = [...fieldModule.limbsOf(own.domain), ...fieldModule.limbsOf(own.segment), own.scopeRoot,
    ...fieldModule.limbsOf(termsValue.backing.name), 10n, output];
  const message = statement.statementBytes(own.domain, statement.ISSUE, inputs);
  return { kind: statement.ISSUE, publicInputs: inputs,
    proof: sha256(message), obligorSignature: ed25519.sign(message, BACKER_SECRET) };
}

function encoded(value) {
  return bytesToHex(commitment.encodeCommitment(value));
}

async function baseline(file, venue, oracle, termsValue, withReceipt) {
  let current = store(file, venue, oracle);
  let view = await current.view();
  if (view.trail === undefined) await current.activate('opening', [termsValue]);
  view = await current.view();
  // A restarted in-memory venue needs the first durable commitment as its
  // predecessor. Publishing only the latest would skip a sequence when a
  // checkpoint commit survived the crash.
  const first = view.checkpoints[0]?.commitment ?? view.latest;
  if (first !== undefined && venue.latestFor(OPERATOR) === undefined) venue.publish(first);
  let issue;
  if (withReceipt) {
    issue = oracle.accept(issueFor(view.trail, termsValue));
    await current.submit(issue);
  }
  current.close();
  return issue;
}

async function runOpening(file) {
  const venue = new venueModule.LocalVenue(VENUE), oracle = new Oracle(), value = terms();
  if (phase !== 'none') {
    const current = store(file, venue, oracle, phase);
    await current.activate('opening', [value]);
    return;
  }
  const current = store(file, venue, oracle);
  const before = await current.view();
  const first = await current.activate('opening', [value]);
  const second = await current.activate('opening', [value]);
  const published = await current.publish();
  const after = await current.view();
  console.log(JSON.stringify({ before: before.highestSignedSequence.toString(), first: encoded(first), second: encoded(second),
    published: encoded(published), highest: after.highestSignedSequence.toString() }));
  current.close();
}

async function runReceipt(file) {
  const venue = new venueModule.LocalVenue(VENUE), oracle = new Oracle(), value = terms();
  if (phase !== 'none') {
    await baseline(file, venue, oracle, value, false);
    const current = store(file, venue, oracle, phase), view = await current.view();
    if (view.latest !== undefined && venue.latestFor(OPERATOR) === undefined) venue.publish(view.latest);
    const issue = oracle.accept(issueFor(view.trail, value));
    await current.submit(issue);
    return;
  }
  const issue = await baseline(file, venue, oracle, value, false);
  const current = store(file, venue, oracle), before = await current.view();
  if (before.latest !== undefined && venue.latestFor(OPERATOR) === undefined) venue.publish(before.latest);
  const ownIssue = oracle.accept(issue ?? issueFor(before.trail, value));
  const first = await current.submit(ownIssue), second = await current.submit(ownIssue), after = await current.view();
  console.log(JSON.stringify({ before: before.trail?.statements.length ?? 0, first: storeCodec.encodeStoredReceipt(first), second: storeCodec.encodeStoredReceipt(second),
    after: after.trail?.statements.length ?? 0 }));
  current.close();
}

async function runCommit(file) {
  const venue = new venueModule.LocalVenue(VENUE), oracle = new Oracle(), value = terms();
  if (phase !== 'none') {
    await baseline(file, venue, oracle, value, true);
    const current = store(file, venue, oracle, phase), view = await current.view();
    if (view.latest !== undefined && venue.latestFor(OPERATOR) === undefined) venue.publish(view.latest);
    const issue = oracle.accept(issueFor(view.trail, value));
    await current.commit('checkpoint');
    return;
  }
  const issue = await baseline(file, venue, oracle, value, true);
  const current = store(file, venue, oracle), before = await current.view();
  if (before.latest !== undefined && venue.latestFor(OPERATOR) === undefined) venue.publish(before.latest);
  const ownIssue = oracle.accept(issue ?? issueFor(before.trail, value));
  await current.submit(ownIssue);
  const first = await current.commit('checkpoint'), second = await current.commit('checkpoint');
  const published = await current.publish();
  const next = await current.commit('next');
  console.log(JSON.stringify({ before: before.highestSignedSequence.toString(), first: encoded(first), second: encoded(second),
    published: encoded(published), next: encoded(next), nextSequence: next.sequence.toString() }));
  current.close();
}

if (mode === 'opening') await runOpening(path);
else if (mode === 'receipt') await runReceipt(path);
else await runCommit(path);

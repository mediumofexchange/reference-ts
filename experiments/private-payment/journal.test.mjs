import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal, MAX_EVENTS } from './journal.mjs';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const scratch = join(root, 'scratch');
const identity = { profile: 'private-payment-research/v1', configHash: 'ab'.repeat(32) };
function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  assert.equal(realpathSync(scratch), scratch);
  const directory = realpathSync(mkdtempSync(join(scratch, 'research-journal-')));
  const path = join(directory, 'journal.sqlite'), handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) handle.close();
    const target = realpathSync(directory);
    assert.equal(dirname(target), scratch);
    assert.ok(target.startsWith(scratch + sep) && target.startsWith(join(scratch, 'research-journal-')));
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { path, open(config = identity, hook) { const handle = new Journal(path, config, hook); handles.push(handle); return handle; } };
}

test('persistent copied snapshots, exact retries and response conflicts', t => {
  const f = fixture(t), journal = f.open();
  const command = { kind: 'spend', proof: 'public-proof', outputs: ['a', 'b'] };
  const response = { accepted: true, public: { root: 'r1' } };
  assert.equal(journal.append(0n, 'payment', command, response), true);
  command.outputs[0] = 'changed'; response.public.root = 'changed';
  const saved = journal.lookup('payment');
  assert.deepEqual(saved, { command: { kind: 'spend', proof: 'public-proof', outputs: ['a', 'b'] },
    response: { accepted: true, public: { root: 'r1' } } });
  assert.equal(journal.append(0n, 'payment', saved.command, saved.response), true);
  assert.throws(() => journal.append(1n, 'payment', saved.command, { accepted: false }), /conflict/);
  assert.throws(() => journal.append(1n, 'payment', { ...saved.command, proof: 'other' }, saved.response), /conflict/);
  const snapshot = journal.snapshot(); snapshot.events[0].command.outputs[1] = 'mutated';
  saved.response.public.root = 'mutated';
  journal.close();
  assert.deepEqual(f.open().snapshot(), { sequence: 1n, events: [{ id: 'payment',
    command: { kind: 'spend', proof: 'public-proof', outputs: ['a', 'b'] },
    response: { accepted: true, public: { root: 'r1' } } }] });
  assert.equal(f.open().lookup('unknown'), undefined);
});

test('two handles cannot append against the same prior sequence', async t => {
  const f = fixture(t), first = f.open(), second = f.open();
  const a = first.snapshot(), b = second.snapshot();
  await Promise.resolve(); // The parent may await proof work outside any transaction.
  assert.equal(first.append(a.sequence, 'first', { nf: 'n1' }, { root: 'r1' }), true);
  assert.equal(second.append(b.sequence, 'second', { nf: 'n2' }, { root: 'r2' }), false);
  assert.equal(second.lookup('second'), undefined);
  assert.equal(second.append(second.snapshot().sequence, 'second', { nf: 'n2' }, { root: 'r2' }), true);
  assert.deepEqual(first.snapshot().events.map(event => event.id), ['first', 'second']);
});

for (const phase of ['stored', 'committed']) {
  test(`failure at ${phase} preserves the correct retry result`, t => {
    const f = fixture(t); let fail = true;
    const journal = f.open(identity, at => { if (fail && at === phase) throw new Error('simulated process interruption'); });
    assert.throws(() => journal.append(0n, 'event', { proof: 'public' }, { root: 'new' }), /interruption/);
    assert.equal(journal.snapshot().sequence, phase === 'committed' ? 1n : 0n);
    fail = false; journal.close();
    const recovered = f.open();
    assert.equal(recovered.append(0n, 'event', { proof: 'public' }, { root: 'new' }), true);
    assert.equal(recovered.snapshot().sequence, 1n);
    assert.deepEqual(recovered.lookup('event'), { command: { proof: 'public' }, response: { root: 'new' } });
  });
}

test('identity is copied, bound on reopening, and checked on every transaction', t => {
  const f = fixture(t), config = { ...identity }, journal = f.open(config);
  config.profile = 'changed'; config.configHash = 'cd'.repeat(32);
  journal.append(0n, 'event', {}, {});
  assert.throws(() => f.open(config), /identity mismatch/);
  const raw = new DatabaseSync(f.path);
  raw.prepare('UPDATE identity SET config_hash=?').run('ef'.repeat(32)); raw.close();
  assert.throws(() => journal.snapshot(), /identity mismatch/);
  assert.throws(() => journal.lookup('event'), /identity mismatch/);
  assert.throws(() => journal.append(1n, 'next', {}, {}), /identity mismatch/);
});

test('bounded history preserves prior retries and rejects gaps', t => {
  const f = fixture(t), journal = f.open();
  for (let i = 0; i < MAX_EVENTS; i++) assert.equal(journal.append(BigInt(i), `e${i}`, { n: i }, { n: i }), true);
  assert.equal(journal.snapshot().sequence, BigInt(MAX_EVENTS));
  assert.throws(() => journal.append(BigInt(MAX_EVENTS), 'extra', {}, {}), /event limit/);
  assert.equal(journal.append(0n, 'e0', { n: 0 }, { n: 0 }), true);
  const raw = new DatabaseSync(f.path); raw.exec('DELETE FROM events WHERE seq=1'); raw.close();
  assert.throws(() => journal.snapshot(), /noncontiguous/);
  assert.throws(() => f.open(), /noncontiguous/);
});

test('observed tail truncation and corrupt stored JSON fail closed', t => {
  const f = fixture(t), journal = f.open(); journal.append(0n, 'event', {}, {});
  const raw = new DatabaseSync(f.path); raw.exec('DELETE FROM events');
  assert.throws(() => journal.snapshot(), /truncated/);
  raw.prepare('INSERT INTO events VALUES(1,?,?,?)').run('event', 'invalid JSON', '{}'); raw.close();
  assert.throws(() => f.open(), /JSON/);
});

test('rejects memory paths and lossy JSON before writing', t => {
  for (const path of ['', ' ', ':memory:', 'file::memory:']) assert.throws(() => new Journal(path, identity), /persistent/);
  const journal = fixture(t).open();
  for (const command of [undefined, { omitted: undefined }, { n: NaN }, { n: 1n }]) {
    assert.throws(() => journal.append(0n, 'invalid', command, {}), /JSON/);
  }
  assert.equal(journal.snapshot().sequence, 0n);
  journal.close(); journal.close();
  assert.throws(() => journal.snapshot(), /closed/);
});

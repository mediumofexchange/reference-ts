import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { CommandError, fresh, integer, hex32, openDirectory, parseArguments, readRequired, readSecret, refusalOf, requireNew, requireWritable, UsageError, writeExclusive, writeReplace,
  writeSame } from '../src/cli/common.js';
import { FaultEvidenceLimitError } from '../src/pool/evidence-chain.js';
import { PackageLimitError } from '../src/pool/v3/package.js';
import { EvidenceRefusal } from '../src/pool/v3/refusals.js';
import { TrailLimitError } from '../src/pool/v3/trail.js';
import { RangeLimitError } from '../src/record-range.js';
import { authenticate, explain } from '../src/cli/terms.js';
import { LIT } from '../src/lit/construction.js';
import { litConfigHash } from '../src/lit/configuration.js';
import { encodePublication as encodeLitPublication } from '../src/lit/records.js';
import { encodeLitTerms, LIT_TERMS } from '../src/lit/terms.js';
import { adoptedDomain } from '../src/pool/v3/configuration.js';
import { POOL_V3 } from '../src/pool/v3/construction.js';
import { encodeRootTerms, V3_TERMS } from '../src/pool/v3/terms.js';
import { decodeRecord, encodePublication as encodePoolPublication, encodeRecord } from '../src/pool/v3/records.js';
import { tagOf } from '../src/pool/v3/recovery.js';
import { limbsOf } from '../src/pool/field.js';
import { EMPTY_NOTE_ROOT } from '../src/pool/note-tree.js';
import { outside, wallet } from '../src/cli/wallet.js';
import { parsePublicationFile, readPublication } from '../src/cli/relay.js';
import { initRead, keptReplay, openEvidence, reader } from '../src/cli/reader.js';
import { succinctPoolV3, testCheckSet } from '../src/pool/v3/succinct.js';
import { keptFileDigest, ReplayStore } from '../src/pool/v3/replay-store.js';
import { keepAliveDue, servePollsOn } from '../src/cli/operator.js';
import { closeListener, isListenerUrl, listenLoopback, SERVE_FLAGS, serveFlags } from '../src/cli/serve.js';
import { V3StoreError } from '../src/pool/v3/store.js';
import { parseVenue, publisherStore, publishingSuppliers, SpendBudget, venueText } from '../src/cli/venue.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ErgoPublisher, payToPublicKeyTree, verifyErgoProof } from '../src/ergo-publisher.js';
import { VenueError } from '../src/venue-error.js';
import { ERGO_SYNTHETIC_REFERENCE, ownErgoProfile } from '../src/ergo-profile.js';
import { MempoolNode, plainBox, SYNTHETIC_ANCHOR_HEIGHT, SYNTHETIC_SCRIPTS } from '../src/ergo-synthetic.js';

describe('moe command arguments', () => {
  it('reads positionals and declared flags, refusing unknown, repeated and valueless ones', () => {
    const args = parseArguments(['a', '--dir', 'D', '--node', 'x', '--node', 'y', '--synthetic'], { dir: 'value', node: 'values', synthetic: 'switch' }, 1);
    expect(args.positional).toEqual(['a']);
    expect(args.flags.get('node')).toEqual(['x', 'y']);
    expect(args.flags.get('synthetic')).toEqual(['true']);
    expect(() => parseArguments(['--other', 'x'], { dir: 'value' }, 0)).toThrow(UsageError);
    expect(() => parseArguments(['--dir', 'a', '--dir', 'b'], { dir: 'value' }, 0)).toThrow('given twice');
    expect(() => parseArguments(['--dir'], { dir: 'value' }, 0)).toThrow('needs a value');
    expect(() => parseArguments(['--dir', '--node'], { dir: 'value', node: 'values' }, 0)).toThrow('needs a value');
    expect(() => parseArguments(['a', 'b'], {}, 1)).toThrow('expected 1 argument');
    // A name an object inherits is no flag (audit 32).
    for (const inherited of ['constructor', '__proto__', 'toString']) {
      expect(() => parseArguments([`--${inherited}`, 'x'], { dir: 'value' }, 0)).toThrow(`unknown option --${inherited}`);
    }
  });
  it('reads a handed file within its bound, refusing a directory, a path through a file and one past the bound by name (audit 32)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moe-read-'));
    try {
      writeFileSync(join(dir, 'frame'), new Uint8Array(8));
      expect(readRequired(join(dir, 'frame'), 'frame')).toHaveLength(8);
      expect(() => readRequired(join(dir, 'frame'), 'frame', 7)).toThrow(expect.objectContaining({ code: 'INVALID', message: expect.stringMatching(/more than the 7 bytes/) }));
      expect(() => readRequired(dir, 'frame')).toThrow(expect.objectContaining({ code: 'INVALID', message: expect.stringMatching(/is a directory/) }));
      // Windows answers a path through a file as absent (ENOENT), POSIX as ENOTDIR.
      expect(() => readRequired(join(dir, 'frame', 'below'), 'frame')).toThrow(process.platform === 'win32' ? expect.objectContaining({ code: 'ABSENT' })
        : expect.objectContaining({ code: 'INVALID', message: expect.stringMatching(/lies under a file/) }));
      expect(() => readRequired(join(dir, 'absent'), 'frame')).toThrow(expect.objectContaining({ code: 'ABSENT' }));
      expect(() => writeSame(dir, 'out')).toThrow(expect.objectContaining({ code: 'INVALID' }));
      expect(() => readSecret(dir, 'key')).toThrow(expect.objectContaining({ code: 'INVALID' }));
      // A place a whole-or-nothing write cannot use is refused by name, leaving nothing behind.
      expect(() => requireWritable(join(dir, 'frame', 'handoff'))).toThrow(expect.objectContaining({ code: 'STORAGE' }));
      requireWritable(join(dir, 'handoff'));
      expect(readdirSync(dir)).toEqual(['frame']);
      // A rerun's output past the default bound is still the same bytes; a longer file holds other bytes.
      const large = new Uint8Array(17 * 1024 * 1024).fill(3), out = join(dir, 'handoff.out');
      writeSame(out, large); writeSame(out, large);
      expect(() => writeSame(out, large.subarray(1))).toThrow(expect.objectContaining({ code: 'EXISTS' }));
      // The bound is judged on the bytes read, not the size a file states: a device states none.
      if (process.platform !== 'win32') expect(() => readRequired('/dev/zero', 'zero', 1024)).toThrow(expect.objectContaining({ code: 'INVALID' }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('names an init that did not finish INCOMPLETE, and anything else at its path EXISTS (audit 32)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moe-new-'));
    try {
      requireNew(join(dir, 'fresh'));
      mkdirSync(join(dir, 'begun')); writeFileSync(join(dir, 'begun', 'lock.db'), '');
      expect(() => requireNew(join(dir, 'begun'))).toThrow(expect.objectContaining({ code: 'INCOMPLETE' }));
      // An init still running holds the lock: removing its directory would pull it from under that process.
      const running = new DatabaseSync(join(dir, 'begun', 'lock.db'), { timeout: 0 });
      running.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
      try { expect(() => requireNew(join(dir, 'begun'))).toThrow(expect.objectContaining({ code: 'BUSY' })); } finally { running.close(); }
      expect(() => requireNew(join(dir, 'begun'))).toThrow(expect.objectContaining({ code: 'INCOMPLETE' }));
      writeFileSync(join(dir, 'begun', 'config.json'), '{}');
      expect(() => requireNew(join(dir, 'begun'))).toThrow(expect.objectContaining({ code: 'EXISTS' }));
      expect(() => requireNew(dir)).toThrow(expect.objectContaining({ code: 'EXISTS' }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('takes a listener URL whose port a connection can reach (audit 32)', () => {
    const onion = `${'m'.repeat(55)}d.onion`;
    for (const url of ['http://127.0.0.1:1/', 'http://127.0.0.1:65535/', `http://${onion}/`, `http://${onion}:8080/`]) expect(isListenerUrl(url)).toBe(true);
    for (const url of ['http://127.0.0.1:0/', 'http://127.0.0.1:99999/', 'http://127.0.0.1:65536/', `http://${onion}:99999/`, 'http://127.0.0.1/',
      'https://127.0.0.1:80/', `http://${'m'.repeat(56)}.onion/`]) expect(isListenerUrl(url)).toBe(false);
  });
  it('takes decimal integers in range and lowercase 32-byte hex only', () => {
    expect(integer('12', 'n')).toBe(12n);
    for (const bad of ['', '-1', '012', '1e3', ' 1', '0x10']) expect(() => integer(bad, 'n')).toThrow(UsageError);
    expect(() => integer('7', 'n', 1n, 6n)).toThrow('out of range');
    expect(hex32('ab'.repeat(32), 'h')).toHaveLength(32);
    for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33)]) expect(() => hex32(bad, 'h')).toThrow(UsageError);
  });
  it('names evidence past a reader\'s budget as the read\'s resource refusal, never an uncoded failure (audit 32)', async () => {
    const resource = { code: 'UNRESOLVED', check: 'resource-refusal' };
    for (const error of [new PackageLimitError('package item exceeds the reader\'s budget'), new TrailLimitError('trail exceeds reader byte budget'),
      new RangeLimitError('range reader budget exceeded'), new FaultEvidenceLimitError('evidence exceeds reader budget')]) {
      expect(await refusalOf(error)).toEqual({ ...resource, message: error.message });
    }
    expect(await refusalOf(new EvidenceRefusal('resource-refusal'))).toMatchObject(resource);
    expect(await refusalOf(new CommandError('BUSY', 'held', 'LOCK'))).toEqual({ code: 'BUSY', check: 'LOCK', message: 'held' });
    expect(await refusalOf(new RangeError('a programming failure'))).toBeUndefined();
  });
  it('reads a secret file of exactly 32 bytes as a copy, refusing another length or an absent file by name (audit 32)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moe-secret-')), path = join(directory, 'backer.key');
    try {
      expect(() => readSecret(path, 'backer.key')).toThrow(expect.objectContaining({ code: 'ABSENT' }));
      writeExclusive(path, new Uint8Array(32).fill(7));
      const secret = readSecret(path, 'backer.key');
      expect([...secret]).toEqual(Array(32).fill(7));
      secret.fill(0);
      expect([...readSecret(path, 'backer.key')]).toEqual(Array(32).fill(7));
      writeFileSync(join(directory, 'short.key'), new Uint8Array(31));
      expect(() => readSecret(join(directory, 'short.key'), 'short.key')).toThrow(expect.objectContaining({ code: 'INVALID' }));
      const made = [fresh(), fresh()];
      expect(made.map(bytes => [bytes.length, bytes.byteOffset, bytes.buffer.byteLength])).toEqual([[32, 0, 32], [32, 0, 32]]);
      expect(made[0]).not.toEqual(made[1]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('moe venue files', () => {
  const profile = ownErgoProfile({ reference: ERGO_SYNTHETIC_REFERENCE, anchor: new Uint8Array(32).fill(5), depth: 2n, scripts: SYNTHETIC_SCRIPTS });
  const file = () => JSON.parse(venueText(profile, 900_002n));
  it('round-trips the identity preimage and anchor height', () => {
    const venue = parseVenue(file());
    expect(venue.anchorHeight).toBe(900_002n);
    expect(venue.profile.depth).toBe(2n);
    expect(venue.reference.context).toBe(ERGO_SYNTHETIC_REFERENCE);
  });
  it('refuses a mainnet or unknown context, an extra field, two kinds at one location and a short anchor height', () => {
    expect(() => parseVenue({ ...file(), context: 'moe/venue/ergo/v3' })).toThrow('mainnet stays disabled');
    const code = value => { try { parseVenue(value); } catch (error) { expect(error).toBeInstanceOf(CommandError); return error.code; } return undefined; };
    expect(code({ ...file(), context: 'moe/venue/ergo/v3' })).toBe('VENUE');
    const locations = file().locations; locations[1] = locations[0];
    for (const bad of [{ ...file(), extra: 1 }, { ...file(), locations }, { ...file(), anchorHeight: '1024' }, { ...file(), depth: '-1' }]) {
      expect(code(bad)).toBe('INVALID');
    }
  });
});

describe('moe operator serve rules', () => {
  it('keeps the held checkpoint alive at half the window the journal commits in: the silence less the lag', () => {
    // At depth 10 (lag 11) and silence 16 the journal commits only through the held index + 5; half the silence
    // (+8) is already past it.
    expect(keepAliveDue(102n, 100n, 16n, 11n)).toBe(true);
    expect(keepAliveDue(101n, 100n, 16n, 11n)).toBe(false);
    for (const [silence, lag] of [[16n, 3n], [16n, 11n], [40n, 3n], [12n, 11n]]) {
      let due = 100n;
      while (!keepAliveDue(due, 100n, silence, lag)) due++;
      expect(due + lag - 100n).toBeLessThanOrEqual(silence);
    }
    expect(keepAliveDue(1000n, undefined, 16n, 3n)).toBe(false);
    expect(keepAliveDue(1000n, 100n, undefined, 3n)).toBe(false);
  });
  it('refuses a serve port in use as UNAVAILABLE naming it, and an --onion that is not a v3 onion host as usage', async () => {
    const held = createServer(), other = createServer();
    try {
      const port = await listenLoopback(held, 0);
      let refused;
      try { await listenLoopback(other, port); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(CommandError);
      expect([refused.code, refused.message]).toEqual(['UNAVAILABLE', `port ${port} is in use`]);
      await closeListener(other);
    } finally { await closeListener(held); }
    expect(serveFlags(parseArguments(['--onion', `${'m'.repeat(55)}d.onion`], SERVE_FLAGS, 0)).onion).toBe(`${'m'.repeat(55)}d.onion`);
    for (const onion of [`${'m'.repeat(56)}.onion`, `${'m'.repeat(55)}d.onion.example`, '127.0.0.1']) {
      expect(() => serveFlags(parseArguments(['--onion', onion], SERVE_FLAGS, 0))).toThrow('--onion takes a v3 onion host');
    }
  });
  it('polls on after a refused budget, an unreplayed transaction or a journal refusal, not after storage, fence or conflict', () => {
    for (const error of [new CommandError('BUDGET', 'x'), new CommandError('UNREPLAYED', 'x'), new V3StoreError('SCHEDULE', 'x'),
      new V3StoreError('UNAVAILABLE', 'x')]) expect(servePollsOn(error)).toBe(true);
    for (const error of [new CommandError('VENUE', 'x'), new V3StoreError('STORAGE', 'x'), new V3StoreError('FENCED', 'x'),
      new V3StoreError('CONFLICT', 'x'), new Error('x')]) expect(servePollsOn(error)).toBe(false);
  });
});

describe('moe files', () => {
  it('writes a new file whole and owner-only, refuses an existing one unchanged, and leaves no temporary file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moe-write-')), path = join(directory, 'key');
    try {
      writeExclusive(path, new Uint8Array([1, 2, 3]));
      expect(() => writeExclusive(path, new Uint8Array([4]))).toThrow(expect.objectContaining({ code: 'EXISTS' }));
      expect([...readFileSync(path)]).toEqual([1, 2, 3]);
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      writeReplace(join(directory, 'service.json'), 'a');
      writeReplace(join(directory, 'service.json'), 'b');
      expect(readFileSync(join(directory, 'service.json'), 'utf8')).toBe('b');
      expect(readdirSync(directory).sort()).toEqual(['key', 'service.json']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('moe wallet and relay files', () => {
  it('accepts a rerun writing the same bytes and refuses other bytes at the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moe-same-')), path = join(dir, 'out');
    try {
      writeSame(path, 'one');
      writeSame(path, 'one');
      expect(() => writeSame(path, 'two')).toThrow(expect.objectContaining({ code: 'EXISTS' }));
      expect(readFileSync(path, 'utf8')).toBe('one');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps a handoff outside the data directory, refusing a path inside it or two equal paths', () => {
    const directory = { path: join(tmpdir(), 'moe-data') };
    expect(outside(directory, join(tmpdir(), 'key'), join(tmpdir(), 'out'))).toHaveLength(2);
    expect(outside(directory, join(tmpdir(), 'moe-data-other', 'key'))).toHaveLength(1);
    for (const inside of [directory.path, join(directory.path, 'key'), join(directory.path, '..key')]) {
      expect(() => outside(directory, inside)).toThrow(/inside the data directory/);
    }
    expect(() => outside(directory, join(tmpdir(), 'k'), join(tmpdir(), 'k'))).toThrow(/must differ/);
  });
  it('follows links to the data directory when it judges a handoff path', () => {
    const base = mkdtempSync(join(tmpdir(), 'moe-link-')), data = join(base, 'data'), link = join(base, 'alias');
    try {
      mkdirSync(data); symlinkSync(data, link, 'junction');
      expect(() => outside({ path: data }, join(link, 'handoff.key'))).toThrow(expect.objectContaining({ code: 'PATH' }));
      expect(() => outside({ path: link }, join(data, 'new', 'handoff.key'))).toThrow(expect.objectContaining({ code: 'PATH' }));
      expect(() => outside({ path: data }, join(base, 'key'), join(link, '..', 'key'))).toThrow(/must differ/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it('fences a second publisher store that saves after the first loaded the outbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moe-relay-'));
    try {
      const a = publisherStore(join(dir, 'relay.db')), b = publisherStore(join(dir, 'relay.db'));
      expect(a.persistence.load()).toBeUndefined();
      expect(b.persistence.load()).toBeUndefined();
      a.persistence.save('first');
      expect(() => b.persistence.save('second')).toThrow(expect.objectContaining({ code: 'FENCED', message: 'another publisher changed this outbox' }));
      expect(() => b.persistence.guard()).toThrow(expect.objectContaining({ code: 'FENCED' }));
      a.persistence.guard();
      a.close(); b.close();
      const c = publisherStore(join(dir, 'relay.db'));
      expect(c.persistence.load()).toBe('first');
      c.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('sends a funding directory\'s transaction only where the publisher\'s proceed passes after the budget\'s read (Next 4 (bi))', async () => {
    const posted = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        if (request.url.startsWith('/transactions/bytes')) { posted.push(request.url); response.end(JSON.stringify('11'.repeat(32))); return; }
        response.end('[]'); // the funding key's unspent boxes: none listed
      });
    });
    try {
      const port = await listenLoopback(server, 0), read = [];
      const budget = { tree: new Uint8Array(36), authorize: async (signed, id, boxes) => { read.push(boxes.length); } };
      const [supplier] = publishingSuppliers({ config: { nodes: [`http://127.0.0.1:${port}`] } }, budget);
      const signed = new Uint8Array([1]), id = new Uint8Array(32).fill(0x11);
      await expect(supplier.submit(signed, id, () => { throw new CommandError('ENDED', 'the walk ended'); })).rejects.toThrow('the walk ended');
      expect([read, posted]).toEqual([[0], []]);
      await supplier.submit(signed, id, () => {});
      expect([read, posted]).toEqual([[0, 0], ['/transactions/bytes']]);
    } finally { await closeListener(server); }
  });
  it('reserves a transaction in the spend budget only once the publisher\'s proceed passes (Next 4 (bi))', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moe-budget-'));
    try {
      const secret = new Uint8Array(32).fill(7), tree = payToPublicKeyTree(secp256k1.getPublicKey(secret, true));
      const node = new MempoolNode('node', verifyErgoProof), box = plainBox(tree, 10_000_000n, SYNTHETIC_ANCHOR_HEIGHT);
      node.fund(box);
      let built;
      const capture = { name: 'capture', unspentBoxes: t => node.unspentBoxes(t), hasBox: id => node.hasBox(id), hasTransaction: async () => false,
        submit: async (signed, id) => { built = { signed, id }; } };
      await new ErgoPublisher({ secretKey: secret, suppliers: [capture] })
        .publish({ location: SYNTHETIC_SCRIPTS[4], subject: new Uint8Array(32).fill(1), record: new Uint8Array(100).fill(2), height: SYNTHETIC_ANCHOR_HEIGHT });
      const budget = new SpendBudget({ config: { spendBudgetNanoErg: '1000000000' }, file: name => join(dir, name) }, tree);
      let one;
      try {
        const ended = () => { throw new VenueError('this submission\'s call ended before the supplier sent it'); };
        await expect(budget.authorize(built.signed, built.id, [box], ended)).rejects.toThrow('call ended');
        expect([budget.spent(), budget.take()]).toEqual([0n, undefined]);
        await budget.authorize(built.signed, built.id, [box], () => {});
        const spent = budget.spent();
        expect(spent > 0n).toBe(true);
        // An exact resubmission reserves nothing more, and is refused where the publisher no longer sends it.
        await expect(budget.authorize(built.signed, built.id, [box], ended)).rejects.toThrow('call ended');
        await budget.authorize(built.signed, built.id, [box], () => {});
        expect(budget.spent()).toBe(spent);
        one = spent;
      } finally { budget.close(); }
      // The publisher sends one transaction to every node at once: two judgements of it at once reserve it once, and
      // both pass (audit 32).
      const both = new SpendBudget({ config: { spendBudgetNanoErg: '1000000000' }, file: name => join(dir, 'both-' + name) }, tree);
      try {
        await Promise.all([both.authorize(built.signed, built.id, [box], () => {}), both.authorize(built.signed, built.id, [box], () => {})]);
        expect([both.spent(), both.take()]).toEqual([one, undefined]);
      } finally { both.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reads a publication file of exactly its fields, at kind 4 only', () => {
    const file = { schema: 'moe-publication-1', venue: '01'.repeat(32), backing: '02'.repeat(32), kind: '4', subject: '02'.repeat(32), record: 'abcd' };
    expect(parsePublicationFile(file).record).toEqual(new Uint8Array([0xab, 0xcd]));
    for (const bad of [{ ...file, kind: '1' }, { ...file, extra: '1' }, { ...file, venue: '01'.repeat(31) }, { ...file, record: 'ABCD' },
      { ...file, schema: 'other' }, [file], null]) {
      expect(() => parsePublicationFile(bad)).toThrow(expect.objectContaining({ code: 'INVALID' }));
    }
  });
});

describe('moe reader kept replay file', () => {
  /** A kept file in `dir` whose answers were read through index 10, vouched for by its digest as a keep point records it. */
  const keptThrough10 = dir => {
    const path = join(dir, 'replay.db'), store = new ReplayStore(path, { digest: join(dir, 'replay.db.sha256') });
    store.keepAnswer(1, new Uint8Array(32).fill(1), () => ({ through: 10n, value: 3n }));
    store.close();
    writeFileSync(join(dir, 'replay.db.sha256'), keptFileDigest(path));
  };
  const directory = dir => ({ path: dir, file: name => join(dir, name) });
  it('keeps what earlier reads kept at the view\'s own index or later, and discards it below (a restored view) or under a wrong digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moe-reader-'));
    try {
      keptThrough10(dir);
      for (const at of [10n, 11n]) {
        const store = keptReplay(directory(dir), at);
        try { expect(store.kept).toBe(true); expect(store.answersThrough()).toBe(10n); } finally { store.close(); }
      }
      const behind = keptReplay(directory(dir), 9n);
      try { expect(behind.answersThrough()).toBeUndefined(); } finally { behind.close(); }
      keptThrough10(dir);
      writeFileSync(join(dir, 'replay.db.sha256'), '00'.repeat(32));
      const tampered = keptReplay(directory(dir), 10n);
      try { expect(tampered.answersThrough()).toBeUndefined(); } finally { tampered.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses an evidence file of another layout by code, never as an uncoded failure (Next 4 (m))', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moe-reader-'));
    try {
      const db = new DatabaseSync(join(dir, 'evidence.db')); db.exec('PRAGMA user_version = 999'); db.close();
      let refused;
      try { openEvidence({ file: name => join(dir, name), construction: POOL_V3 }).close(); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(CommandError);
      expect(refused.code).toBe('STORAGE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('moe constructions (slice 14 M14g4)', () => {
  const profile = ownErgoProfile({ reference: ERGO_SYNTHETIC_REFERENCE, anchor: new Uint8Array(32).fill(5), depth: 2n, scripts: SYNTHETIC_SCRIPTS });
  const venue = parseVenue(JSON.parse(venueText(profile, 900_002n)));
  const obligor = new Uint8Array(32).fill(41), operator = ed25519.getPublicKey(new Uint8Array(32).fill(7));
  const fields = { obligor: ed25519.getPublicKey(obligor), operator, venue: venue.id, interval: 80n, payout: { thing: 'units', quantumExponent: 0, perUnit: 1n } };
  const signed = (codec, terms) => ({ terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), obligor), backing: codec.rootTermsName(terms) });
  const code = run => { try { run(); } catch (error) { expect(error).toBeInstanceOf(CommandError); return error.code; } return undefined; };
  it('authenticates terms under the directory\'s construction and refuses the other construction\'s by name', () => {
    const lit = signed(LIT_TERMS, encodeLitTerms({ ...fields, configuration: litConfigHash(), silence: { noCommitmentDuration: 16n } }));
    const pool = signed(V3_TERMS, encodeRootTerms({ ...fields, configuration: adoptedDomain() }));
    const kept = authenticate(lit.terms, lit.signature, lit.backing, venue, true, LIT);
    expect(kept.terms.silence).toEqual({ noCommitmentDuration: 16n });
    expect(explain(kept, venue, LIT)).toMatchObject({ construction: 'moe/lit/v1' });
    expect(authenticate(pool.terms, pool.signature, pool.backing, venue, true, POOL_V3).backing).toEqual(pool.backing);
    expect(code(() => authenticate(pool.terms, pool.signature, pool.backing, venue, true, LIT))).toBe('CONSTRUCTION');
    expect(code(() => authenticate(lit.terms, lit.signature, lit.backing, venue, true, POOL_V3))).toBe('CONSTRUCTION');
    expect(code(() => authenticate(new Uint8Array(40), lit.signature, lit.backing, venue, true, LIT))).toBe('INVALID');
    // Lit's frame naming pool-v3's configuration: its construction, but not its configuration.
    const crossed = signed(LIT_TERMS, encodeLitTerms({ ...fields, configuration: adoptedDomain() }));
    expect(code(() => authenticate(crossed.terms, crossed.signature, crossed.backing, venue, true, LIT))).toBe('CONFIGURATION');
  });
  it('reads a publication under the construction whose frame it decodes in, refusing another configuration and either frame\'s garbage', () => {
    const acceptance = { domain: litConfigHash(), demand: new Uint8Array(32).fill(3), owner: ed25519.getPublicKey(new Uint8Array(32).fill(9)), deadline: 70n,
      signature: new Uint8Array(64).fill(1), ownerSignature: new Uint8Array(64).fill(4) };
    const backing = new Uint8Array(32).fill(2);
    expect(readPublication(encodeLitPublication({ domain: litConfigHash(), backing, kind: 2, acceptance }))).toEqual({ backing, instant: undefined });
    const zero = new Uint8Array(32);
    expect(code(() => readPublication(encodeLitPublication({ domain: zero, backing, kind: 2, acceptance: { ...acceptance, domain: zero } })))).toBe('CONFIGURATION');
    expect(code(() => readPublication(new Uint8Array(64)))).toBe('INVALID');
  });
  it('reads a demand publication\'s instant, which the relay\'s EARLY check compares, under either construction', () => {
    const backing = new Uint8Array(32).fill(2), ownerSecret = new Uint8Array(32).fill(6), presenter = ed25519.getPublicKey(new Uint8Array(32).fill(5));
    const opening = { backing, value: 5n, owner: ed25519.getPublicKey(ownerSecret), rho: new Uint8Array(32).fill(8) };
    const lit = LIT.wallet.demand(litConfigHash(), new Uint8Array(32).fill(4), [{ opening, secret: ownerSecret }], presenter, 31n, 90n);
    expect(readPublication(LIT.wallet.publication(litConfigHash(), backing, { kind: 1, record: lit }))).toEqual({ backing, instant: 31n });
    const domain = adoptedDomain(), prefix = [...limbsOf(domain), ...limbsOf(new Uint8Array(32).fill(4)), 77n];
    const pool = decodeRecord(encodeRecord({ domain, kind: 4, publicInputs: [...prefix, ...limbsOf(backing), 5n, EMPTY_NOTE_ROOT, 0n, tagOf(101n), 0n,
      ...limbsOf(presenter), 47n, 90n], proof: new Uint8Array(32).fill(9), authorization: new Uint8Array(), capsules: [] }));
    expect(readPublication(encodePoolPublication({ domain, backing, kind: 1, record: pool }))).toEqual({ backing, instant: 47n });
  });
  it('keeps one construction per directory, refusing a name it does not know', () => {
    // openDirectory holds lock.db until the process exits, which Windows will not let a removal pass.
    const remove = path => { try { rmSync(path, { recursive: true, force: true }); } catch (error) { if (process.platform !== 'win32') throw error; } };
    const dir = mkdtempSync(join(tmpdir(), 'moe-construction-'));
    try {
      const config = construction => writeFileSync(join(dir, 'config.json'), JSON.stringify({ role: 'reader', nodes: ['http://127.0.0.1:1'], ...construction }));
      config({ construction: 'moe/lit/v1' });
      expect(openDirectory(dir, 'reader').construction).toBe(LIT);
    } finally { remove(dir); }
    const other = mkdtempSync(join(tmpdir(), 'moe-construction-'));
    try {
      writeFileSync(join(other, 'config.json'), JSON.stringify({ role: 'reader', nodes: ['http://127.0.0.1:1'] }));
      expect(openDirectory(other, 'reader').construction).toBe(POOL_V3);
    } finally { remove(other); }
    const bad = mkdtempSync(join(tmpdir(), 'moe-construction-'));
    try {
      writeFileSync(join(bad, 'config.json'), JSON.stringify({ role: 'reader', nodes: ['http://127.0.0.1:1'], construction: 'moe/lit/v2' }));
      expect(code(() => openDirectory(bad, 'reader'))).toBe('INVALID');
    } finally { remove(bad); }
  });
});

describe('moe succinct reads (slice 38)', () => {
  const remove = path => { try { rmSync(path, { recursive: true, force: true }); } catch (error) { if (process.platform !== 'win32') throw error; } };
  const usage = run => { try { run(); } catch (error) { expect(error).toBeInstanceOf(UsageError); return error.message; } return undefined; };
  const code = run => { try { run(); } catch (error) { expect(error).toBeInstanceOf(CommandError); return error.code; } return undefined; };
  const refusal = async run => { try { await run(); } catch (error) { return error instanceof UsageError ? 'USAGE' : error.code; } return undefined; };
  it('serves no replica from a succinct reader directory, takes --parameters only with --prove, and keeps a backer complete', async () => {
    // A directory opened here stays locked by this process until it exits: each refusal opens a directory of its own.
    for (const [args, refused] of [[['--parameters', tmpdir()], 'USAGE'], [[], 'SUCCINCT'], [['--prove'], 'SUCCINCT']]) {
      const dir = mkdtempSync(join(tmpdir(), 'moe-succinct-serve-'));
      try {
        writeFileSync(join(dir, 'config.json'), JSON.stringify({ role: 'reader', nodes: ['http://127.0.0.1:1'], read: 'succinct' }));
        expect(await refusal(() => reader(['serve', '--dir', dir, ...args]))).toBe(refused);
      } finally { remove(dir); }
    }
    // Refused before anything is created: the directory is never made.
    const backer = join(tmpdir(), `moe-succinct-backer-${process.pid}-${Date.now()}`);
    expect(await refusal(() => wallet(['init', '--dir', backer, '--backer', '--read', 'succinct', '--node', 'http://127.0.0.1:1']))).toBe('USAGE');
    expect(await refusal(() => wallet(['restore-seed', '--dir', backer, '--venue', join(tmpdir(), 'none.json'), '--node', 'http://127.0.0.1:1',
      '--read', 'succinct', '--backer-key', join(tmpdir(), 'none.key')]))).toBe('USAGE');
    expect(existsSync(backer)).toBe(false);
  });
  it('takes --read complete or succinct at init, succinct only for pool-v3', () => {
    const args = read => parseArguments(read === undefined ? [] : ['--read', read], { read: 'value' }, 0);
    expect(initRead(args(undefined), 'moe/pool/v3')).toBe(false);
    expect(initRead(args('complete'), 'moe/lit/v1')).toBe(false);
    expect(initRead(args('succinct'), 'moe/pool/v3')).toBe(true);
    expect(usage(() => initRead(args('succinct'), 'moe/lit/v1'))).toMatch(/reads completely/);
    expect(usage(() => initRead(args('fast'), 'moe/pool/v3'))).toMatch(/complete or succinct/);
  });
  it('keeps the read in config.json for a pool-v3 wallet or reader, refusing it elsewhere, and keeps a succinct evidence file apart', () => {
    for (const [config, accepted] of [[{ role: 'reader', read: 'succinct' }, true], [{ role: 'wallet', read: 'succinct' }, true],
      [{ role: 'operator', read: 'succinct' }, false], [{ role: 'reader', read: 'succinct', construction: 'moe/lit/v1' }, false],
      [{ role: 'reader', read: 'complete' }, false]]) {
      const dir = mkdtempSync(join(tmpdir(), 'moe-succinct-'));
      try {
        writeFileSync(join(dir, 'config.json'), JSON.stringify({ nodes: ['http://127.0.0.1:1'], ...config }));
        if (!accepted) { expect(code(() => openDirectory(dir, config.role))).toBe('INVALID'); continue; }
        const directory = openDirectory(dir, config.role);
        expect(directory.succinct).toBe(true);
        if (config.role !== 'reader') continue;
        const construction = succinctPoolV3({ set: testCheckSet('cli'), supply: { cover: () => undefined, proof: () => undefined } });
        openEvidence(directory, false, construction).close();
        expect(readdirSync(dir)).toContain('succinct-evidence.db');
        expect(readdirSync(dir)).not.toContain('evidence.db');
      } finally { remove(dir); }
    }
  });
});

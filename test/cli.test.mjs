import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { CommandError, integer, hex32, openDirectory, parseArguments, UsageError, writeExclusive, writeReplace, writeSame } from '../src/cli/common.js';
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
import { outside } from '../src/cli/wallet.js';
import { parsePublicationFile, readPublication } from '../src/cli/relay.js';
import { keptReplay, openEvidence } from '../src/cli/reader.js';
import { keptFileDigest, ReplayStore } from '../src/pool/v3/replay-store.js';
import { keepAliveDue, servePollsOn } from '../src/cli/operator.js';
import { closeListener, listenLoopback, SERVE_FLAGS, serveFlags } from '../src/cli/serve.js';
import { V3StoreError } from '../src/pool/v3/store.js';
import { parseVenue, publisherStore, venueText } from '../src/cli/venue.js';
import { ERGO_SYNTHETIC_REFERENCE, ownErgoProfile } from '../src/ergo-profile.js';
import { SYNTHETIC_SCRIPTS } from '../src/ergo-synthetic.js';

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
  });
  it('takes decimal integers in range and lowercase 32-byte hex only', () => {
    expect(integer('12', 'n')).toBe(12n);
    for (const bad of ['', '-1', '012', '1e3', ' 1', '0x10']) expect(() => integer(bad, 'n')).toThrow(UsageError);
    expect(() => integer('7', 'n', 1n, 6n)).toThrow('out of range');
    expect(hex32('ab'.repeat(32), 'h')).toHaveLength(32);
    for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33)]) expect(() => hex32(bad, 'h')).toThrow(UsageError);
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
      expect(() => b.persistence.save('second')).toThrow(/another publisher/);
      expect(() => b.persistence.guard()).toThrow(/another publisher/);
      a.persistence.guard();
      a.close(); b.close();
      const c = publisherStore(join(dir, 'relay.db'));
      expect(c.persistence.load()).toBe('first');
      c.close();
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

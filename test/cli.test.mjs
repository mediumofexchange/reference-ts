import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandError, integer, hex32, parseArguments, UsageError, writeExclusive, writeReplace, writeSame } from '../src/cli/common.js';
import { outside } from '../src/cli/wallet.js';
import { parsePublicationFile } from '../src/cli/relay.js';
import { keepAliveDue, servePollsOn } from '../src/cli/operator.js';
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

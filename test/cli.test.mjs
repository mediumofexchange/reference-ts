import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandError, integer, hex32, parseArguments, UsageError, writeExclusive, writeReplace } from '../src/cli/common.js';
import { keepAliveDue, servePollsOn } from '../src/cli/operator.js';
import { V3StoreError } from '../src/pool/v3/store.js';
import { parseVenue, venueText } from '../src/cli/venue.js';
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

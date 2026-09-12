import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

export const SQLITE_SIDECARS = Object.freeze(['-wal', '-shm', '-journal']);
const WINDOWS = process.platform === 'win32';
const key = value => WINDOWS ? value.toLowerCase() : value;
const fail = message => { const error = new Error(message); error.code = 'INVALID_PATHS'; throw error; };
const absolute = value => {
  if (typeof value !== 'string' || value.trim() === '') fail('path is required');
  const resolved = resolve(value);
  if (WINDOWS) {
    const parts = resolved.split('\\');
    if (parts.some((part, index) => /[. ]$/.test(part) ||
      (part.includes(':') && !(index === 0 && /^[a-z]:$/i.test(part))))) fail('unsafe Windows path');
  }
  return resolved;
};

function existing(path) {
  try { return lstatSync(path, { bigint: true }); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined; throw error; }
}

/** Resolve an existing target physically, or resolve its nearest existing ancestor physically. */
function canonical(path) {
  let cursor = path, tail = [];
  while (existing(cursor) === undefined) {
    const parent = dirname(cursor); if (parent === cursor) break;
    tail.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))); cursor = parent;
  }
  try { return resolve(realpathSync(cursor), ...tail); }
  catch { fail(`cannot resolve path ancestor: ${path}`); }
}

function identity(path) {
  const lexical = absolute(path), stat = existing(lexical);
  if (stat?.isDirectory()) fail(`file path is an existing directory: ${path}`);
  const physical = canonical(lexical), physicalStat = existing(physical);
  if (physicalStat?.isDirectory()) fail(`file path resolves to an existing directory: ${path}`);
  const ids = new Set([key(lexical), key(physical)]);
  if (stat && physicalStat && typeof stat.dev === 'bigint' && typeof stat.ino === 'bigint' &&
      typeof physicalStat.dev === 'bigint' && typeof physicalStat.ino === 'bigint') {
    ids.add(`inode:${stat.dev}:${stat.ino}`); ids.add(`inode:${physicalStat.dev}:${physicalStat.ino}`);
  }
  return { lexical, physical, ids };
}

function add(label, item, all) {
  for (const id of item.ids) {
    const prior = all.get(id); if (prior !== undefined && prior !== label) fail(`${label} collides with ${prior}`);
  }
  for (const id of item.ids) all.set(id, label);
}

/** Validate local file paths before opening proof, wallet or operator state. */
export function assertLocalPaths(database, profileFile, ledgerFile, evidenceFile) {
  return assertWalletPaths(database, { profileFile, ledgerFile, evidenceFile });
}

/** Wallet custody files must also be distinct from every database sidecar. */
export function assertWalletPaths(database, files) {
  const values = { database: identity(database), ...Object.fromEntries(Object.entries(files).map(([name, path]) => [name, identity(path)])) };
  const all = new Map();
  add('database', values.database, all);
  for (const suffix of SQLITE_SIDECARS) {
    const lexicalSidecar = identity(values.database.lexical + suffix);
    add(`database${suffix}`, lexicalSidecar, all);
    if (values.database.physical !== values.database.lexical) add(`database${suffix}`, identity(values.database.physical + suffix), all);
  }
  for (const name of Object.keys(files)) add(name, values[name], all);
  return Object.freeze(Object.fromEntries(Object.entries(values).map(([name, item]) => [name, item.lexical])));
}

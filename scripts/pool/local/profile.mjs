import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { decodeBacking, encodeBacking, verifyBackingSignature } from '@mediumofexchange/reference/backing';
import { EncodingError } from '@mediumofexchange/reference/bytes';
import { LocalVenue } from '@mediumofexchange/reference/venue';
import { PoolAuthorityView } from '@mediumofexchange/reference/pool/authority';
import { configurationHash, decodeSegmentHeader, segmentAuthority, segmentBytes } from '@mediumofexchange/reference/pool/statement';
import { pinnedConfiguration } from '../wallet/pins.mjs';

export const LOCAL_PROFILE = 'pool-local/v2';
export const MAX_LOCAL_PROFILE_BYTES = 128 * 1024;

const invalid = message => { throw new EncodingError(message); };
const hex = (value, label, length = 32) => {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) invalid(`invalid ${label}`);
  return hexToBytes(value);
};
const hexAny = (value, label) => {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) invalid(`invalid ${label}`);
  return hexToBytes(value);
};

function parseProfile(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_LOCAL_PROFILE_BYTES) invalid('profile is too large');
  let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { invalid('profile is not valid UTF-8'); }
  let value; try { value = JSON.parse(text); } catch { invalid('profile is not valid JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('profile must be an object');
  const keys = Object.keys(value); if (keys.join(',') !== 'version,profile,backing,signature,header') invalid('invalid profile fields');
  if (JSON.stringify(value) !== text) invalid('profile JSON is not canonical');
  if (value.version !== 1 || value.profile !== LOCAL_PROFILE) invalid('wrong local profile');
  const backingBytes = hexAny(value.backing, 'backing');
  const signature = hex(value.signature, 'backing signature', 64);
  if (typeof value.header !== 'string' || value.header.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value.header)) invalid('invalid segment header');
  const headerBytes = hexToBytes(value.header);
  let backing, header; try { backing = decodeBacking(backingBytes); header = decodeSegmentHeader(headerBytes); } catch { invalid('noncanonical profile terms'); }
  if (bytesToHex(encodeBacking(backing)) !== value.backing || bytesToHex(segmentBytes(header)) !== value.header) invalid('profile terms are not canonical');
  if (!verifyBackingSignature(backing, signature)) invalid('backing signature is invalid');
  if (backing.evidence.setting !== 'pool' || backing.evidence.witnessing === undefined || backing.evidence.silence !== undefined || backing.evidence.nonService !== undefined || backing.reliance.length !== 0 || 'backing' in backing.payout) invalid('unsupported backing terms');
  const config = pinnedConfiguration(), domain = configurationHash(config);
  if (bytesToHex(header.domain) !== bytesToHex(domain) || bytesToHex(header.venue) !== bytesToHex(backing.evidence.witnessing.venue) || header.sequence !== 1n || header.entries.length !== 1 || bytesToHex(header.entries[0].backing) !== bytesToHex(backing.name) || bytesToHex(header.entries[0].link) !== bytesToHex(backing.name) || header.entries[0].opening !== undefined || bytesToHex(header.operator) !== bytesToHex(backing.evidence.operator)) invalid('profile authority does not match terms');
  const terms = { backing, signature };
  try { if (!new PoolAuthorityView(config, new LocalVenue(header.venue), [terms]).authorizes(header)) invalid('profile authority is invalid'); } catch { invalid('profile authority is invalid'); }
  return { CONFIG: config, DOMAIN: domain, VENUE: new LocalVenue(header.venue).id, TERMS: terms, HEADER: header, AUTHORITY: segmentAuthority(header) };
}

export function decodeLocalProfile(bytes, digest) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_LOCAL_PROFILE_BYTES) invalid('profile is too large');
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || createHash('sha256').update(bytes).digest('hex') !== digest) invalid('profile digest mismatch');
  return parseProfile(bytes);
}

export function readLocalProfile(path, trustedDigest) {
  if (typeof path !== 'string' || path.trim() === '') invalid('invalid profile path');
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd), size = stat.size;
    if (!stat.isFile() || !Number.isSafeInteger(size) || size > MAX_LOCAL_PROFILE_BYTES) invalid('profile is too large or not a file');
    const bytes = new Uint8Array(size); let offset = 0;
    while (offset < size) {
      const n = readSync(fd, bytes, offset, size - offset, offset);
      if (n === 0) invalid('profile read was truncated'); offset += n;
    }
    if (readSync(fd, new Uint8Array(1), 0, 1, size) !== 0) invalid('profile grew while reading');
    return decodeLocalProfile(bytes, trustedDigest);
  } finally { closeSync(fd); }
}

export function encodeLocalProfile(terms, header) {
  if (!terms || !header) invalid('profile terms and header are required');
  const backing = decodeBacking(encodeBacking(terms.backing)), signature = hex(bytesToHex(terms.signature), 'backing signature', 64), decodedHeader = decodeSegmentHeader(segmentBytes(header));
  const value = { version: 1, profile: LOCAL_PROFILE, backing: bytesToHex(encodeBacking(backing)), signature: bytesToHex(signature), header: bytesToHex(segmentBytes(decodedHeader)) };
  return JSON.stringify(value);
}

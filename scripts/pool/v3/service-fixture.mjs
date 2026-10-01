// Public synthetic context only. Signing keys and note-generation seeds stay in
// the server fixture; the receiver creates its own SQLite seed in its process.
import { readFileSync, writeFileSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { hexToBytes } from '@noble/hashes/utils.js';
import { adoptedConfiguration, adoptedDomain } from '../../../dist/pool/v3/configuration.js';
import { encodeRootTerms, rootTermsName } from '../../../dist/pool/v3/terms.js';
import { FixtureVenue, LOCAL_REFERENCE } from '../../../dist/record-venue.js';

export const fill = n => new Uint8Array(32).fill(n);
export const configuration = adoptedConfiguration();
export const domain = adoptedDomain();
export const issuer = hexToBytes('d9bf2148748a85c89da5aad8ee0b0fc2d105fd39d41a4c796536354f0ae2900c');
export const operator = hexToBytes('5c9c6df261c9cb840475776aaefcd944b405328fab28f9b3a95ef40490d3de84');
export const reference = { context: LOCAL_REFERENCE, label: fill(12), lag: 2n };
export const venueId = FixtureVenue.reference(reference.label, reference.lag).id;
export const terms = encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venueId, interval: 20n,
  payout: { thing: 'service fixture units', quantumExponent: 0, perUnit: 1n } });
export const backing = rootTermsName(terms);
export const verifier = { verify: (kind, _inputs, proof) => proof[0] === kind };
export const WALLET = '11'.repeat(32), ADMIN = '22'.repeat(32);
export const save = (path, value) => writeFileSync(path, serialize(value));
export const load = path => deserialize(readFileSync(path));

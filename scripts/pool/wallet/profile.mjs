// Public fixture terms. Real mode pins the existing v2 configuration, not a
// verifier or key supplied by a payment. No fixture key is for live funds.
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { makeBacking, signBacking } from '@mediumofexchange/reference/backing';
import { configurationHash, segmentAuthority } from '@mediumofexchange/reference/pool/statement';
import * as ideal from '../service/fixture.mjs';

export const pins = JSON.parse(readFileSync(new URL('../../../src/pool/circuits/manifest.json', import.meta.url), 'utf8'));
export const BACKER_SECRET = new Uint8Array(32).fill(1);
export function walletProfile(real = false) {
  const CONFIG = real ? { ...Object.fromEntries(Object.entries(pins.circuits).map(([kind, identity]) =>
    [kind, { bytecode: Buffer.from(identity.bytecode, 'hex'), vk: Buffer.from(identity.vk, 'hex') }])),
    helper: Buffer.from(pins.sources['vendor/poseidon2.nr'], 'hex') } : ideal.CONFIG;
  const DOMAIN = configurationHash(CONFIG), { VENUE, OPERATOR, OPERATOR_SECRET, WALLET, ADMIN } = ideal;
  const backing = makeBacking({ obligor: ed25519.getPublicKey(BACKER_SECRET),
    payout: { thing: 'EUR', quantumExponent: -2, perUnit: 100n }, reliance: [],
    evidence: { setting: 'pool', operator: OPERATOR, construction: 'moe/pool/v2', configuration: DOMAIN,
      witnessing: { venue: VENUE, interval: 1n }, replacementRule: ed25519.getPublicKey(BACKER_SECRET) } });
  const TERMS = { backing, signature: signBacking(BACKER_SECRET, backing) };
  const HEADER = { domain: DOMAIN, venue: VENUE, operator: OPERATOR, sequence: 1n,
    entries: [{ backing: backing.name, link: backing.name }] };
  return { CONFIG, DOMAIN, VENUE, OPERATOR_SECRET, WALLET, ADMIN, TERMS, HEADER, AUTHORITY: segmentAuthority(HEADER) };
}

// PUBLIC TEST KEYS AND IDEAL PROOFS ONLY. This fixture exercises transport,
// durability and authentication boundaries; it supplies no proof-system or
// external-venue evidence and must never be used as a live service configuration.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { makeBacking, signBacking } from '@mediumofexchange/reference/backing';
import { limbsOf } from '@mediumofexchange/reference/pool/field';
import { configurationHash, ISSUE, segmentAuthority, statementBytes } from '@mediumofexchange/reference/pool/statement';

const fill = byte => new Uint8Array(32).fill(byte);
export const CONFIG = Object.freeze({ issue: { bytecode: fill(0x11), vk: fill(0x12) },
  spend: { bytecode: fill(0x13), vk: fill(0x14) }, burn: { bytecode: fill(0x15), vk: fill(0x16) }, helper: fill(0x17) });
export const DOMAIN = configurationHash(CONFIG), VENUE = fill(0x33);
export const OPERATOR_SECRET = fill(7), OPERATOR = ed25519.getPublicKey(OPERATOR_SECRET);
const BACKER_SECRET = fill(1), BACKER = ed25519.getPublicKey(BACKER_SECRET);
export const WALLET = '11'.repeat(32), ADMIN = '22'.repeat(32);
const backing = makeBacking({ obligor: BACKER,
  payout: { thing: 'EUR', quantumExponent: -2, perUnit: 100n }, reliance: [],
  evidence: { setting: 'pool', operator: OPERATOR, construction: 'moe/pool/v2', configuration: DOMAIN,
    witnessing: { venue: VENUE, interval: 1n }, replacementRule: BACKER } });
export const TERMS = { backing, signature: signBacking(BACKER_SECRET, backing) };
// Pinned independently in the client: never trust authority asserted in a reply.
export const AUTHORITY = segmentAuthority({ domain: DOMAIN, venue: VENUE, operator: OPERATOR, sequence: 1n,
  entries: [{ backing: backing.name, link: backing.name }] });
export function issue(output = 101n) {
  const publicInputs = [...limbsOf(DOMAIN), ...limbsOf(AUTHORITY.segment), AUTHORITY.scopeRoot,
    ...limbsOf(backing.name), 10n, output];
  const message = statementBytes(DOMAIN, ISSUE, publicInputs);
  return { kind: ISSUE, publicInputs, proof: sha256(message), obligorSignature: ed25519.sign(message, BACKER_SECRET) };
}
export class IdealVerifier {
  async verify(kind, inputs, proof) {
    return bytesToHex(proof) === bytesToHex(sha256(statementBytes(DOMAIN, kind, inputs)));
  }
}

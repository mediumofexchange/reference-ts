// Fixed real v2 artifacts; no fixture keys, credentials or ideal verifier.
import { readFileSync } from 'node:fs';
export const pins = JSON.parse(readFileSync(new URL('../../../src/pool/circuits/manifest.json', import.meta.url), 'utf8'));
export function pinnedConfiguration() {
  return { ...Object.fromEntries(Object.entries(pins.circuits).map(([kind, identity]) =>
    [kind, { bytecode: Buffer.from(identity.bytecode, 'hex'), vk: Buffer.from(identity.vk, 'hex') }])),
    helper: Buffer.from(pins.sources['vendor/poseidon2.nr'], 'hex') };
}

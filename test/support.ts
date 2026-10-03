import { ed25519 } from "@noble/curves/ed25519.js";

// Shared keys for the Ergo venue tests: real Ed25519 points, a distinct secret
// per role.

export const SECRETS = {
  backer: new Uint8Array(32).fill(0x01),
  backer2: new Uint8Array(32).fill(0x02),
  alice: new Uint8Array(32).fill(0x03),
  bob: new Uint8Array(32).fill(0x04),
  carol: new Uint8Array(32).fill(0x05),
  mallory: new Uint8Array(32).fill(0x06),
  operator: new Uint8Array(32).fill(0x07),
} as const;

export function pub(secret: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secret);
}

export const KEYS = {
  backer: pub(SECRETS.backer),
  backer2: pub(SECRETS.backer2),
  alice: pub(SECRETS.alice),
  bob: pub(SECRETS.bob),
  carol: pub(SECRETS.carol),
  mallory: pub(SECRETS.mallory),
  operator: pub(SECRETS.operator),
} as const;

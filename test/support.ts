import { ed25519 } from "@noble/curves/ed25519.js";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { keptFileDigest } from "../src/pool/v3/replay-store.js";

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

/** A closed kept file (pool-v3 §14) left as a keep point stopped after its commit leaves it: the file as it was, its
 * identity kept, beside a write-ahead log holding the commit `write` makes. With `recorded`, the stop came after the
 * keep point recorded that commit's digest and before it moved the log in; without it, before the digest, which stays
 * the old one (Next 4 (bb)). */
export function stoppedKeepPoint(path: string, digest: string, write: string, recorded: boolean): void {
  const before = readFileSync(path), writer = new DatabaseSync(path);
  let log: Buffer;
  try { writer.exec(`PRAGMA wal_autocheckpoint=0; ${write}`); log = readFileSync(`${path}-wal`); } finally { writer.close(); }
  // Closing moved the log in: the file gives the commit's state, the digest such a keep point records.
  if (recorded) writeFileSync(digest, keptFileDigest(path)!);
  // Written in place, so the file keeps the identity its digest names.
  writeFileSync(path, before); writeFileSync(`${path}-wal`, log); rmSync(`${path}-shm`, { force: true });
}

/** Every item of a sync or async iterable, in order. */
export async function collected<T>(items: Iterable<T> | AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { signBacking } from "../src/backing.js";
import { ByteWriter, EncodingError } from "../src/bytes.js";
import {
  compactState, committedLogFor, directoryOf, directoryRoot, signCommitment,
  stateProvesCommitment, stateRoot, verifyCommitment,
  type BackingSnapshot, type ServedState, type SnapshotDigest,
} from "../src/commitment.js";
import { encodeIssuance } from "../src/messages.js";
import { committedOutstanding } from "../src/recovery.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, makeTransparentBacking, SECRETS } from "./support.js";

function setup() {
  const venue = new LocalVenue();
  const sequencer = new Sequencer(SECRETS.operator, venue);
  const a = makeTransparentBacking(SECRETS.backer, "EUR");
  const b = makeTransparentBacking(SECRETS.backer, "USD");
  const absent = makeTransparentBacking(SECRETS.backer, "GBP");
  for (const backing of [a, b]) {
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    const issue = { backing, recipient: KEYS.alice, quantity: 8n, nonce: 0n };
    sequencer.submitIssue(issue, ed25519.sign(encodeIssuance(issue), SECRETS.backer));
  }
  const full = sequencer.commit();
  return { full, venue, a, b, absent };
}

function proves(served: ServedState): boolean {
  return stateProvesCommitment(served.snapshots, served.commitment, served.directory);
}

describe("transparent commitment directory v1", () => {
  it("matches the specified fixed framing and canonical unsigned name order", () => {
    const low = { name: new Uint8Array(32).fill(0x7f), digest: new Uint8Array(32).fill(1) };
    const high = { name: new Uint8Array(32).fill(0x80), digest: new Uint8Array(32).fill(2) };
    const bytes = Buffer.concat([
      Buffer.from("4d4f45440100000002", "hex"), low.name, low.digest, high.name, high.digest,
    ]);
    expect(directoryRoot([low, high])).toEqual(sha256(bytes));
    expect(directoryRoot([])).toEqual(sha256(Buffer.from("4d4f45440100000000", "hex")));
    expect(() => directoryRoot([high, low])).toThrow(EncodingError);
    expect(() => directoryRoot([low, low])).toThrow(EncodingError);
    expect(() => directoryRoot([{ ...low, name: new Uint8Array(31) }])).toThrow(EncodingError);
    expect(() => directoryRoot([{ ...low, digest: new Uint8Array(33) }])).toThrow(EncodingError);
  });

  it("binds names even when snapshot digests are unchanged", () => {
    const entry = { name: new Uint8Array(32).fill(1), digest: new Uint8Array(32).fill(3) };
    expect(directoryRoot([entry])).not.toEqual(directoryRoot([{ ...entry, name: new Uint8Array(32).fill(2) }]));
  });

  it("proves a relevant log without serving unrelated histories", () => {
    const { full, a, b, venue } = setup();
    const compact = compactState(full, [a.name]);
    expect(compact.snapshots).toHaveLength(1);
    expect(compact.directory).toHaveLength(2);
    expect(proves(full)).toBe(true);
    expect(proves(compact)).toBe(true);
    expect(stateRoot([...full.snapshots].reverse())).toEqual(full.commitment.root);
    expect(directoryRoot(directoryOf(full.snapshots))).toEqual(full.commitment.root);
    expect(committedLogFor(a, venue, compact)?.kind).toBe("log");
    expect(committedOutstanding(a, venue, compact)).toBe(8n);
    expect(committedOutstanding(b, venue, compact)).toBeUndefined();
    expect(proves(compactState(compact, [a.name]))).toBe(true);
  });

  it("distinguishes authenticated absence from a withheld log", () => {
    const { full, a, b, absent, venue } = setup();
    const compact = compactState(full, [a.name]);
    expect(committedLogFor(b, venue, compact)).toBeUndefined();
    expect(committedLogFor(absent, venue, compact)).toEqual({ kind: "dropped", sequence: full.commitment.sequence });
    const onlyDirectory = compactState(full, []);
    expect(proves(onlyDirectory)).toBe(true);
    expect(committedLogFor(a, venue, onlyDirectory)).toBeUndefined();
    expect(committedLogFor(absent, venue, onlyDirectory)?.kind).toBe("dropped");
  });

  it("rejects tampered, incomplete, reordered and duplicate directories", () => {
    const { full, a } = setup();
    const compact = compactState(full, [a.name]);
    const directory = compact.directory!;
    const first = directory[0]!;
    const second = directory[1]!;
    const variants: readonly SnapshotDigest[][] = [
      [], [first], [second, first], [first, first, second],
      [{ ...first, digest: new Uint8Array(32) }, second],
      [{ ...first, name: new Uint8Array(32) }, second],
      [{ ...first, digest: new Uint8Array(31) }, second],
    ];
    for (const invalid of variants) expect(proves({ ...compact, directory: invalid })).toBe(false);
    // No directory means the supplied snapshots claim to be the complete set.
    expect(stateProvesCommitment(compact.snapshots, compact.commitment)).toBe(false);
  });

  it("rejects duplicate, altered or unlisted snapshots and wrong commitments", () => {
    const { full, a, absent } = setup();
    const compact = compactState(full, [a.name]);
    const snapshot = compact.snapshots[0]!;
    const duplicate = { ...compact, snapshots: [snapshot, snapshot] };
    expect(proves(duplicate)).toBe(false);
    expect(() => compactState(duplicate, [a.name])).toThrow(EncodingError);
    expect(proves({ ...compact, snapshots: [{ ...snapshot, opLog: [] }] })).toBe(false);
    expect(proves({ ...compact, snapshots: [{ ...snapshot, name: absent.name }] })).toBe(false);
    expect(proves({ ...compact, commitment: { ...compact.commitment, signature: new Uint8Array(64) } })).toBe(false);
    expect(proves({ ...compact, commitment: signCommitment(SECRETS.operator, 0n, stateRoot([])) })).toBe(false);
    const gap: BackingSnapshot = { ...snapshot, opLog: snapshot.opLog.map((op) => ({ ...op, position: 1 })) };
    expect(proves({ ...compact, snapshots: [gap] })).toBe(false);
    for (const malformed of [null, undefined, {}, [null]]) {
      expect(stateProvesCommitment(compact.snapshots, compact.commitment, malformed as unknown as SnapshotDigest[])).toBe(false);
    }
    expect(stateProvesCommitment(full.snapshots, full.commitment, null as unknown as SnapshotDigest[])).toBe(false);
  });

  it("copies the directory, selected logs, and commitment in both directions", () => {
    const { full, a } = setup();
    const source = compactState(full, [a.name]);
    const kept = compactState(source, [a.name]);
    const expected = compactState(full, [a.name]);
    source.directory![0]!.name.fill(0);
    source.directory![0]!.digest.fill(0);
    source.snapshots[0]!.name.fill(0);
    const sourceOp = source.snapshots[0]!.opLog[0]!;
    if (sourceOp.kind !== "issue") throw new Error("expected issuance");
    sourceOp.recipient.fill(0);
    sourceOp.signature.fill(0);
    source.commitment.root.fill(0);
    source.commitment.operator.fill(0);
    source.commitment.signature.fill(0);
    expect(kept).toEqual(expected);
    expect(proves(kept)).toBe(true);
    expect(proves(full)).toBe(true);
    const fromFull = directoryOf(full.snapshots);
    fromFull[0]!.name.fill(0);
    expect(proves(full)).toBe(true);
  });

  it("rejects signatures made under the old commitment domain", () => {
    const root = stateRoot([]);
    const old = new ByteWriter();
    old.context(new TextEncoder().encode("moe/commitment/v1"));
    old.u64(0n);
    old.key32(root, "root");
    const legacy = { sequence: 0n, root, operator: KEYS.operator, signature: ed25519.sign(old.finish(), SECRETS.operator) };
    expect(verifyCommitment(legacy)).toBe(false);
    expect(stateProvesCommitment([], legacy)).toBe(false);
    expect(verifyCommitment(signCommitment(SECRETS.operator, 0n, root))).toBe(true);
  });
});

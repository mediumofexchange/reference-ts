import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { limbsOf } from "../src/pool/field.js";
import { encodeReceipt, receiptBytes } from "../src/pool/v3/commitments.js";
import { encodeEvidencePackage } from "../src/pool/v3/package.js";
import { encodeRecord } from "../src/pool/v3/records.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { signCommitment } from "../src/venue-records.js";
import {
  MAX_V3_SERVED_PART_BYTES, V3_SERVICE_PROFILE, parseV3ServiceCommand, decodeV3ServiceReply, readServed,
  replyFromReceipt, replyFromCommitment, servedFrames,
} from "../src/pool/v3/service-wire.js";
import type { EvidencePart } from "../src/pool/v3/evidence-store.js";
import type { ServedEvidence } from "../src/pool/v3/store.js";

// Canonical framing fixtures only: they claim neither proof validity nor finality.
const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const domain = b(1), segment = b(2), secret = b(3), operator = ed25519.getPublicKey(secret);
const command = (fields: Record<string, unknown>) => ({ version: 1, profile: V3_SERVICE_PROFILE, ...fields });
const record = encodeRecord({ domain, kind: 5, publicInputs: [...limbsOf(domain), ...limbsOf(segment), 7n, ...limbsOf(b(4))],
  proof: new Uint8Array(), authorization: new Uint8Array(64), capsules: [] });
const receiptFields = { domain, segment, scopeRoot: 7n, position: 1n, statementHash: b(5), historyHash: b(6),
  proofHash: b(7), signatureHash: b(8), after: 1n };
const receipt = encodeReceipt({ ...receiptFields, operator, signature: ed25519.sign(receiptBytes(receiptFields), secret) });
const own = encodeEvidencePackage([{ kind: 1, payload: b(12) }]);
const tip = { segment, position: 3n, evidence: b(13) };
/** A selection, the read's own package, a package part, a whole trail and a trail after a position. */
const served = (parts: EvidencePart[] = [{ package: encodeEvidencePackage([{ kind: 4, payload: b(14) }]) },
  { trail: { size: 5n, chunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)] } },
  { trail: { after: tip, size: 70_000n, chunks: [new Uint8Array(70_000).fill(6)] } }]): ServedEvidence =>
  ({ selection: { domain, operator, venue: b(9), backing: b(10), root: b(11), sequence: 1n }, package: own, parts });
async function framed(value: ServedEvidence): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of servedFrames(value)) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}
async function* pieces(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}
/** Every part as the receiver was handed it, its trail bytes joined. */
const collect = async (_: unknown, parts: AsyncIterable<EvidencePart>) => {
  const seen: unknown[] = [];
  for await (const part of parts) {
    if ("package" in part) { seen.push(part); continue; }
    const chunks: Uint8Array[] = [];
    for await (const chunk of part.trail.chunks) chunks.push(chunk.slice());
    seen.push({ after: part.trail.after, size: part.trail.size, bytes: new Uint8Array(Buffer.concat(chunks)) });
  }
  return seen;
};

describe("v3 service wire framing", () => {
  it("round trips record, receipt and commitment envelopes", () => {
    const submission = command({ kind: "submit", record: bytesToHex(record) });
    expect(parseV3ServiceCommand(submission)).toEqual(submission);
    for (const reply of [replyFromReceipt(receipt), replyFromCommitment("committed", signCommitment(secret, 1n, b(9))),
      replyFromCommitment("published", signCommitment(secret, 2n, b(10)))]) expect(decodeV3ServiceReply(reply)).toEqual(reply);
  });

  it("round trips served evidence by parts, however the stream is chunked", async () => {
    const bytes = await framed(served());
    for (const size of [1, 7, 65_536, bytes.length]) {
      const read = await readServed(pieces(bytes, size), collect);
      expect(read.served).toEqual({ selection: served().selection, package: own });
      expect(read.taken).toEqual([{ package: encodeEvidencePackage([{ kind: 4, payload: b(14) }]) },
        { after: undefined, size: 5n, bytes: Uint8Array.of(1, 2, 3, 4, 5) },
        { after: tip, size: 70_000n, bytes: new Uint8Array(70_000).fill(6) }]);
    }
    // No parts: the read's own package and the end mark.
    expect((await readServed(pieces(await framed(served([])), 9), collect)).taken).toEqual([]);
  });

  it("skips what a receiver leaves unread of a trail, and requires the stream read to its end", async () => {
    const bytes = await framed(served());
    const kinds = await readServed(pieces(bytes, 4096), async (_, parts) => {
      const seen: string[] = [];
      for await (const part of parts) seen.push("package" in part ? "package" : "trail");
      return seen;
    });
    expect(kinds.taken).toEqual(["package", "trail", "trail"]);
    await expect(readServed(pieces(bytes, 4096), async (_, parts) => { for await (const _part of parts) break; }))
      .rejects.toThrow("served evidence was not read to its end");
    // A refusal of the context comes before any part is read.
    await expect(readServed(pieces(bytes, 4096), async () => { throw new Error("another context"); })).rejects.toThrow("another context");
  });

  it("refuses a served stream that is truncated, extended or framed otherwise", async () => {
    const bytes = await framed(served([{ package: encodeEvidencePackage([]) }, { trail: { after: tip, size: 3n, chunks: [Uint8Array.of(1, 2, 3)] } }]));
    for (let length = 0; length < bytes.length; length++) {
      await expect(readServed(pieces(bytes.subarray(0, length), 64), collect), `${length}`).rejects.toThrow("truncated served evidence");
    }
    expect((await readServed(pieces(bytes, 64), collect)).taken).toHaveLength(2);
    await expect(readServed(pieces(Buffer.concat([bytes, Uint8Array.of(0)]), 64), collect)).rejects.toThrow("trailing served bytes");
    const changed = (at: number, value: number): Uint8Array => { const copy = bytes.slice(); copy[at] = value; return copy; };
    const head = 20 + 172 + own.length;
    await expect(readServed(pieces(changed(0, 0x50), 64), collect)).rejects.toThrow("wrong service profile");
    await expect(readServed(pieces(changed(20 + 135, 0), 64), collect)).rejects.toThrow("invalid service sequence");
    await expect(readServed(pieces(changed(20 + 168, 1), 64), collect)).rejects.toThrow("served package too large");
    await expect(readServed(pieces(changed(head, 3), 64), collect)).rejects.toThrow("unsupported served part");
    await expect(readServed(pieces(changed(head + 1, 1), 64), collect)).rejects.toThrow("served package part too large");
    await expect(readServed(pieces(changed(head + 5 + 23 + 1, 2), 64), collect)).rejects.toThrow("unsupported served part");
    await expect(readServed((async function* () { yield "bytes" as unknown as Uint8Array; })(), collect)).rejects.toThrow("served evidence is not bytes");
  });

  it("refuses to frame a wrong selection, an oversized part or a trail that is not its stated size", async () => {
    await expect(framed({ ...served(), selection: { ...served().selection, sequence: 0n } })).rejects.toThrow("invalid service sequence");
    await expect(framed({ ...served(), selection: { ...served().selection, root: b(1).subarray(1) } })).rejects.toThrow("expected a 32-byte service identity");
    await expect(framed({ ...served(), package: new Uint8Array(65_537) })).rejects.toThrow("served package too large");
    await expect(framed(served([{ package: new Uint8Array(MAX_V3_SERVED_PART_BYTES + 1) }]))).rejects.toThrow("served package part too large");
    for (const size of [2n, 4n]) {
      await expect(framed(served([{ trail: { size, chunks: [Uint8Array.of(1, 2, 3)] } }]))).rejects.toThrow("a served trail is not its stated size");
    }
  });

  it("rejects obsolete profiles, versions, unknown fields and invalid command identifiers", () => {
    for (const [value, reason] of [
      [command({ kind: "publish", extra: true }), "unexpected service fields"],
      [command({ kind: "publish", profile: "pool-store/v2" }), "wrong service profile"],
      [command({ kind: "publish", version: 2 }), "wrong service profile"],
      [command({ kind: "commit", id: "bad id" }), "invalid command id"],
      [command({ kind: "commit", id: "x".repeat(129) }), "invalid command id"],
      [command({ kind: "activate" }), "unsupported service command"],
      [command({ kind: "submit", statement: bytesToHex(record) }), "unexpected service fields"],
    ] as const) {
      expect(() => parseV3ServiceCommand(value)).toThrow(reason);
    }
  });

  it("rejects noncanonical hex, trailing bytes and recovery refresh records", () => {
    const refresh = encodeRecord({ domain, kind: 7, publicInputs: [...limbsOf(domain), ...limbsOf(b(4)), 1n, 2n, 3n],
      proof: b(6), authorization: new Uint8Array(), capsules: [] });
    for (const value of ["", "0", "GG", bytesToHex(record).toUpperCase()]) {
      expect(() => parseV3ServiceCommand(command({ kind: "submit", record: value }))).toThrow("invalid service hex");
    }
    expect(() => parseV3ServiceCommand(command({ kind: "submit", record: `${bytesToHex(record)}00` }))).toThrow(/trailing/i);
    expect(() => parseV3ServiceCommand(command({ kind: "submit", record: bytesToHex(refresh) }))).toThrow("a request is not a segment admission");
    for (const value of ["", bytesToHex(receipt).toUpperCase(), "00".repeat(513)]) {
      expect(() => decodeV3ServiceReply(command({ kind: "accepted", receipt: value }))).toThrow("invalid service hex");
    }
    // The construction's decoder takes its receipt's exact length.
    expect(() => decodeV3ServiceReply(command({ kind: "accepted", receipt: `${bytesToHex(receipt)}00` }))).toThrow(/trailing/i);
    expect(() => decodeV3ServiceReply(command({ kind: "accepted", receipt: bytesToHex(receipt).slice(0, -2) }))).toThrow("truncated");
    expect(() => decodeV3ServiceReply(command({ kind: "committed", commitment: "00" }))).toThrow("invalid service hex");
  });
});

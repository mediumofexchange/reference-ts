// R8 research boundary: real v2 hashes/signatures, with an oracle proof verifier.
// These tests characterize existing bytes; they specify no v3 certificate.
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { ByteWriter } from "../src/bytes.js";
import { directoryRoot, signCommitment, verifyCommitment } from "../src/commitment.js";
import { fieldToBytes } from "../src/pool/field.js";
import { poolReceiptAttestsEvidence, poolReceiptInHistory, signPoolReceipt } from "../src/pool/receipt.js";
import { Segment } from "../src/pool/segment.js";
import { encodeStatement, nextHistoryHash, segmentAuthority, statementHash } from "../src/pool/statement.js";
import { CONFIG, DOMAIN, genesisHeader, issueStatement, Oracle, signedPoolBacking, walletNote } from "../test/pool-support.js";
import { SECRETS } from "../test/support.js";

async function fixture() {
  const oracle = new Oracle(), backing = signedPoolBacking(SECRETS.backer);
  const header = genesisHeader([backing.backing]), authority = segmentAuthority(header);
  const segment = new Segment(CONFIG, header, [], oracle);
  segment.register(backing.backing, backing.signature);
  const opening = signCommitment(SECRETS.operator, 1n, directoryRoot(segment.directory()));
  const statements = [], records = [];
  for (let n = 1n; n <= 3n; n++) {
    const note = walletNote(backing.backing.name, n, n);
    const statement = oracle.accept(issueStatement(authority, backing.backing.name, n, note.cm, SECRETS.backer));
    statements.push(statement); records.push(await segment.admit(statement));
  }
  const checkpoint = signCommitment(SECRETS.operator, 2n, directoryRoot(segment.directory()));
  return { oracle, segment, authority, opening, checkpoint, statements, records };
}

describe("R8: checkpoint evidence is stronger in the ideal fault model than in v2 bytes", () => {
  it.each(["proof", "obligorSignature"] as const)(
    "a substituted %s invalidates replay without proving that the signed checkpoint bound those bad bytes", async field => {
      const { oracle, segment, checkpoint, statements, records } = await fixture();
      const original = statements[0]!, bytes = new Uint8Array(original[field]!);
      bytes[0] = bytes[0]! ^ 1;
      const changed = { ...original, [field]: bytes };
      expect(encodeStatement(DOMAIN, changed)).not.toEqual(encodeStatement(DOMAIN, original));
      expect(statementHash(DOMAIN, changed.kind, changed.publicInputs)).toEqual(records[0]!.statementHash);
      expect(verifyCommitment(checkpoint)).toBe(true);
      const valid = await Segment.replay(segment.trail(), oracle);
      expect(directoryRoot(valid.directory())).toEqual(checkpoint.root);
      await expect(Segment.replay({ ...segment.trail(), statements: [changed, ...statements.slice(1)] }, oracle)).rejects.toThrow();
      // The commitment still signs the valid history. A replica's replacement
      // bytes cannot be used as an intrinsic exclusion certificate for it.
      expect(directoryRoot(segment.directory())).toEqual(checkpoint.root);
    });

  it("a later receipt attesting bad proof bytes cannot certify that an earlier checkpoint was invalid", async () => {
    const { oracle, segment, authority, checkpoint, statements, records } = await fixture();
    const original = statements[0]!, bad = { ...original, proof: sha256(original.proof) };
    const admitted = records[0]!;
    const receipt = signPoolReceipt(SECRETS.operator, authority, { ...admitted, proofHash: sha256(bad.proof) }, checkpoint.sequence);
    expect(poolReceiptAttestsEvidence(authority, bad, receipt)).toBe(true);
    expect(poolReceiptAttestsEvidence(authority, original, receipt)).toBe(false);
    expect(await oracle.verify(bad.kind, bad.publicInputs, bad.proof)).toBe(false);
    const valid = await Segment.replay(segment.trail(), oracle);
    expect(poolReceiptInHistory(valid, receipt)).toBe(true); // semantic inclusion, not checkpoint evidence binding
    expect(directoryRoot(valid.directory())).toEqual(checkpoint.root);
    expect(verifyCommitment(checkpoint)).toBe(true);
    // This is evidence about the receipt signer; rejecting this checkpoint
    // from it would discard a history that the original evidence validates.
  });

  it("valid proof variants preserve v2 history and retries while exact evidence identities differ", async () => {
    const { oracle, segment, authority, checkpoint, statements, records } = await fixture();
    const original = statements[0]!, alternate = oracle.accept({ ...original, proof: sha256(original.proof) });
    const reproven = await Segment.replay({ ...segment.trail(), statements: [alternate, ...statements.slice(1)] }, oracle);
    expect(reproven.historyHash()).toEqual(segment.historyHash());
    expect(directoryRoot(reproven.directory())).toEqual(checkpoint.root);
    expect(sha256(encodeStatement(DOMAIN, alternate))).not.toEqual(sha256(encodeStatement(DOMAIN, original)));
    const receipt = signPoolReceipt(SECRETS.operator, authority, records[0]!, 1n);
    expect(poolReceiptInHistory(reproven, receipt)).toBe(true);
    expect(poolReceiptAttestsEvidence(authority, alternate, receipt)).toBe(false);
    const retried = await segment.admit(alternate);
    expect(retried.proofHash).toEqual(sha256(original.proof));
    expect(signPoolReceipt(SECRETS.operator, authority, retried, 1n)).toEqual(receipt);
  });

  it("authenticating an interior history position requires the later step inputs, not later hash values alone", async () => {
    const { segment, records } = await fixture();
    const context = new TextEncoder().encode("moe/pool/v2/history");
    let reconstructed = records[0]!.historyHash;
    for (const record of records.slice(1)) {
      const suffix = new ByteWriter();
      suffix.key32(record.statementHash, "statement");
      suffix.key32(fieldToBytes(record.noteRoot), "note root");
      suffix.key32(record.spentRoot, "spent root"); suffix.u64(record.position);
      const inputs = suffix.finish(); expect(inputs).toHaveLength(104);
      expect(inputs.slice(0, -8)).toHaveLength(96); // position can be derived from target and order
      reconstructed = sha256(new Uint8Array([...context, ...reconstructed, ...inputs]));
      expect(reconstructed).toEqual(record.historyHash);
      // Conditional size only: adding two evidence digests to this recurrence
      // would cost 168 (or 160 with derived position) bytes per later event.
      expect(inputs.length + 2 * 32).toBe(168);
    }
    expect(reconstructed).toEqual(segment.historyHash());
    const second = records[1]!;
    for (const changed of [
      { ...second, statementHash: sha256(second.statementHash) },
      { ...second, noteRoot: second.noteRoot + 1n },
      { ...second, spentRoot: sha256(second.spentRoot) },
      { ...second, position: second.position + 1n },
    ]) {
      const altered = nextHistoryHash(records[0]!.historyHash, changed.statementHash, changed.noteRoot, changed.spentRoot, changed.position);
      const last = records[2]!;
      expect(nextHistoryHash(altered, last.statementHash, last.noteRoot, last.spentRoot, last.position)).not.toEqual(segment.historyHash());
    }
  });
});

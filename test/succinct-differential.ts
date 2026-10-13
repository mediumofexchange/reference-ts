// The differential check of succinct reading (succinct-read §§1, 3; slice 35): a package read completely and read
// succinctly, its trails proof-free, must reach the same outcome: the same refusal (status and check) or the same state,
// listings, clock, ranges and forced publications. Two succinct reads run per package, under a test set: one with a
// cover for every span a stand-in prover could check natively, one with none, whose every proof is fetched and checked
// natively. Proofs come from the complete package's trails; publications' proofs are the reader's own (§3.6).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { expect } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { readPackage, type PackageSource, type ReadOptions } from "../src/pool/v3/package-reader.js";
import { decodeEvidencePackage, encodeEvidencePackage, type EvidenceItem } from "../src/pool/v3/package.js";
import type { ReaderSelection } from "../src/pool/v3/reader.js";
import { decodeRecord, proofFreeOf, statementHash, type ProofFreeRecord } from "../src/pool/v3/records.js";
import { EvidenceRefusal, ReplayRefusal } from "../src/pool/v3/refusals.js";
import { leafDigest, nodeDigest, PROOF_FREE_TRAILS, proofFreeTrail, succinctPoolV3, testCheckSet, type CheckSupply } from "../src/pool/v3/succinct.js";
import { decodeTrail } from "../src/pool/v3/trail.js";

const SET = testCheckSet("differential");
const PROVED = new Set([1, 2, 3, 4, 6]);

/** The package with each trail proof-free, the proofs by hash, and covers for every aligned span of each trail's proved
 * records whose proofs `verify` accepts, as a prover that checks each statement proof first makes them (§3.5). */
export async function succinctPackage(bytes: Uint8Array, verify: (kind: number, inputs: bigint[], proof: Uint8Array) => Promise<boolean> | boolean) {
  const proofs = new Map<string, Uint8Array>(), covers = new Map<bigint, Uint8Array>();
  const items: EvidenceItem[] = [];
  for (const item of decodeEvidencePackage(bytes)) {
    if (item.kind !== 6) { items.push(item); continue; }
    let trail;
    try { trail = decodeTrail(item.payload); } catch { items.push(item); continue; }
    let free;
    try { free = proofFreeTrail(trail); } catch { continue; } // An undecodable record has no proof-free form.
    items.push({ kind: 6, payload: PROOF_FREE_TRAILS.encodeTrail(free) });
    const proved: { digest: bigint; kind: number; ok: boolean }[] = [];
    for (const recordBytes of trail.records) {
      const record = decodeRecord(recordBytes);
      if (record.proof.length > 0) proofs.set(hex(sha256(record.proof)), record.proof);
      if (!PROVED.has(record.kind)) continue;
      const free = proofFreeOf(record);
      proved.push({ digest: leafDigest(free), kind: record.kind, ok: await verify(record.kind, [...record.publicInputs], record.proof) === true });
    }
    // Every aligned span from proved record 0: a tree over the records' leaves.
    let level = proved.map(p => ({ digest: p.digest, ok: p.ok, kind: p.kind as number | undefined }));
    for (const leaf of level) if (leaf.ok) covers.set(leaf.digest, SET.cover(leaf.kind, leaf.digest));
    while (level.length > 1) {
      const next: typeof level = [];
      for (let i = 0; i + 1 < level.length; i += 2) {
        const node = { digest: nodeDigest(level[i]!.digest, level[i + 1]!.digest), ok: level[i]!.ok && level[i + 1]!.ok, kind: undefined };
        if (node.ok) covers.set(node.digest, SET.cover(undefined, node.digest));
        next.push(node);
      }
      level = next;
    }
  }
  items.sort((a, z) => a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload)));
  return { bytes: encodeEvidencePackage(items), proofs, covers };
}

/** A read's outcome in comparable form: its refusal, or its verdicts with each forced record named by its statement. */
async function outcome(read: Promise<unknown>): Promise<string> {
  let result: Record<string, unknown>;
  try { result = await read as Record<string, unknown>; } catch (error) {
    if (error instanceof ReplayRefusal) return JSON.stringify({ refused: "replay", check: error.check });
    if (error instanceof EvidenceRefusal) return JSON.stringify({ refused: error.status });
    throw error;
  }
  const force = (result["force"] as { backing: Uint8Array; index: bigint; ordinal: bigint; record: ProofFreeRecord }[] | undefined)
    ?.map(f => ({ backing: f.backing, index: f.index, ordinal: f.ordinal, statement: statementHash(f.record) }));
  // A replayed state is compared by what it states; its construction and replay identity name the read's rules.
  return JSON.stringify({ ...result, force }, (_, value: unknown) => {
    if (typeof value === "bigint") return `${value}n`;
    if (value instanceof Uint8Array) return hex(value);
    if (value !== null && typeof value === "object" && "store" in value && "ns" in value) {
      const state = value as unknown as { position: bigint; history: Uint8Array; issued?: bigint; burned?: bigint };
      return { position: state.position, history: state.history, issued: state.issued, burned: state.burned };
    }
    return value;
  });
}

/** Read `source` completely and succinctly, with all covers and with none; every outcome must be the complete read's.
 * Returns the complete read. A read with kept stores reads completely only: a succinct read keeps its own. */
export const readBoth = (async (source: PackageSource, selection: ReaderSelection, options: ReadOptions) => {
  const complete = readPackage(source, selection, options);
  if (!(source instanceof Uint8Array) || options.store !== undefined || options.evidence !== undefined || options.construction !== undefined) return await complete;
  const expected = await outcome(complete);
  const verify = options.verifier!.verify.bind(options.verifier);
  const free = await succinctPackage(source, (kind, inputs, proof) => verify(kind, inputs, proof));
  for (const covered of [true, false]) {
    const supply: CheckSupply = { cover: digest => (covered ? free.covers.get(digest) : undefined), proof: hash => free.proofs.get(hex(hash)) };
    const got = await outcome(readPackage(free.bytes, selection, { ...options, construction: succinctPoolV3({ set: SET, supply }) }));
    expect(got, covered ? "succinct read with covers" : "succinct read, every proof native").toBe(expected);
  }
  return await complete;
}) as typeof readPackage;

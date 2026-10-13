// A served package read succinctly with real check proofs (succinct-read §§3.3-3.5, slice 36): its trails made
// proof-free, the proofs held by hash, and covers proved by the aggregator over chosen spans of its longest trail's
// proved records under the check set (check-set.ts). A store check compares the read with the complete read; covers
// not proved here leave their records to the native check, so one read exercises both. The check set's parameters
// (the leading 2^21 points) are prepared in the checks' parameter directory.
import { createHash } from "node:crypto";
import { prepareCheckSetParameters, readCheckSetParameters } from "../../../dist/pool/parameter-files.js";
import { startCheckSetBackend } from "../../../dist/pool/proof-verifier.js";
import { coverKey, openTrailProver } from "../../../dist/pool/v3/aggregator.js";
import { readPackage } from "../../../dist/pool/v3/package-reader.js";
import { decodeEvidencePackage, encodeEvidencePackage } from "../../../dist/pool/v3/package.js";
import { decodeRecord } from "../../../dist/pool/v3/records.js";
import { PROOF_FREE_TRAILS, proofFreeTrail, succinctPoolV3 } from "../../../dist/pool/v3/succinct.js";
import { decodeTrail } from "../../../dist/pool/v3/trail.js";
import { PARAMETER_DIRECTORY } from "../prepare-crs.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const PROVED = new Set([1, 2, 3, 4, 6]);

/**
 * Read `input` succinctly: the longest trail's proved records get covers over each `{ first, count }` span range
 * (proved-record numbers), checked natively first by `verifier`; every other proof is fetched by hash. Returns the
 * read's result and what the read used: covers answered, covers that verified, and proofs fetched.
 */
export async function readWithCovers(input, ranges, { verifier, venue, reference }) {
  const proofs = new Map(), items = [];
  let longest;
  for (const item of decodeEvidencePackage(input.package)) {
    if (item.kind !== 6) { items.push(item); continue; }
    const trail = decodeTrail(item.payload);
    for (const bytes of trail.records) {
      const { proof } = decodeRecord(bytes);
      if (proof.length > 0) proofs.set(sha(proof), proof);
    }
    if (longest === undefined || trail.records.length > longest.records.length) longest = trail;
    items.push({ kind: 6, payload: PROOF_FREE_TRAILS.encodeTrail(proofFreeTrail(trail)) });
  }
  items.sort((a, z) => a.kind - z.kind || sha(a.payload).localeCompare(sha(z.payload)));
  const proved = longest.records.map(bytes => decodeRecord(bytes)).filter(record => PROVED.has(record.kind));

  await prepareCheckSetParameters(PARAMETER_DIRECTORY);
  const api = await startCheckSetBackend(await readCheckSetParameters(PARAMETER_DIRECTORY));
  let prover;
  try {
    prover = await openTrailProver(api, verifier);
    const covers = new Map(), proving = [];
    for (const { first, count } of ranges) {
      const started = performance.now();
      for (const [key, cover] of await prover.covers(proved.slice(first, first + count), first)) covers.set(key, cover.proof);
      proving.push({ first, count, seconds: Number(((performance.now() - started) / 1000).toFixed(1)) });
    }
    const used = { answered: 0, verified: 0, fetched: 0, proving };
    const set = { identity: prover.set.identity, test: prover.set.test,
      verify: async (kind, digest, proof) => { const ok = await prover.set.verify(kind, digest, proof); if (ok) used.verified++; return ok; } };
    const supply = {
      cover: digest => { const proof = covers.get(coverKey(digest)); if (proof !== undefined) used.answered++; return proof; },
      proof: hash => { const proof = proofs.get(Buffer.from(hash).toString("hex")); if (proof !== undefined) used.fetched++; return proof; },
    };
    const result = await readPackage(encodeEvidencePackage(items), input.selection,
      { verifier, venue, reference, construction: succinctPoolV3({ set, supply }) });
    return { result, used, proved: proved.length };
  } finally {
    await prover?.close();
    await api.destroy();
  }
}

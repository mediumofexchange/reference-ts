// A backing read succinctly through the reference's transport with real check proofs (succinct-read §§3.3-3.5, 4.7;
// slices 36-37): a replica syncs the operator's evidence over its listener and keeps the covers the aggregator proves over
// chosen spans of the trail's proved records (check-set.ts), walked as any replica walks them (`V3Replica.prove`); a succinct reader then syncs the proof-free evidence from the
// replica and fetches covers and the uncovered proofs over HTTP, from the replica first and the operator after. A store
// check compares the read with the complete read; covers not proved here leave their records to the native check, so
// one read exercises both. The check set's parameters (the leading 2^21 points) are prepared in the checks' parameter
// directory.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import { prepareCheckSetParameters, readCheckSetParameters } from "../../../dist/pool/parameter-files.js";
import { startCheckSetBackend } from "../../../dist/pool/proof-verifier.js";
import { openTrailProver } from "../../../dist/pool/v3/aggregator.js";
import { EvidenceStore } from "../../../dist/pool/v3/evidence-store.js";
import { readPackage } from "../../../dist/pool/v3/package-reader.js";
import { decodeRecord } from "../../../dist/pool/v3/records.js";
import { V3Replica } from "../../../dist/pool/v3/replica.js";
import { serviceSupply, V3ServiceClient } from "../../../dist/pool/v3/service-client.js";
import { createV3EvidenceService, createV3Service } from "../../../dist/pool/v3/service-http.js";
import { servedFrames } from "../../../dist/pool/v3/service-wire.js";
import { PROOF_FREE_FORM, succinctPoolV3 } from "../../../dist/pool/v3/succinct.js";
import { PARAMETER_DIRECTORY } from "../prepare-crs.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const PROVED = new Set([1, 2, 3, 4, 6]);
const TOKEN = "11".repeat(32);

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`));
});
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
/** The bytes a served stream for `backing` from nothing takes on the wire, in `form`. */
async function servedBytes(source, backing, form) {
  let n = 0;
  for await (const chunk of servedFrames(await source.serve(backing, 0n, form))) n += chunk.length;
  return n;
}

/**
 * Read `backing` of `journal` succinctly over the wire: the replica's covers are proved over each `{ first, count }`
 * range of the served trail's proved records, each statement proof checked natively first by `verifier`. Returns the
 * read's result, what the read used (covers answered and verified, proofs fetched), which proved records it fetched a
 * proof of, and the served stream's bytes in each form.
 */
export async function readWithCovers(journal, backing, selection, ranges, { verifier, venue, reference, directory, operator }) {
  const servers = [], stores = [];
  try {
    const operatorUrl = await listen(servers[servers.push(createV3Service(journal, { walletToken: TOKEN })) - 1]);
    const identity = construction => ({ operator, reference, ...(construction === undefined ? {} : { construction }) });
    const operatorClient = new V3ServiceClient(operatorUrl, TOKEN, identity());
    const replicaPath = join(directory, "succinct-replica.db"), replicaStore = new EvidenceStore(replicaPath, { shared: true }); stores.push(replicaStore);
    const replica = new V3Replica(replicaPath, replicaStore, venue.id);
    if (!replica.keep(await operatorClient.sync(backing, replicaStore))) throw new Error("the replica kept no selection");
    const replicaUrl = await listen(servers[servers.push(createV3EvidenceService(replica)) - 1]);

    // The served trail's proved records, as the replica keeps them.
    const [top] = replicaStore.keptTops(), kept = replicaStore.retained();
    let proved;
    try { proved = [...kept.trail(top.segment, top.evidence).records()].map(bytes => decodeRecord(bytes)).filter(r => PROVED.has(r.kind)); }
    finally { kept.release(); }

    await prepareCheckSetParameters(PARAMETER_DIRECTORY);
    const api = await startCheckSetBackend(await readCheckSetParameters(PARAMETER_DIRECTORY), { threads: availableParallelism() });
    let prover;
    try {
      prover = await openTrailProver(api, verifier);
      // The replica proves as it does for any reader (`V3Replica.prove`), with leaves only over the chosen records:
      // `coverTrail` proves a node only over two covered spans, so it keeps the aligned spans inside the ranges.
      const chosen = new Set(ranges.flatMap(({ first, count }) => proved.slice(first, first + count).map(record => sha(record.proof))));
      const partial = { identity: prover.identity, leaf: async record => chosen.has(sha(record.proof)) ? prover.leaf(record) : undefined,
        node: (left, right) => prover.node(left, right) };
      const started = performance.now(), walk = await replica.prove(partial);
      const proving = { ...walk, seconds: Number(((performance.now() - started) / 1000).toFixed(1)) };
      const used = { answered: 0, verified: 0, fetched: 0, proving }, fetched = new Set();
      const set = { identity: prover.set.identity, test: prover.set.test,
        verify: async (kind, digest, proof) => { const ok = await prover.set.verify(kind, digest, proof); if (ok) used.verified++; return ok; } };
      const wire = serviceSupply(set.identity, [new V3ServiceClient(replicaUrl, undefined, identity()), operatorClient]);
      const supply = {
        cover: async (digest, accept) => { const proof = await wire.cover(digest, accept); if (proof !== undefined) used.answered++; return proof; },
        proof: async (hash, at) => {
          const proof = await wire.proof(hash, at);
          if (proof !== undefined) { used.fetched++; fetched.add(Buffer.from(hash).toString("hex")); }
          return proof;
        },
      };
      const construction = succinctPoolV3({ set, supply });
      const evidence = new EvidenceStore(join(directory, "succinct-reader.db"), { construction }); stores.push(evidence);
      const served = await new V3ServiceClient(replicaUrl, undefined, identity(construction)).sync(backing, evidence);
      const result = await readPackage(served.package, selection, { verifier, venue, reference, construction, evidence });
      // Which proved records the read fetched a proof of, by proved-record number.
      const fetchedRecords = proved.flatMap((record, i) => fetched.has(sha(record.proof)) ? [i] : []);
      const bytes = { complete: await servedBytes(replica, backing), proofFree: await servedBytes(replica, backing, PROOF_FREE_FORM) };
      return { result, used, proved: proved.length, fetchedRecords, bytes };
    } finally {
      await prover?.close();
      await api.destroy();
    }
  } finally {
    await Promise.all(servers.map(close));
    for (const store of stores.reverse()) store.close();
  }
}

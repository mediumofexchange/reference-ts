// Slice 38 (review): a replica proves the segments its kept selections name and every earlier segment their openings
// import, so a replica started after keep-only rescopes covers them all; and a prover's exception records no walk
// position, so the next walk goes on from the last one recorded.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { adoptedConfiguration, configurationHash } from "../src/pool/v3/configuration.js";
import { POOL_V3, type Construction } from "../src/pool/v3/construction.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { decodeSegmentHeader } from "../src/pool/v3/headers.js";
import { decodeEvidencePackage } from "../src/pool/v3/package.js";
import { readFrontier } from "../src/pool/v3/package-reader.js";
import { encodeRecord, type Record } from "../src/pool/v3/records.js";
import { serviceSupply, V3ServiceClient } from "../src/pool/v3/service-client.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { COVER_PROOF_BYTES, succinctPoolV3, testCheckSet, testProver, type CheckSupply } from "../src/pool/v3/succinct.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { decodeTrail } from "../src/pool/v3/trail.js";
import { authorizeIssue, issueTask, type ProofTask, type SegmentContext } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { outcome } from "./succinct-differential.js";

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const configuration = adoptedConfiguration(), domain = configurationHash(configuration);
const issuerSecret = b(15), operatorSecret = b(16), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const SET = testCheckSet("transport");
const verifier = { verify: (kind: number, _inputs: bigint[], proof: Uint8Array) => proof[0] === kind, identities: configuration.circuits };
const record = (task: ProofTask, tag: number): Record => {
  const proof = new Uint8Array(COVER_PROOF_BYTES).fill(task.kind); proof[1] = tag; proof[2] = tag >> 8;
  return { domain, kind: task.kind, publicInputs: task.publicInputs, proof, authorization: new Uint8Array(), capsules: task.capsules };
};
const TOKEN = "11".repeat(32), ADMIN = "22".repeat(32);
const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);

describe("a replica's covers across segments (slice 38)", () => {
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  let service: typeof import("../src/pool/v3/service-http.js");
  let V3Replica: typeof import("../src/pool/v3/replica.js").V3Replica;
  const closing: { close(): void }[] = [], servers: Server[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ V3OperatorJournal } = await import("../src/pool/v3/store.js"));
    service = await import("../src/pool/v3/service-http.js");
    ({ V3Replica } = await import("../src/pool/v3/replica.js"));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
    for (const c of closing.splice(0).reverse()) { try { c.close(); } catch { /* closed */ } }
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const listen = async (server: Server): Promise<string> => {
    servers.push(server);
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  };

  /** `segments` keep-only rescopes of `perSegment` issues each; `continuous` syncs, keeps and proves after each segment. */
  async function run(segments: number, perSegment: number, continuous: boolean, prove = true) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "succinct-coverage-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n }, operator, configuration: domain,
      venue: venue.id, interval: 10n });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const j: Journal = new V3OperatorJournal(join(directory, "journal.db"), { secret: operatorSecret, venue, reference, verifier }); closing.push(j);
    await j.open("genesis", signed); await j.publish();
    const identity = (construction: Construction) => ({ operator, reference: { ...reference, label: label.slice() }, construction });
    const operatorClient = new V3ServiceClient(await listen(service.createV3Service(j, { walletToken: TOKEN, adminToken: ADMIN })), TOKEN, identity(POOL_V3 as Construction));
    const replicaPath = join(directory, "replica.db"), replicaStore = new EvidenceStore(replicaPath, { shared: true }); closing.push(replicaStore);
    const replica = new V3Replica(replicaPath, replicaStore, venue.id);
    const replicaUrl = await listen(service.createV3EvidenceService(replica));
    const prover = testProver(SET, verifier);
    const context = async (): Promise<SegmentContext> => {
      const headers = decodeEvidencePackage((await j.package()).package).filter(item => item.kind === 6)
        .map(item => decodeSegmentHeader(decodeTrail(item.payload).header))
        .filter(h => same(h.operator, operator)).sort((p, q) => p.sequence > q.sequence ? -1 : p.sequence < q.sequence ? 1 : 0);
      return { domain, header: headers[0]! };
    };
    const retry = async (step: () => Promise<unknown>, codes: string[]) => {
      for (let i = 0; ; i++) {
        try { await step(); return; } catch (error) {
          if (!codes.includes((error as { code?: string }).code ?? "") || i > 12) throw error;
          venue.advance(venue.witnessedIndex() + 1n);
        }
      }
    };
    const rounds: unknown[] = [];
    const round = async () => {
      expect(replica.keep(await operatorClient.sync(backing, replicaStore))).toBe(true);
      if (prove) rounds.push(await replica.prove(prover));
    };
    let n = 0;
    for (let s = 0; s < segments; s++) {
      if (s > 0) {
        await retry(() => j.rescope(`r${s}`, { keep: [backing] }), ["SCHEDULE", "STALE"]); await j.publish();
        await retry(() => j.adopt(), ["SCHEDULE", "STALE"]);
      }
      const ctx = await context();
      for (let k = 0; k < perSegment; k++) {
        n++;
        const out = prepareExactOutput(b(21), domain, b(n % 250 + 1), backing, BigInt(n));
        await j.submit(encodeRecord(authorizeIssue(record(issueTask(ctx, out), n), issuerSecret)));
        await retry(() => j.commit(`c${s}-${k}`), ["SCHEDULE"]); await j.publish();
      }
      if (continuous) await round();
    }
    if (!continuous) await round();
    const segmentsHeld = new Set(replicaStore.keptTops().map(top => bytesToHex(top.segment))).size;

    // A fresh succinct read through the replica alone, counting covers answered and proofs fetched.
    const asked = { covers: 0, answered: 0, proofs: 0, fetched: 0 };
    const wire = serviceSupply(SET.identity, [new V3ServiceClient(replicaUrl, undefined, identity(POOL_V3 as Construction))]);
    const supply: CheckSupply = {
      cover: async (digest, accept) => { asked.covers++; const a = await wire.cover(digest, accept); if (a !== undefined) asked.answered++; return a; },
      proof: async (hash, at) => { asked.proofs++; const a = await wire.proof(hash, at); if (a !== undefined) asked.fetched++; return a; },
    };
    const results: string[] = [];
    for (const name of ["complete", "succinct"] as const) {
      const construction = name === "complete" ? POOL_V3 as Construction : succinctPoolV3({ set: SET, supply }) as Construction;
      const evidence = new EvidenceStore(join(directory, `${name}.db`), { construction }); closing.push(evidence);
      const served = await new V3ServiceClient(replicaUrl, undefined, identity(construction)).sync(backing, evidence);
      results.push(await outcome(readFrontier(served.package, signed, venue.witnessedIndex(), { construction, verifier, venue, reference, evidence })));
    }
    return { rounds, segmentsHeld, asked, agree: results[0] === results[1], replica };
  }

  it("covers every segment of a backing after keep-only rescopes, whether it proved after each or started after the last", async () => {
    const fresh = await run(3, 2, false), continuous = await run(3, 2, true);
    for (const r of [fresh, continuous]) {
      expect(r.agree).toBe(true);
      expect(r.segmentsHeld).toBe(3);
      // A fresh succinct reader takes one cover a segment and fetches no proof.
      expect(r.asked).toMatchObject({ answered: 3, fetched: 0 });
    }
  }, 280_000);

  it("a prover's exception records no position; the next walk starts from the last recorded one", async () => {
    mkdirSync(scratch, { recursive: true });
    const r = await run(1, 4, false, false), replica = r.replica;
    const inner = testProver(SET, verifier);
    const throwing = (at: number) => { let calls = 0; return { ...inner, leaf: async (rec: Record) => { if (++calls === at) throw new Error("prover down"); return inner.leaf(rec); } }; };
    await expect(replica.prove(throwing(3))).rejects.toThrow("prover down");
    let asked = 0;
    const stopped = await replica.prove(inner, { stop: () => asked++ >= 1 });
    await expect(replica.prove(throwing(2))).rejects.toThrow("prover down");
    const last = await replica.prove(inner), again = await replica.prove(inner);
    expect(stopped).toMatchObject({ read: 1, stopped: true });
    expect(again).toMatchObject({ read: 0, made: 0 });
  }, 120_000);
});

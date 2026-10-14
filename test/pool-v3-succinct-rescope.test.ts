// Slice 38 (succinct-read §3.4, review): a fresh succinct read finds each segment's latest trail in one walk back over
// the term, so a history of many segments (keep-only rescopes) costs it one pass over the term's commitments beyond the
// complete read's lookups, not one a segment.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { adoptedConfiguration, configurationHash } from "../src/pool/v3/configuration.js";
import { POOL_V3, type Construction } from "../src/pool/v3/construction.js";
import { EvidenceBatch, EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { decodeSegmentHeader } from "../src/pool/v3/headers.js";
import { decodeEvidencePackage } from "../src/pool/v3/package.js";
import { readFrontier } from "../src/pool/v3/package-reader.js";
import { encodeRecord, type Record } from "../src/pool/v3/records.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { serviceSupply, V3ServiceClient } from "../src/pool/v3/service-client.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { COVER_PROOF_BYTES, succinctPoolV3, testCheckSet } from "../src/pool/v3/succinct.js";
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

describe("a fresh succinct read over many segments (slice 38)", () => {
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

  async function run(segments: number, perSegment: number) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "succinct-rescope-")); directories.push(directory);
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
    const context = async (): Promise<SegmentContext> => {
      const headers = decodeEvidencePackage((await j.package()).package).filter(item => item.kind === 6)
        .map(item => decodeSegmentHeader(decodeTrail(item.payload).header))
        .filter(h => same(h.operator, operator)).sort((p, q) => p.sequence > q.sequence ? -1 : p.sequence < q.sequence ? 1 : 0);
      return { domain, header: headers[0]! };
    };
    const checkpoint = async (id: string) => {
      for (let i = 0; ; i++) {
        try { await j.commit(id); break; } catch (error) {
          if ((error as { code?: string }).code !== "SCHEDULE" || i > 8) throw error;
          venue.advance(venue.witnessedIndex() + 1n);
        }
      }
      await j.publish();
    };
    let n = 0;
    for (let s = 0; s < segments; s++) {
      if (s > 0) {
        for (let i = 0; ; i++) {
          try { await j.rescope(`r${s}`, { keep: [backing] }); break; } catch (error) {
            if (!["SCHEDULE", "STALE"].includes((error as { code?: string }).code ?? "") || i > 12) throw error;
            venue.advance(venue.witnessedIndex() + 1n);
          }
        }
        await j.publish();
        for (let i = 0; ; i++) {
          try { await j.adopt(); break; } catch (error) {
            if (!["SCHEDULE", "STALE"].includes((error as { code?: string }).code ?? "") || i > 12) throw error;
            venue.advance(venue.witnessedIndex() + 1n);
          }
        }
      }
      const ctx = await context();
      for (let k = 0; k < perSegment; k++) {
        n++;
        const out = prepareExactOutput(b(21), domain, b(n % 250 + 1), backing, BigInt(n));
        await j.submit(encodeRecord(authorizeIssue(record(issueTask(ctx, out), n), issuerSecret)));
        await checkpoint(`c${s}-${k}`);
      }
    }
    expect(replica.keep(await operatorClient.sync(backing, replicaStore))).toBe(true);
    const headersSeen = (await context()).header.sequence;

    const out: { name: string; lookups: number; result: string }[] = [];
    const directoryOf = EvidenceBatch.prototype.directory, snapshotOf = EvidenceBatch.prototype.snapshot;
    for (const name of ["complete", "succinct"] as const) {
      const construction = name === "complete" ? POOL_V3 as Construction :
        succinctPoolV3({ set: SET, supply: serviceSupply(SET.identity, [new V3ServiceClient(replicaUrl, undefined, identity(POOL_V3 as Construction))]) }) as Construction;
      const evidence = new EvidenceStore(join(directory, `${name}.db`), { construction }); closing.push(evidence);
      const store = new ReplayStore(join(directory, `${name}.replay`), { digest: join(directory, `${name}.replay.sha256`) }); closing.push(store);
      const client = new V3ServiceClient(replicaUrl, undefined, identity(construction));
      const served = await client.sync(backing, evidence);
      const d = vi.spyOn(EvidenceBatch.prototype, "directory").mockImplementation(function (this: EvidenceBatch, root: Uint8Array) { return directoryOf.call(this, root); });
      const s = vi.spyOn(EvidenceBatch.prototype, "snapshot").mockImplementation(function (this: EvidenceBatch, digest: Uint8Array) { return snapshotOf.call(this, digest); });
      const result = await outcome(readFrontier(served.package, signed, venue.witnessedIndex(), { construction, verifier, venue, reference, evidence, store }));
      out.push({ name, lookups: d.mock.calls.length + s.mock.calls.length, result });
      d.mockRestore(); s.mockRestore();
    }
    return { segments, perSegment, headerSequence: headersSeen, out };
  }

  it("reads one segment or twelve over 24 checkpoints with at most one pass over the term beyond the complete read's lookups", async () => {
    for (const r of [await run(1, 24), await run(12, 2)]) {
      expect(r.out[1]!.result).toBe(r.out[0]!.result);
      const [complete, succinct] = r.out.map(o => o.lookups) as [number, number];
      // A directory and a snapshot for each of the 24 checkpoints, and a few more.
      expect(succinct - complete).toBeLessThanOrEqual(3 * 24);
    }
  }, 280_000);
});

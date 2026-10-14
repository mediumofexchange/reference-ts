// Slice 38 (succinct-read §3.4, review): a kept walk resumed by a later read classifies only the new checkpoint, and a
// succinct read finds the segment's latest trail by walking back from the term's end, so its directory and snapshot
// lookups on a resumed read stay as few as the complete read's, whatever the history's length.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { adoptedConfiguration, configurationHash } from "../src/pool/v3/configuration.js";
import { POOL_V3, type Construction } from "../src/pool/v3/construction.js";
import { EvidenceBatch, EvidenceStore } from "../src/pool/v3/evidence-store.js";
import type { SegmentHeader } from "../src/pool/v3/headers.js";
import { readFrontier } from "../src/pool/v3/package-reader.js";
import { encodeRecord, type Record } from "../src/pool/v3/records.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { serviceSupply, V3ServiceClient } from "../src/pool/v3/service-client.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { COVER_PROOF_BYTES, succinctPoolV3, testCheckSet } from "../src/pool/v3/succinct.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
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

describe("a resumed succinct read (slice 38)", () => {
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

  async function run(checkpoints: number) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "succinct-resume-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n }, operator, configuration: domain,
      venue: venue.id, interval: 10n });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const header: SegmentHeader = { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] };
    const context: SegmentContext = { domain, header };
    const j: Journal = new V3OperatorJournal(join(directory, "journal.db"), { secret: operatorSecret, venue, reference, verifier }); closing.push(j);
    await j.open("genesis", signed); await j.publish();
    const identity = (construction: Construction) => ({ operator, reference: { ...reference, label: label.slice() }, construction });
    const operatorClient = new V3ServiceClient(await listen(service.createV3Service(j, { walletToken: TOKEN, adminToken: ADMIN })), TOKEN, identity(POOL_V3 as Construction));
    const replicaPath = join(directory, "replica.db"), replicaStore = new EvidenceStore(replicaPath, { shared: true }); closing.push(replicaStore);
    const replica = new V3Replica(replicaPath, replicaStore, venue.id);
    const replicaUrl = await listen(service.createV3EvidenceService(replica));
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
    const issueOne = async () => {
      n++;
      const out = prepareExactOutput(b(21), domain, b(n % 250 + 1), backing, BigInt(n));
      await j.submit(encodeRecord(authorizeIssue(record(issueTask(context, out), n), issuerSecret)));
    };
    for (let k = 0; k < checkpoints; k++) { await issueOne(); await checkpoint(`c${k}`); }
    expect(replica.keep(await operatorClient.sync(backing, replicaStore))).toBe(true);

    const readers = (["complete", "succinct"] as const).map(name => {
      const construction = name === "complete" ? POOL_V3 as Construction :
        succinctPoolV3({ set: SET, supply: serviceSupply(SET.identity, [new V3ServiceClient(replicaUrl, undefined, identity(POOL_V3 as Construction))]) }) as Construction;
      const evidence = new EvidenceStore(join(directory, `${name}.db`), { construction }); closing.push(evidence);
      const store = new ReplayStore(join(directory, `${name}.replay`), { digest: join(directory, `${name}.replay.sha256`) }); closing.push(store);
      const client = new V3ServiceClient(replicaUrl, undefined, identity(construction));
      const read = async () => {
        const served = await client.sync(backing, evidence);
        return outcome(readFrontier(served.package, signed, venue.witnessedIndex(), { construction, verifier, venue, reference, evidence, store }));
      };
      return { name, read };
    });
    const first: string[] = [];
    for (const r of readers) first.push(await r.read());
    // One more checkpoint, then each reader reads again on its kept walk.
    await issueOne(); await checkpoint("next");
    expect(replica.keep(await operatorClient.sync(backing, replicaStore))).toBe(true);
    const counts: { name: string; directory: number; snapshot: number; ms: number; lookupUs: number }[] = [];
    const second: string[] = [];
    const directoryOf = EvidenceBatch.prototype.directory, snapshotOf = EvidenceBatch.prototype.snapshot;
    for (const r of readers) {
      let inside = 0;
      const directorySpy = vi.spyOn(EvidenceBatch.prototype, "directory").mockImplementation(function (this: EvidenceBatch, root: Uint8Array) {
        const t = performance.now(); try { return directoryOf.call(this, root); } finally { inside += performance.now() - t; } });
      const snapshotSpy = vi.spyOn(EvidenceBatch.prototype, "snapshot").mockImplementation(function (this: EvidenceBatch, digest: Uint8Array) {
        const t = performance.now(); try { return snapshotOf.call(this, digest); } finally { inside += performance.now() - t; } });
      const t0 = performance.now();
      second.push(await r.read());
      const calls = directorySpy.mock.calls.length + snapshotSpy.mock.calls.length;
      counts.push({ name: r.name, directory: directorySpy.mock.calls.length, snapshot: snapshotSpy.mock.calls.length, ms: Math.round(performance.now() - t0),
        lookupUs: Math.round(1000 * inside / calls) });
      directorySpy.mockRestore(); snapshotSpy.mockRestore();
    }
    return { first, second, counts };
  }

  it("reads as few directories and snapshots on a resumed read as the complete read, however long the history", async () => {
    const small = await run(6), large = await run(24);
    // Both forms agree on each read.
    for (const r of [small, large]) { expect(r.first[1]).toBe(r.first[0]); expect(r.second[1]).toBe(r.second[0]); }
    expect(JSON.parse(large.second[0]!)).not.toHaveProperty("refused");
    const lookups = (r: typeof small, name: string) => { const c = r.counts.find(count => count.name === name)!; return c.directory + c.snapshot; };
    // Flat in the history: the latest checkpoint is found from the term's end, about one lookup of each more.
    expect(lookups(large, "succinct")).toBe(lookups(small, "succinct"));
    expect(lookups(large, "complete")).toBe(lookups(small, "complete"));
    expect(lookups(large, "succinct")).toBeLessThanOrEqual(lookups(large, "complete") + 2);
  }, 120_000);
});

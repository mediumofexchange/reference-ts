import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { adoptedConfiguration, configurationHash } from "../src/pool/v3/configuration.js";
import { POOL_V3, type Construction } from "../src/pool/v3/construction.js";
import { EvidenceStore, type EvidencePart } from "../src/pool/v3/evidence-store.js";
import { segmentBytes, type SegmentHeader } from "../src/pool/v3/headers.js";
import { encodeTrail } from "../src/pool/v3/trail.js";
import { readFrontier } from "../src/pool/v3/package-reader.js";
import { decodeProofFree, decodeRecord, encodeRecord, type Record } from "../src/pool/v3/records.js";
import { serviceSupply, V3ServiceClient, V3ServiceClientError } from "../src/pool/v3/service-client.js";
import type { V3EvidenceSource } from "../src/pool/v3/service-http.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { COVER_PROOF_BYTES, succinctPoolV3, testCheckSet, testProver, type CheckSupply, type RecordAt } from "../src/pool/v3/succinct.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { authorizeIssue, issueTask, spendTask, type ProofTask, type SegmentContext } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE, localVenueIdentity } from "../src/record-venue.js";
import { outcome } from "./succinct-differential.js";

// Slice 37 (succinct-read §§3.3–3.5, §4.7): a succinct reader's transport. An operator's and a replica's listeners serve
// the served stream with proof-free trails, a kept record's proof by its hash and place, and check proofs a prover kept
// by set and digest; the reader checks every answer, and its read equals the complete read's.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const configuration = adoptedConfiguration(), domain = configurationHash(configuration);
const issuerSecret = b(15), operatorSecret = b(16), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const, venueId = localVenueIdentity(label, lag);
const terms = encodeRootTerms({ obligor: issuer, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n }, operator, configuration: domain,
  venue: venueId, interval: 10n });
const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
const header: SegmentHeader = { domain, venue: venueId, operator, sequence: 1n, entries: [{ backing, link: backing }] };
const context: SegmentContext = { domain, header };
const output = (id: number, value: bigint) => prepareExactOutput(b(21), domain, b(id), backing, value);
const TOKEN = "11".repeat(32), ADMIN = "22".repeat(32);
/** A stand-in proof of the length a cover fixes, which the test verifier accepts where its first byte is the kind. */
const record = (task: ProofTask, tag: number): Record => {
  const proof = new Uint8Array(COVER_PROOF_BYTES).fill(task.kind); proof[1] = tag;
  return { domain, kind: task.kind, publicInputs: task.publicInputs, proof, authorization: new Uint8Array(), capsules: task.capsules };
};
const verifier = { verify: (kind: number, _inputs: bigint[], proof: Uint8Array) => proof[0] === kind, identities: configuration.circuits };
const SET = testCheckSet("transport");

describe("succinct transport (slice 37)", () => {
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

  async function fixture() {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "succinct-transport-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const j: Journal = new V3OperatorJournal(join(directory, "journal.db"), { secret: operatorSecret, venue, reference, verifier }); closing.push(j);
    await j.open("genesis", signed); await j.publish();
    const operatorUrl = await listen(service.createV3Service(j, { walletToken: TOKEN, adminToken: ADMIN }));
    const identity = (construction: Construction = POOL_V3 as Construction) => ({ operator, reference: { ...reference, label: label.slice() }, construction });
    const operatorClient = new V3ServiceClient(operatorUrl, TOKEN, identity());
    // The replica: its own shared file of complete evidence, its listener, and the prover's covers in that file.
    const replicaPath = join(directory, "replica.db"), replicaStore = new EvidenceStore(replicaPath, { shared: true }); closing.push(replicaStore);
    const replica = new V3Replica(replicaPath, replicaStore, venue.id);
    const replicaUrl = await listen(service.createV3EvidenceService(replica));
    const mirror = async () => { expect(replica.keep(await operatorClient.sync(backing, replicaStore))).toBe(true); };
    /** Commit and publish, moving the venue on where the schedule waits for it. */
    const checkpoint = async (id: string) => {
      for (let i = 0; ; i++) {
        try { await j.commit(id); break; } catch (error) {
          if ((error as { code?: string }).code !== "SCHEDULE" || i > 8) throw error;
          venue.advance(venue.witnessedIndex() + 1n);
        }
      }
      await j.publish();
    };
    // Issue a note, then spend it with a padding input: two proved records per checkpoint pair.
    const funded = output(31, 10n), pad = output(36, 0n);
    const issue = (out = funded, tag = 1) => encodeRecord(authorizeIssue(record(issueTask(context, out), tag), issuerSecret));
    const spend = (outputs: ReturnType<typeof output>[], tag: number) => {
      const tree = new NoteTree(); tree.append(funded.cm);
      const input = { note: funded, anchor: tree.root(), path: tree.path(0n) };
      return encodeRecord(record(spendTask(context, [input, { ...input, note: pad }], outputs), tag));
    };
    /** A reader of `construction` with its own evidence file, reading the frontier from `client`. */
    const read = async (construction: Construction, client: V3ServiceClient, name: string) => {
      const evidence = new EvidenceStore(join(directory, `${name}.db`), { construction }); closing.push(evidence);
      const served = await client.sync(backing, evidence);
      return { evidence, result: await outcome(readFrontier(served.package, signed, venue.witnessedIndex(),
        { construction, verifier, venue, reference, evidence })) };
    };
    return { j, venue, replica, replicaStore, replicaUrl, operatorUrl, identity, operatorClient, mirror, checkpoint, issue, spend, funded, read };
  }
  /** A supply that counts what each fetch returned. */
  const counting = (supply: CheckSupply) => {
    const asked = { covers: 0, answered: 0, proofs: 0, fetched: 0, places: [] as RecordAt[] };
    return { asked, supply: {
      cover: async (digest: bigint, accept?: (proof: Uint8Array) => Promise<boolean>) => { asked.covers++; const answer = await supply.cover(digest, accept); if (answer !== undefined) asked.answered++; return answer; },
      proof: async (hash: Uint8Array, at?: RecordAt) => {
        asked.proofs++; if (at !== undefined) asked.places.push(at);
        const answer = await supply.proof(hash, at); if (answer !== undefined) asked.fetched++; return answer;
      } } satisfies CheckSupply };
  };

  it("reads a backing succinctly through a replica: proof-free trails, covers by digest, the tail's proofs by place; equal to the complete read", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    await f.j.submit(f.spend([output(32, 7n), output(33, 1n), output(34, 2n), output(35, 0n)], 2)); await f.checkpoint("c3");
    await f.mirror();
    // A replica keeps covers under the identity of the set its prover proves for, never one a caller names apart.
    const { leaf, node } = testProver(SET, verifier);
    await expect(f.replica.prove({ leaf, node } as unknown as ReturnType<typeof testProver>)).rejects.toThrow(/prover of a set/);
    // The prover covers the two proved records and their node; walking again proves nothing new.
    expect(await f.replica.prove(testProver(SET, verifier))).toMatchObject({ trails: 1, proved: 2, made: 3 });
    expect(await f.replica.prove(testProver(SET, verifier))).toMatchObject({ trails: 1, proved: 2, made: 0 });
    // One more issue after the covers: the tail, which no cover reaches yet.
    await f.j.submit(f.issue(output(41, 5n), 3)); await f.checkpoint("c4");
    await f.mirror();

    const complete = await f.read(POOL_V3 as Construction, f.operatorClient, "complete");
    const counted = counting(serviceSupply(SET.identity, [new V3ServiceClient(f.replicaUrl, undefined, f.identity())]));
    const succinct = succinctPoolV3({ set: SET, supply: counted.supply });
    const read = await f.read(succinct, new V3ServiceClient(f.replicaUrl, undefined, f.identity(succinct)), "succinct");
    expect(read.result).toBe(complete.result);
    expect(JSON.parse(complete.result)).not.toHaveProperty("refused");
    // The segment is partitioned once over its latest checkpoint's trail (§3.4), though each checkpoint's new records are read on
    // the state kept before them: the two covered records by their node, the third fetched by its place (position 3).
    expect(counted.asked).toMatchObject({ covers: 2, answered: 1, fetched: 1, proofs: 1 });
    expect(counted.asked.places.map(at => at.position)).toEqual([3n]);
    // The reader's file holds proof-free records only, and is refused to a complete reader.
    const segment = f.replicaStore.keptTops()[0]!.segment;
    for (const position of [1n, 2n, 3n]) {
      const [kept] = read.evidence.recordsAt(segment, position);
      expect(kept!.length).toBeLessThan(1000);
      expect(decodeProofFree(kept!).proofHash).toEqual(sha256(decodeRecord(complete.evidence.recordsAt(segment, position)[0]!).proof));
    }
    read.evidence.close();
    expect(() => new EvidenceStore(join(directories.at(-1)!, "succinct.db"))).toThrow("another construction's evidence");
  });

  it("goes on proving from where its last walk of a segment stood, and stops before the next record when asked (slice 38)", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    await f.j.submit(f.spend([output(32, 7n), output(33, 1n), output(34, 2n), output(35, 0n)], 2)); await f.checkpoint("c3");
    await f.mirror();
    const inner = testProver(SET, verifier);
    let leaves = 0;
    const prover = { ...inner, leaf: async (record: Record) => { leaves++; return inner.leaf(record); } };
    // Stopped before its second record: the first leaf only.
    let asked = 0;
    expect(await f.replica.prove(prover, { stop: () => asked++ >= 1 })).toMatchObject({ made: 1, read: 1, stopped: true });
    // The next walk reads only the record after it: its leaf and the node over the two.
    expect(await f.replica.prove(prover)).toMatchObject({ trails: 1, proved: 2, made: 2, read: 1, stopped: false });
    expect(leaves).toBe(2);
    // Nothing new: no record is read again, so no leaf is asked for.
    expect(await f.replica.prove(prover)).toMatchObject({ proved: 2, made: 0, read: 0 });
    expect(leaves).toBe(2);
    // A new record: the walk goes on from the last one and proves its leaf alone (its node waits for a sibling).
    await f.j.submit(f.issue(output(41, 5n), 3)); await f.checkpoint("c4");
    await f.mirror();
    expect(await f.replica.prove(prover)).toMatchObject({ proved: 3, made: 1, read: 1 });
    expect(leaves).toBe(3);
  });

  it("proves over the trails of its own kept selections only, never a fork a supplier's answer brought, and reads nothing again (review)", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    await f.j.submit(f.spend([output(32, 7n), output(33, 1n), output(34, 2n), output(35, 0n)], 2)); await f.checkpoint("c3");
    await f.mirror();
    // A supplier's answer: the segment forked after its first record, two records no checkpoint commits.
    const segment = f.replicaStore.keptTops()[0]!.segment, first = f.replicaStore.recordsAt(segment, 1n)[0]!;
    const forked = encodeTrail({ header: segmentBytes(header), terms: [signed], records: [first, f.issue(output(51, 3n), 7), f.issue(output(52, 4n), 8)] });
    expect(await f.replicaStore.take([{ trail: { after: undefined, size: BigInt(forked.length), chunks: (async function* () { yield forked; })() } }], operator)).toBe(true);
    // The replica's next kept selection indexes every pending top, the fork's included.
    await f.j.submit(f.issue(output(41, 5n), 3)); await f.checkpoint("c4");
    await f.mirror();
    const inner = testProver(SET, verifier);
    let leaves = 0;
    const prover = { ...inner, leaf: async (record: Record) => { leaves++; return inner.leaf(record); } };
    expect(await f.replica.prove(prover)).toMatchObject({ trails: 1, proved: 3, read: 3 });
    expect(leaves).toBe(3);
    expect(await f.replica.prove(prover)).toMatchObject({ read: 0, made: 0 });
  });

  it("serves a trail's records in their proof-free form, the same chain values in both forms, sized before its records", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    const forms = async (source: V3EvidenceSource, free: boolean) => {
      const served = await source.serve(backing, 0n, free ? (await import("../src/pool/v3/succinct.js")).PROOF_FREE_FORM : undefined);
      const out: { size: bigint; bytes: number }[] = [];
      for await (const part of served.parts as AsyncIterable<EvidencePart>) {
        if ("package" in part) continue;
        let n = 0;
        for await (const chunk of part.trail.chunks) n += chunk.length;
        out.push({ size: part.trail.size, bytes: n });
      }
      return out;
    };
    for (const source of [f.j as unknown as V3EvidenceSource]) {
      const whole = await forms(source, false), free = await forms(source, true);
      expect(free).toHaveLength(whole.length);
      for (const [i, part] of free.entries()) {
        expect(part.size).toBe(BigInt(part.bytes));
        // One issue record: 14,656 proof bytes and a length replaced by 32 bytes of proofHash, under a longer context.
        expect(whole[i]!.bytes - part.bytes).toBeGreaterThan(COVER_PROOF_BYTES - 64);
      }
    }
  });

  it("answers a kept record's proof only at its place and by its hash, and a kept cover only under its set", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    await f.mirror();
    await f.replica.prove(testProver(SET, verifier));
    const client = new V3ServiceClient(f.replicaUrl, undefined, f.identity()), operatorClient = f.operatorClient;
    const proof = decodeRecord(f.issue()).proof, hash = sha256(proof), segment = f.replicaStore.keptTops()[0]!.segment;
    for (const source of [client, operatorClient]) {
      expect(await source.proof(hash, { segment, position: 1n })).toEqual(proof);
      expect(await source.proof(hash, { segment, position: 2n })).toBeUndefined();
      expect(await source.proof(sha256(hash), { segment, position: 1n })).toBeUndefined();
      expect(await source.proof(hash, { segment: b(3), position: 1n })).toBeUndefined();
    }
    const leaf = decodeRecord(f.issue()), digest = (await import("../src/pool/v3/succinct.js")).statementLeafDigest(leaf.kind, leaf.publicInputs, hash);
    expect(await client.cover(SET.identity, digest)).toEqual(SET.cover(leaf.kind, digest));
    expect(await client.cover(testCheckSet("another").identity, digest)).toBeUndefined();
    // A journal keeps no covers.
    expect(await operatorClient.cover(SET.identity, digest)).toBeUndefined();
  });

  it("passes over hostile suppliers: a wrong or overlong proof and a wrong cover change nothing, a forged proof-free record is refused", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    await f.j.submit(f.spend([output(32, 7n), output(33, 1n), output(34, 2n), output(35, 0n)], 2)); await f.checkpoint("c3");
    await f.mirror();
    await f.replica.prove(testProver(SET, verifier));
    const complete = await f.read(POOL_V3 as Construction, f.operatorClient, "complete");
    // Hostile sources first, each serving the replica's stream: one answers every cover wrong, one every proof with
    // junk, one every proof past §5's bound; none has the other.
    const asked = { covers: 0, junk: 0, long: 0 };
    const serve: V3EvidenceSource["serve"] = (backingIn, after, form) => f.replica.serve(backingIn, after, form);
    const hostile: V3EvidenceSource = { serve, proof: () => undefined, cover: (_set, digest) => { asked.covers++; return sha256(digest); } };
    const junk: V3EvidenceSource = { serve, proof: () => { asked.junk++; return new Uint8Array(COVER_PROOF_BYTES); }, cover: () => undefined };
    const long: V3EvidenceSource = { serve, proof: () => { asked.long++; return new Uint8Array(131_073); }, cover: () => undefined };
    const hostileUrl = await listen(service.createV3EvidenceService(hostile));
    const sources = [hostileUrl, await listen(service.createV3EvidenceService(junk)), await listen(service.createV3EvidenceService(long))]
      .map(url => new V3ServiceClient(url, undefined, f.identity()));
    const counted = counting(serviceSupply(SET.identity, [...sources, new V3ServiceClient(f.operatorUrl, TOKEN, f.identity())]));
    const succinct = succinctPoolV3({ set: SET, supply: counted.supply });
    const read = await f.read(succinct, new V3ServiceClient(hostileUrl, undefined, f.identity(succinct)), "hostile");
    expect(read.result).toBe(complete.result);
    // The reader's own check refuses the wrong cover inside the supply, so no cover is taken: each record is checked
    // natively, its proof given by the operator after the junk and the overlong answer. Each wrong source was asked
    // once, never again by that supply (audit 34); the operator, which answered last, was asked first for the second.
    // The segment's one partition asked the node, then each leaf (§3.4).
    expect(counted.asked).toMatchObject({ covers: 3, answered: 0, fetched: 2 });
    expect(asked).toEqual({ covers: 1, junk: 1, long: 1 });

    // A source that changes one byte of a proof-free record: the evidence chain refuses the trail, so the sync does.
    const forging: V3EvidenceSource = { ...hostile, serve: async (backingIn, after, form) => {
      const served = await f.replica.serve(backingIn, after, form);
      return { ...served, parts: (async function* () {
        for await (const part of served.parts as AsyncIterable<EvidencePart>) {
          if ("package" in part) { yield part; continue; }
          const chunks: Uint8Array[] = [];
          for await (const chunk of part.trail.chunks) chunks.push(Uint8Array.from(chunk));
          const last = chunks.at(-1)!; last[last.length - 1]! ^= 1;
          yield { trail: { ...part.trail, chunks: chunks } };
        }
      })() };
    } };
    const forgingUrl = await listen(service.createV3EvidenceService(forging));
    const evidence = new EvidenceStore(join(directories.at(-1)!, "forged.db"), { construction: succinct }); closing.push(evidence);
    await expect(new V3ServiceClient(forgingUrl, undefined, f.identity(succinct)).sync(backing, evidence)).rejects.toThrow("does not assemble");
  });

  it("serves a long trail as parts of a bounded count, each based on the last, whole and after a reader's mark (review B1)", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    await f.j.submit(f.spend([output(32, 7n), output(33, 1n), output(34, 2n), output(35, 0n)], 2)); await f.checkpoint("c3");
    await f.mirror();
    const { PROOF_FREE_FORM } = await import("../src/pool/v3/succinct.js"), one = { ...PROOF_FREE_FORM, piece: 1 };
    // The replica's stream with one record a part: two parts, sized as sent, the second after the tip the first reached.
    const parts: { after?: bigint; size: bigint; bytes: number }[] = [];
    for await (const part of (await f.replica.serve(backing, 0n, one)).parts as AsyncIterable<EvidencePart>) {
      if ("package" in part) continue;
      let n = 0; for await (const chunk of part.trail.chunks) n += chunk.length;
      parts.push({ ...(part.trail.after === undefined ? {} : { after: part.trail.after.position }), size: part.trail.size, bytes: n });
    }
    expect(parts.map(p => p.after)).toEqual([undefined, 1n]);
    expect(parts.every(p => p.size === BigInt(p.bytes))).toBe(true);
    // A reader served one record a part, from nothing and then after its mark, reads as the complete read does.
    const piecewise: V3EvidenceSource = { serve: (b, after) => f.replica.serve(b, after, one), proof: (h, at) => f.replica.proof(h, at),
      cover: (s, d) => f.replica.cover(s, d) };
    const url = await listen(service.createV3EvidenceService(piecewise));
    const succinct = succinctPoolV3({ set: SET, supply: serviceSupply(SET.identity, [new V3ServiceClient(url, undefined, f.identity())]) });
    const client = new V3ServiceClient(url, undefined, f.identity(succinct));
    const evidence = new EvidenceStore(join(directories.at(-1)!, "pieces.db"), { construction: succinct }); closing.push(evidence);
    await client.sync(backing, evidence);
    await f.j.submit(f.issue(output(41, 5n), 3)); await f.j.submit(f.issue(output(46, 4n), 4)); await f.checkpoint("c4");
    await f.mirror();
    const served = await client.sync(backing, evidence);
    const read = await outcome(readFrontier(served.package, signed, f.venue.witnessedIndex(), { construction: succinct, verifier, venue: f.venue, reference, evidence }));
    expect(read).toBe((await f.read(POOL_V3 as Construction, f.operatorClient, "complete")).result);
  });

  it("carries each part's tip forward over the records it sent: the kept chain values, one chain step a record at any part size (review B1)", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    await f.j.submit(f.spend([output(32, 7n), output(33, 1n), output(34, 2n), output(35, 0n)], 2));
    await f.j.submit(f.issue(output(41, 5n), 3)); await f.j.submit(f.issue(output(46, 4n), 4)); await f.checkpoint("c3");
    await f.mirror();
    const { PROOF_FREE_FORM } = await import("../src/pool/v3/succinct.js"), { formParts } = await import("../src/pool/v3/evidence-store.js");
    const [top] = f.replicaStore.keptTops(), kept = f.replicaStore.retained();
    try {
      const trail = kept.trail(top!.segment, top!.evidence)!;
      expect(trail.length).toBe(4n);
      for (const piece of [1, 3, 2048]) {
        let steps = 0;
        const counting = { ...POOL_V3, reader: { ...POOL_V3.reader, digests: (bytes: Uint8Array) => { steps++; return POOL_V3.reader.digests(bytes); } } } as Construction;
        const tips: bigint[] = [];
        for await (const part of formParts(trail, undefined, counting, { ...PROOF_FREE_FORM, piece })) {
          if ("package" in part) continue;
          const after = part.trail.after;
          if (after !== undefined) { tips.push(after.position); expect(after.evidence).toEqual(trail.evidence(after.position)); }
        }
        expect(steps).toBe(4);
        expect(tips).toEqual(piece === 1 ? [1n, 2n, 3n] : piece === 3 ? [3n] : []);
      }
    } finally { kept.release(); }
  });

  it("takes a cover from an honest source behind a wrong one, asks a silent source once, and stops at the holder's own proxy refusal", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    await f.j.submit(f.spend([output(32, 7n), output(33, 1n), output(34, 2n), output(35, 0n)], 2)); await f.checkpoint("c3");
    await f.mirror();
    await f.replica.prove(testProver(SET, verifier));
    const complete = await f.read(POOL_V3 as Construction, f.operatorClient, "complete");
    let wrongAsks = 0;
    const wrong: V3EvidenceSource = { serve: (b, after, form) => f.replica.serve(b, after, form), proof: () => undefined,
      cover: (_s, digest) => { wrongAsks++; return sha256(digest); } };
    const wrongUrl = await listen(service.createV3EvidenceService(wrong));
    // A listener closed before it is asked: nothing answers there.
    const closed = service.createV3EvidenceService(wrong), closedUrl = await listen(closed);
    await new Promise<void>(done => { closed.close(() => done()); });
    const silent = new V3ServiceClient(closedUrl, undefined, f.identity());
    let silentAsks = 0;
    const silentCover = silent.cover.bind(silent);
    silent.cover = async (set, digest) => { silentAsks++; return silentCover(set, digest); };
    const sources = [silent, new V3ServiceClient(wrongUrl, undefined, f.identity()), new V3ServiceClient(f.replicaUrl, undefined, f.identity())];
    const counted = counting(serviceSupply(SET.identity, sources));
    const succinct = succinctPoolV3({ set: SET, supply: counted.supply });
    const read = await f.read(succinct, new V3ServiceClient(f.replicaUrl, undefined, f.identity(succinct)), "behind");
    expect(read.result).toBe(complete.result);
    // The node over both records came from the replica behind the wrong source; no proof was fetched; the silent source
    // and the one whose cover the reader refused were each asked once (audit 34).
    expect(counted.asked).toMatchObject({ covers: 1, answered: 1, proofs: 0 });
    expect([silentAsks, wrongAsks]).toEqual([1, 1]);
    // A source that has none is asked again only where the source that answered last has none too.
    let noneAsks = 0;
    const none = { cover: async () => { noneAsks++; return undefined; }, proof: async () => undefined } as unknown as V3ServiceClient;
    const holding = { cover: async (_s: Uint8Array, digest: bigint) => digest === 1n ? Uint8Array.of(1) : undefined } as unknown as V3ServiceClient;
    const ordered = serviceSupply(SET.identity, [none, holding]);
    expect([await ordered.cover(1n), await ordered.cover(1n), await ordered.cover(2n)]).toEqual([Uint8Array.of(1), Uint8Array.of(1), undefined]);
    expect(noneAsks).toBe(2);
    // The holder's own proxy refusing the route ends the fetch, as it ends a sync.
    const proxied = new V3ServiceClient(f.replicaUrl, undefined, f.identity());
    proxied.cover = async () => { throw new V3ServiceClientError(0, "PROXY", "the proxy refused the tunnel (403)"); };
    await expect(serviceSupply(SET.identity, [proxied, sources[2]!]).cover(1n)).rejects.toMatchObject({ code: "PROXY" });
  });

  it("keeps the two forms apart: a proof-free replica refuses the complete form, and a store of one form syncs from no client of the other", async () => {
    const f = await fixture();
    await f.j.submit(f.issue()); await f.checkpoint("c2");
    const succinct = succinctPoolV3({ set: SET, supply: { cover: () => undefined, proof: () => undefined } });
    const directory = directories.at(-1)!;
    const freePath = join(directory, "free-replica.db"), freeStore = new EvidenceStore(freePath, { construction: succinct, shared: true }); closing.push(freeStore);
    const freeReplica = new V3Replica(freePath, freeStore, f.venue.id);
    expect(freeReplica.keep(await new V3ServiceClient(f.operatorUrl, TOKEN, f.identity(succinct)).sync(backing, freeStore))).toBe(true);
    await expect(freeReplica.serve(backing, 0n)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(freeReplica.prove(testProver(SET, verifier))).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const completeStore = new EvidenceStore(join(directory, "complete.db")); closing.push(completeStore);
    await expect(new V3ServiceClient(f.operatorUrl, TOKEN, f.identity(succinct)).sync(backing, completeStore)).rejects.toThrow("another construction");
  });
});

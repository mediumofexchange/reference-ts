// Real-proof C2b.5.1–2 counts against the strictly-before canonical state.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { limbsOf } from "../../../dist/pool/field.js";
import { poseidon2Hash } from "../../../dist/pool/poseidon2.js";
import { directoryRoot, encodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR, signCommitment } from "../../../dist/venue-records.js";
import { LIMITS } from "../delivery/evidence-reader.mjs";
import { replayLocalPackage } from "./local-replay.mjs";

const b = n => new Uint8Array(32).fill(n);
const hex = bytes => Buffer.from(bytes).toString("hex");
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());

export async function checkNonService({ codec, verifier, prove, test, compose, checkpoint, segment, reference,
  publication, demand, note, domain, venue, backing, signedTerms, operatorSecret, ruleSecret, payerSeed,
  original, originalOpening, originalState, originalTree, issuance, funded, firstDemand,
  ancestry, publications, finalCheckpoint, paid, change }) {
  const base = [originalOpening, originalState], operator = ed25519.getPublicKey(operatorSecret);
  async function request(input, tree, position, refresh, label) {
    const path = tree.path(position), tag = poseidon2Hash([1007n, input.nf]);
    const publicInputs = [...limbsOf(domain), ...limbsOf(backing), tree.root(), tag, refresh];
    return prove(7, { domain: limbsOf(domain).map(String), backing: limbsOf(backing).map(String),
      anchor: tree.root().toString(), tag: tag.toString(), refresh: refresh.toString(), note: note(input),
      secret: input.secret.toString(), siblings: path.siblings.map(String), right: [...path.right] },
    publicInputs, [], label);
  }
  const first = await request(funded, originalTree, 0n, 0n, "non-service original request");
  const refresh = await request(funded, originalTree, 0n, 1n, "non-service holder refresh");
  const pub = (at, record = first) => publication(at, 5, record);
  const query = (entries, t = 7n, cps = base, selected = cps.at(-1)) => compose(cps, selected, entries, t);
  async function counted(payload, count, snapshotIndex = "2", incumbent = operator) {
    const answer = await replayLocalPackage(payload, verifier, codec);
    assert.equal(answer.status, "selected-local-replay", JSON.stringify(answer));
    assert.deepEqual(answer.audit.range.nonService, { duration: "2", threshold: "1", window: "5",
      count: String(count), fires: count >= 1, incumbent: hex(incumbent), snapshotIndex });
    return answer;
  }
  const payload = query([pub(2n)]);
  let result;
  await test("non-service includes both window endpoints and excludes adjacent indices", async () => {
    result = await counted(payload, 1);
    for (const [at, expected] of [[1n, 0], [2n, 1], [5n, 1], [6n, 0]]) await counted(query([pub(at)]), expected);
    assert.deepEqual((await replayLocalPackage({ ...payload, seed: payerSeed }, verifier, codec)).audit, result.audit);
  });
  await test("republication cannot extend an identity's window and refreshes still count one tag", async () => {
    await counted(query([pub(1n), pub(3n), pub(5n)]), 0);
    await counted(query([pub(1n), pub(3n, refresh), pub(5n, refresh)]), 1);
    await counted(query([pub(2n), pub(3n, refresh), pub(5n)]), 1);
  });
  await test("valid later proof evidence retains the first identity index and must precede judging", async () => {
    const invalid = structuredClone(first); invalid.proof[0] ^= 1;
    await counted(query([pub(2n, invalid), pub(6n)]), 1);
    await counted(query([pub(1n, invalid), pub(3n)]), 0);
    await counted(query([pub(2n, invalid), pub(7n)]), 0);
    const forgedRefresh = structuredClone(first); forgedRefresh.publicInputs[6] = 2n;
    await counted(query([pub(2n, forgedRefresh)]), 0);
  });
  await test("wrong proof domains, publication routing and uncertified real anchors cannot count", async () => {
    const foreign = structuredClone(first); foreign.domain = b(212); foreign.publicInputs.splice(0, 2, ...limbsOf(foreign.domain));
    const foreignBytes = codec.encodePublication({ domain: foreign.domain, backing, kind: 5, record: foreign });
    // Mutate only the outer backing, leaving a real valid inner proof: decoding
    // must reject this routing mismatch before counting or deduplication.
    const misrouted = pub(2n), offset = Buffer.from(misrouted.bytes).indexOf(Buffer.from(backing));
    assert(offset >= 0); misrouted.bytes[offset] ^= 1;
    await counted(query([{ at: 2n, bytes: foreignBytes }, misrouted]), 0);
    // A valid proof against a later, real tree is not membership in the
    // canonical forest selected here.
    const future = await request(paid, finalCheckpoint.tree, 1n, 0n, "non-service uncertified future anchor");
    await counted(query([pub(2n, future)]), 0);
  });
  await test("spent tags clear a request only after the spending checkpoint's index", async () => {
    const standing = [...publications, pub(10n)];
    await counted(query(standing, 12n, ancestry.slice(0, 4)), 1, "11");
    await counted(query(standing, 13n, ancestry), 0, "12");
  });
  await test("a canonical demand serves its tag through its deadline, then expires", async () => {
    const lock = await demand(original, funded, originalTree, b(213), 1n, 5n, "non-service canonical expiring lock");
    const locked = checkpoint(original, 3n, 3n, [issuance, lock],
      [{ outputs: [funded.cm], nullifiers: [] }, { outputs: [], nullifiers: [] }], 10n);
    await counted(query([pub(2n)], 5n, [...base, locked]), 0, "3");
    await counted(query([pub(2n)], 6n, [...base, locked]), 1, "3");
    // At its own index the new lock is not the counting state yet.
    await counted(query([pub(1n)], 3n, [...base, locked]), 1, "2");
  });
  await test("an unadopted recovery publication does not change the canonical count", async () => {
    await counted(query([pub(5n), publication(8n, 1, firstDemand)], 10n), 1);
  });
  await test("distinct real unspent tags count separately in the same canonical state", async () => {
    const a = await request(paid, finalCheckpoint.tree, 1n, 1n, "non-service paid output");
    const c = await request(change, finalCheckpoint.tree, 2n, 0n, "non-service change output");
    await counted(query([...publications, pub(10n, a), pub(11n, c)], 14n, ancestry), 2, "13");
  });
  await test("excluded and noncarrying checkpoints preserve the earlier counting state", async () => {
    const excluded = checkpoint(original, 3n, 4n, [issuance, firstDemand, firstDemand],
      [{ outputs: [funded.cm], nullifiers: [] }, { outputs: [], nullifiers: [] }, { outputs: [], nullifiers: [] }], 10n);
    await counted(query([pub(2n)], 5n, [...base, excluded], originalState), 1);
    const directory = [], dropped = { ...originalOpening, at: 4n, sequence: 3n, directory,
      commitment: signCommitment(operatorSecret, 3n, directoryRoot(directory)) };
    await counted(query([pub(2n)], 5n, [...base, dropped], originalState), 1);
  });
  await test("the successor inherits standing requests and the count names the incumbent", async () => {
    const secret = b(214), successor = ed25519.getPublicKey(secret);
    const fields = { role: ROLE_OPERATOR, successor, predecessor: backing, effective: 5n,
      signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(backing, fields), signed = { ...fields,
      signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, secret) };
    const header = codec.segmentBytes({ domain, venue, operator: successor, sequence: 1n,
      entries: [{ backing, link: replacementHash(backing, signed), opening: reference(originalState) }] });
    const ctx = { ...segment(1n), header, id: hash(header) };
    const opening = checkpoint(ctx, 1n, 5n, [], [], 10n);
    opening.commitment = signCommitment(secret, 1n, directoryRoot(opening.directory));
    const inherited = query([pub(2n)], 6n, [...base, opening]);
    inherited.selection.operator = successor;
    inherited.venue.records.find(r => r.kind === 1 && r.index === 5n).subject = successor;
    inherited.venue.records.push({ kind: 2, subject: backing, index: 0n, record: encodeReplacement(backing, signed) });
    await counted(inherited, 1, "5", successor);
  });
  await test("missing request ranges or ancestry evidence and tampered terms expose no partial count", async () => {
    const unavailable = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range: request => request.kind === 4 ? undefined : record.range(request) }; } };
    const missing = structuredClone(payload); missing.package.snapshots = [];
    const tampered = structuredClone(payload), signature = new Uint8Array(signedTerms.signature); signature[0] ^= 1;
    tampered.package.trail = codec.encodeTrail({ header: original.header,
      terms: [{ terms: signedTerms.terms, signature }], records: [codec.encodeRecord(issuance)] }, LIMITS);
    // Terms are resolved by name from any supplied field (pool-v3 §12.1): tamper every copy of the segment's field.
    tampered.package.trails = tampered.package.trails.map(bytes => {
      const trail = codec.decodeTrail(bytes, LIMITS);
      return Buffer.compare(trail.header, original.header) === 0 ? codec.encodeTrail({ ...trail, terms: [{ terms: signedTerms.terms, signature }] }, LIMITS) : bytes;
    });
    for (const [p, v, status] of [[payload, unavailable, "unresolved-evidence"], [missing, verifier, "unresolved-evidence"],
      [tampered, verifier, "unresolved-evidence"]]) {
      const answer = await replayLocalPackage(p, v, codec);
      assert.equal(answer.status, status); assert.equal(answer.audit, null);
      assert.deepEqual(answer.candidates, []); assert.equal(answer.spendable, false);
    }
  });
  return { payload, result };
}

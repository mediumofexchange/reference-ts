// C2b.5.1–2 scope counts reuse the already-proved scope and recovery traces.
// Only the segment-free requests below require additional proofs.
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { limbsOf } from "../../../dist/pool/field.js";
import { poseidon2Hash } from "../../../dist/pool/poseidon2.js";
import { directoryRoot, signCommitment } from "../../../dist/venue-records.js";
import { replayLocalPackage, RANGE_LIMITS } from "./local-replay.mjs";

const hex = bytes => Buffer.from(bytes).toString("hex");
const same = (a, b) => Buffer.compare(a, b) === 0;

function countChecks({ codec, verifier, prove, domain, note, operatorSecret }) {
  const operator = ed25519.getPublicKey(operatorSecret);
  async function request(input, tree, position, refresh, label) {
    const path = tree.path(position), tag = poseidon2Hash([1007n, input.nf]);
    return prove(7, { domain: limbsOf(domain).map(String), backing: limbsOf(input.backing).map(String),
      anchor: tree.root().toString(), tag: tag.toString(), refresh: refresh.toString(), note: note(input),
      secret: input.secret.toString(), siblings: path.siblings.map(String), right: [...path.right] },
    [...limbsOf(domain), ...limbsOf(input.backing), tree.root(), tag, refresh], [], label);
  }
  async function counted(payload, count, snapshotIndex, clause = [2, 1, 20], incumbent = operator) {
    const answer = await replayLocalPackage(payload, verifier, codec);
    assert.equal(answer.status, "selected-local-replay", JSON.stringify(answer));
    const [duration, threshold, window] = clause;
    assert.deepEqual(answer.audit.range.nonService, { duration: String(duration), threshold: String(threshold),
      window: String(window), count: String(count), fires: count >= threshold, incumbent: hex(incumbent),
      snapshotIndex: snapshotIndex === null ? null : String(snapshotIndex) });
    return answer;
  }
  async function refused(payload, v = verifier) {
    const answer = await replayLocalPackage(payload, v, codec);
    assert.equal(answer.status, "unresolved-evidence", JSON.stringify(answer));
    assert.equal(answer.audit, null); assert.deepEqual(answer.candidates, []); assert.equal(answer.spendable, false);
  }
  return { request, counted, refused, operator };
}

export async function checkNormalScopeCounts(options) {
  const { codec, verifier, test, domain, operatorSecret, successorSecret, checkpoint, compose, x, y,
    a0, a1, x0, y0, x1, y1, j0, j1, history, toB, toA, fundedX, paidX, issuanceX, issuanceY, effect, receipts } = options;
  const { request, counted, refused, operator } = countChecks(options);
  const first = await request(fundedX, a1.tree, 0n, 0n, "scope non-service shared anchor");
  const refresh = await request(fundedX, a1.tree, 0n, 1n, "scope non-service holder refresh");
  const paid = await request(paidX, x1.tree, 0n, 0n, "scope non-service imported payment anchor");
  const pub = (at, record = first) => ({ backing: x, at, bytes: codec.encodePublication({ domain, backing: x, kind: 5, record }) });
  const query = (publications, at, checkpoints = [a0, a1], selected = checkpoints.at(-1), backing = x, replacements = []) =>
    compose(checkpoints, selected, backing, replacements, at, publications);
  const payload = query([pub(2n), pub(10n, paid)], 13n, [...history, j0], j0, x, [toB, toA]);
  const payloadY = query([pub(2n), pub(10n, paid)], 13n, [...history, j0], j0, y, [toB, toA]);
  let result, resultY;
  await test("scoped non-service needs no silence clause and an absent clause exposes no count", async () => {
    await counted(query([pub(0n)], 1n, [a0], a0), 0, null);
    await counted(query([pub(5n)], 5n), 0, 2);
    await counted(query([pub(2n)], 5n), 1, 2);
    result = await counted(payload, 1, 12);
    resultY = await replayLocalPackage(payloadY, verifier, codec);
    assert.equal(resultY.status, "selected-local-replay", JSON.stringify(resultY));
    assert.equal(resultY.audit.range.nonService, undefined);
    const noRequests = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range: req => req.kind === 4 ? undefined : record.range(req) }; } };
    assert.deepEqual(await replayLocalPackage(payloadY, noRequests, codec), resultY);
    assert.deepEqual(await replayLocalPackage(receipts.payload, noRequests, codec), receipts.result);
  });
  await test("scope counts inherit shared requests across handover and imported anchors across rejoin", async () => {
    await counted(query([pub(2n)], 7n, [a0, a1, x0, y0], x0, x, [toB]), 1, 6,
      [2, 1, 20], ed25519.getPublicKey(successorSecret));
    await counted(query([pub(2n), pub(10n, paid)], 13n, [...history, j0], j0, x, [toB, toA]), 1, 12,
      [2, 1, 20], operator);
  });
  await test("scoped counting excludes a same-index spend and includes it only at the following index", async () => {
    await counted(query([pub(2n)], 8n, [a0, a1, x0, y0, x1], x1, x, [toB]), 1, 6,
      [2, 1, 20], ed25519.getPublicKey(successorSecret));
    await counted(query([pub(2n)], 9n, history, x1, x, [toB]), 0, 8,
      [2, 1, 20], ed25519.getPublicKey(successorSecret));
    await counted(query([pub(10n, paid)], 14n, [...history, j0, j1], j1, x, [toB, toA]), 1, 12);
    await counted(query([pub(10n, paid)], 15n, [...history, j0, j1], j1, x, [toB, toA]), 0, 14);
  });
  await test("scope request windows retain first identity indices while valid refreshes count one tag", async () => {
    for (const [at, expected] of [[1n, 0], [2n, 1], [20n, 1], [21n, 0]]) {
      await counted(query([pub(at)], 22n), expected, 2);
    }
    await counted(query([pub(1n), pub(3n), pub(20n)] , 22n), 0, 2);
    await counted(query([pub(1n), pub(3n, refresh), pub(20n, refresh)], 22n), 1, 2);
    await counted(query([pub(2n), pub(3n, refresh)], 22n), 1, 2);
    const invalid = structuredClone(first); invalid.proof[0] ^= 1;
    await counted(query([pub(2n, invalid), pub(21n)], 22n), 1, 2);
    await counted(query([pub(1n, invalid), pub(3n)], 22n), 0, 2);
    await counted(query([pub(2n, invalid), pub(22n)], 22n), 0, 2);
  });
  await test("a dropped backing and excluded scoped tail preserve the last carrying count", async () => {
    const directory = [], dropped = { ...a1, at: 4n, directory,
      commitment: signCommitment(operatorSecret, 3n, directoryRoot(directory)) };
    await counted(query([pub(2n)], 5n, [a0, a1, dropped], a1), 1, 2);
    const excluded = checkpoint(a1.ctx, 3n, 4n, [issuanceX, issuanceY, issuanceY],
      [effect([fundedX]), a1.effects[1], effect([])]);
    await counted(query([pub(2n)], 5n, [a0, a1, excluded], a1), 1, 2);
    // y continues at9 after x's last checkpoint at8; the count must retain x8.
    await counted(query([pub(6n, paid)], 10n, history, x1, x, [toB]), 1, 8,
      [2, 1, 20], ed25519.getPublicKey(successorSecret));
  });
  await test("malformed scoped request routing and uncertified later anchors never contribute", async () => {
    const wrong = pub(2n), offset = Buffer.from(wrong.bytes).indexOf(Buffer.from(x));
    assert(offset >= 0); wrong.bytes.set(y, offset);
    await counted(query([wrong, pub(2n, paid)], 5n), 0, 2);
    const foreign = structuredClone(first); foreign.domain = new Uint8Array(32).fill(233);
    foreign.publicInputs.splice(0, 2, ...limbsOf(foreign.domain));
    await counted(query([{ backing: x, at: 2n, bytes: codec.encodePublication({ domain: foreign.domain,
      backing: x, kind: 5, record: foreign }) }], 5n), 0, 2);
  });
  await test("scoped count refuses missing request ranges and unselected ancestry without partial results", async () => {
    const unavailable = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range: req => req.kind === 4 && same(req.subject, x) ? undefined : record.range(req) }; } };
    await refused(payload, unavailable);
    const missing = structuredClone(payload);
    missing.package.snapshots = missing.package.snapshots.filter(bytes => !y1.snapshots.some(s => same(s, bytes)));
    await refused(missing);
  });
  return { payload, result, payloadY, resultY };
}

export async function checkRecoveryScopeCounts(options) {
  const { codec, verifier, test, compose, publication, x, y, a0, a1, x0, y0, j0, adopted, final,
    ancestry, publications, fundedX, fundedY, sx, standingCheckpoints } = options;
  const { request, counted, refused } = countChecks(options);
  const firstX = await request(fundedX, a1.tree, 0n, 0n, "scope recovery non-service x");
  const firstY = await request(fundedY, a1.tree, 1n, 0n, "scope recovery non-service y");
  const settled = await request(sx.output, adopted.tree, 0n, 0n, "scope recovery non-service issuer note");
  const pub = (backing, at, record = same(backing, x) ? firstX : firstY) => publication(backing, at, 5, record);
  const query = (entries, at, cps = ancestry, selected = cps.at(-1), backing = x) => compose(cps, selected, entries, backing, at);
  const clauseY = [3, 2, 12], entries = [...publications, pub(x, 8n), pub(y, 8n)];
  const payload = query(entries, 13n, ancestry, j0), payloadY = query(entries, 13n, ancestry, j0, y);
  let result, resultY;
  await test("recovery counts each selected backing under its own duration threshold and window", async () => {
    result = await counted(payload, 1, 12); resultY = await counted(payloadY, 1, 12, clauseY);
    await counted(query([pub(x, 3n), pub(y, 3n)], 5n, [a0, a1, x0, y0], x0, x), 1, 3);
    await counted(query([pub(x, 3n), pub(y, 3n)], 5n, [a0, a1, x0, y0], y0, y), 0, 4, clauseY);
    await counted(query([pub(x, 2n), pub(y, 2n)], 15n, ancestry, j0), 1, 12);
    await counted(query([pub(x, 2n), pub(y, 2n)], 15n, ancestry, j0, y), 0, 12, clauseY);
  });
  await test("unadopted force publications preserve both counts until strictly after adoption", async () => {
    for (const [backing, clause] of [[x, [2, 1, 20]], [y, clauseY]]) {
      await counted(query(entries, 13n, [...ancestry, adopted], adopted, backing), 1, 12, clause);
      await counted(query(entries, 14n, [...ancestry, adopted], adopted, backing), 0, 13, clause);
    }
  });
  await test("recovery settlement anchors certify requests only after adoption and spends only after checkpoint", async () => {
    const entries = [...publications, pub(x, 10n, settled)];
    await counted(query(entries, 13n, [...ancestry, adopted], adopted), 0, 12);
    await counted(query(entries, 14n, [...ancestry, adopted, final], final), 1, 13);
    await counted(query(entries, 15n, [...ancestry, adopted, final], final), 0, 14);
  });
  await test("imported canonical locks last through the deadline and withdrawals take effect strictly after their index", async () => {
    const { locked, opening, continued } = standingCheckpoints, cps = [a0, a1, locked, opening, continued];
    await counted(query([pub(y, 0n)], 3n, [a0, a1, locked], locked, y), 1, 2, clauseY);
    await counted(query([pub(y, 1n)], 4n, [a0, a1, locked, opening], opening, y), 0, 3, clauseY);
    await counted(query([pub(y, 1n)], 5n, cps, continued, y), 0, 4, clauseY);
    await counted(query([pub(y, 1n)], 6n, cps, continued, y), 1, 5, clauseY);
    await counted(query([pub(y, 27n)], 30n, [a0, a1, locked, opening], opening, y), 0, 4, clauseY);
    await counted(query([pub(y, 27n)], 31n, [a0, a1, locked, opening], opening, y), 1, 4, clauseY);
  });
  await test("recovery request routing cannot cross-count backings sharing the same note anchor", async () => {
    await counted(query([...publications, pub(y, 8n)], 13n), 0, 12);
    await counted(query([...publications, pub(x, 8n)], 13n, ancestry, j0, y), 0, 12, clauseY);
    const bad = pub(x, 8n), offset = Buffer.from(bad.bytes).indexOf(Buffer.from(x));
    assert(offset >= 0); bad.bytes.set(y, offset);
    await counted(query([...publications, bad], 13n), 0, 12);
  });
  await test("missing unselected recovery publication evidence refuses the complete count", async () => {
    const unavailable = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range: req => req.kind === 4 && same(req.subject, y) ? undefined : record.range(req) }; } };
    await refused(payload, unavailable);
  });
  await test("request ranges cannot reuse a global venue ordinal across backing subjects", async () => {
    const contradictory = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range(req) {
        const bytes = record.range(req);
        if (req.kind !== 4 || !same(req.subject, y) || bytes === undefined) return bytes;
        const answer = codec.decodeRangeAnswer(bytes, req, RANGE_LIMITS);
        return codec.encodeRangeAnswer({ ...answer, entries: answer.entries.map(e => e.index === 8n
          ? { ...e, ordinal: 0n } : e) }, RANGE_LIMITS);
      } }; } };
    await refused(payload, contradictory);
  });
  return { payload, result, payloadY, resultY };
}

// The holder's per-workload rates in a browser engine (slice 46, check.mjs --rates): the phone-class proxy's
// JavaScript parts (slice 33's probe at 4cd16ee, scripts/pool/aggregation-probe/phone.mjs) in a worker of the page,
// over the browser bundle's substitutes, so that a throttled engine (throttle.mjs) or a served device times them:
// - replay: the operator journal's package of one issue and a chain of spends, read by `readPackage` with stand-in
//   proofs of the configuration's length judged by a stub (proof verification is timed by --proofs);
// - digests: succinct reading's leaf digest of each of those records' proof-free forms and the node digests over them
//   (succinct-read §3.3), as a phone recomputes them below a cover;
// - headers: the Ergo header store's full child check (parse, id, link, height, timestamp, required difficulty, proof
//   of work) over a synthetic difficulty-4 chain above an anchor at an epoch boundary, mined first (untimed).
// The journal keeps its files in the worker's file pool (files.ts), removed at the end.
import "./test-host.mjs";
import { mkdirSync, rmSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { mountFiles } from "../../src/browser/files.js";
import { ANCHOR_CONTEXT, autolykosPowValid, ergoHeaderStore, parseErgoHeader } from "../../src/ergo-headers.js";
import { NoteTree } from "../../src/pool/note-tree.js";
import { prepareExactOutput } from "../../src/pool/v3/capsules.js";
import { adoptedConfiguration, configurationHash, PROOF_BYTES } from "../../src/pool/v3/configuration.js";
import { readPackage } from "../../src/pool/v3/package-reader.js";
import { decodeRecord, encodeRecord, proofFreeOf } from "../../src/pool/v3/records.js";
import { V3OperatorJournal } from "../../src/pool/v3/store.js";
import { leafDigest, nodeDigest } from "../../src/pool/v3/succinct.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../../src/pool/v3/terms.js";
import { authorizeIssue, issueTask, spendTask } from "../../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../../src/record-venue.js";
import { finish, memory, report } from "./worker-report.mjs";

const SPENDS = 300, READS = 2, HEADERS = 300;
const b = n => new Uint8Array(32).fill(n);
const rid = (tag, n) => { const r = new Uint8Array(32); r[0] = tag; new DataView(r.buffer).setUint32(28, n); return r; };
const phases = [];
async function phase(name, body, count) {
  const started = performance.now();
  const value = await body();
  const ms = performance.now() - started;
  const entry = { name, ms: Math.round(ms), ...(count === undefined ? {} : { count, perMs: Math.round(ms / count * 1000) / 1000 }), memoryBytes: await memory() };
  phases.push(entry);
  await report(entry);
  return value;
}

const checks = {};
try {
  await mountFiles("moe-check-rates");
  mkdirSync("/scratch/rates", { recursive: true });

  // Replay: the probe's package (one issue, then spends of the last change and a padding note into a payment, a fee,
  // change and a zero output), read as a holder reads it.
  const domain = configurationHash(adoptedConfiguration()), issuerSecret = b(15), operatorSecret = b(16);
  const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
  const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag };
  let verifierCalls = 0;
  const verifier = { identities: adoptedConfiguration().circuits, verify: (kind, _inputs, proof) => { verifierCalls++; return proof[0] === kind; } };
  const record = task => ({ domain, kind: task.kind, publicInputs: task.publicInputs, proof: new Uint8Array(PROOF_BYTES).fill(task.kind),
    authorization: new Uint8Array(), capsules: task.capsules });
  const venue = FixtureVenue.reference(label, lag);
  const journal = new V3OperatorJournal("/scratch/rates/journal.db", { secret: operatorSecret, venue, reference, verifier });
  const submitted = [];
  let served;
  try {
    served = await phase(`build the package of 1 issue and ${SPENDS} spends (untimed work)`, async () => {
      const terms = encodeRootTerms({ obligor: issuer, payout: { thing: "rates units", quantumExponent: 0, perUnit: 1n }, operator, configuration: domain, venue: venue.id, interval: 10n });
      const backing = rootTermsName(terms), context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
      await journal.open("genesis", { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) });
      await journal.publish();
      const o = (seed, tag, i, value) => prepareExactOutput(b(seed), domain, rid(tag, i), backing, value);
      const tree = new NoteTree();
      let current = o(21, 1, 0, BigInt(2 * SPENDS + 10)), position = 0n;
      const issue = encodeRecord(authorizeIssue(record(issueTask(context, current)), issuerSecret));
      await journal.submit(issue);
      submitted.push(issue);
      tree.append(current.cm);
      for (let i = 0; i < SPENDS; i++) {
        const input = { note: current, anchor: tree.root(), path: tree.path(position) }, pad = o(21, 2, i, 0n);
        const outputs = [o(22, 3, i, 1n), o(23, 4, i, 1n), o(21, 5, i, current.opening.value - 2n), o(21, 6, i, 0n)];
        const bytes = encodeRecord(record(spendTask(context, [input, { ...input, note: pad }], outputs)));
        await journal.submit(bytes);
        submitted.push(bytes);
        tree.appendAll(outputs.map(x => x.cm));
        current = outputs[2]; position = BigInt(1 + 4 * i + 2);
      }
      await journal.commit("c2");
      await journal.publish();
      return journal.package();
    });
  } finally { journal.close(); }
  checks.packageBytes = served.package.length;
  const selection = { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" }, statements = SPENDS + 1;
  for (let r = 0; r < READS; r++) {
    verifierCalls = 0;
    const result = await phase(`replay the package (read ${r + 1})`, () => readPackage(served.package, selection, { verifier, venue, reference }), statements);
    checks.replayPosition = String(result.state?.position);
    checks.verifierCallsPerRead = verifierCalls;
  }

  // Digests: each record's leaf digest from its proof-free form, then the node digests up to one root.
  checks.digestRoot = await phase(`leaf and node digests of the ${statements} statements`, () => {
    let level = submitted.map(bytes => leafDigest(proofFreeOf(decodeRecord(bytes))));
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeDigest(level[i], level[i + 1]) : level[i]);
      level = next;
    }
    return `0x${level[0].toString(16)}`;
  }, statements);

  // Headers: a synthetic difficulty-4 chain mined above an anchor at an epoch boundary (test/ergo-headers.test.ts's
  // shape); the v2 hit's cost does not depend on the difficulty, which only sets how many nonces mining tries.
  const vlq = n => { const out = []; do { let x = Number(n & 0x7fn); n >>= 7n; if (n > 0n) x |= 0x80; out.push(x); } while (n > 0n); return out; };
  const G = secp256k1.ProjectivePoint.BASE.toRawBytes(true), D4 = 0x0104_0000, MINUTE = 60_000n, T0 = 1_700_000_000_000n;
  const encode = f => {
    const nonce = new Uint8Array(8); new DataView(nonce.buffer).setBigUint64(0, f.nonce ?? 0n);
    return Uint8Array.from([4, ...f.parentId, ...b(1), ...b(2), ...new Uint8Array(33).fill(3), ...vlq(f.timestamp), ...b(4),
      (D4 >>> 24) & 0xff, (D4 >>> 16) & 0xff, (D4 >>> 8) & 0xff, D4 & 0xff, ...vlq(f.height), 0, 0, 0, 0, ...G, ...nonce]);
  };
  const { context, chain } = await phase(`mine ${HEADERS} synthetic headers (untimed work)`, () => {
    const anchorHeight = 128n * 6602n, context = [], chain = [];
    let parentId = b(9);
    for (let i = 0; i <= ANCHOR_CONTEXT; i++) {
      const bytes = encode({ parentId, timestamp: T0 + BigInt(i) * 2n * MINUTE, height: anchorHeight - BigInt(ANCHOR_CONTEXT - i), nonce: BigInt(i) });
      context.push(bytes); parentId = blake2b(bytes, { dkLen: 32 });
    }
    let parent = parseErgoHeader(context.at(-1));
    for (let i = 0; i < HEADERS; i++) {
      for (let nonce = 0n; ; nonce++) {
        const bytes = encode({ parentId: parent.id, timestamp: parent.timestamp + 2n * MINUTE, height: parent.height + 1n, nonce });
        const header = parseErgoHeader(bytes);
        if (autolykosPowValid(header)) { chain.push(bytes); parent = header; break; }
      }
    }
    return { context, chain };
  });
  const store = ergoHeaderStore(blake2b(context.at(-1), { dkLen: 32 }), context);
  if (store === undefined) throw new Error("the header store was not built over the synthetic context");
  checks.headersAdded = await phase(`check ${HEADERS} headers in the store`, () => chain.filter(bytes => store.add(bytes) === "added").length, HEADERS);

  rmSync("/scratch/rates", { recursive: true, force: true });
  await finish({ kind: "rates", phases, checks, sizes: { spends: SPENDS, reads: READS, headers: HEADERS } });
} catch (error) {
  await finish({ kind: "rates", phases, checks, error: String(error?.stack ?? error) });
}

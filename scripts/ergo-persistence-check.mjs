// Fresh-process recovery at sync/publication boundaries, with invented funds.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, ".."), action = process.argv[2];
if (action === undefined) {
  mkdirSync(join(root, "scratch"), { recursive: true });
  const directory = mkdtempSync(join(root, "scratch/ergo-persistence-"));
  const checks = [];
  const run = (step, code = 0) => {
    const result = spawnSync(process.execPath, [import.meta.filename, step, directory], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 90000,
    });
    assert.equal(result.status, code, `${step}: ${result.error ?? result.stderr}\n${result.stdout}`);
    checks.push(step);
  };
  try {
    run("initialize"); run("mid-sync", 29); run("verify-old");
    run("before-commit", 29); run("verify-old");
    run("after-commit", 29); run("verify-new");
    run("publication-lost-reply", 29); run("publication-retry");
    run("deep-failure", 29); run("verify-failure");
    console.log(JSON.stringify({ checks, evidence: "fresh-process synthetic crash recovery; no live funds, proofs or power-loss claim" }));
  } finally {
    assert(resolve(directory).startsWith(join(root, "scratch") + sep));
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(0);
}

const { ErgoVenue } = await import("../dist/ergo.js");
const { ErgoVenueJournal } = await import("../dist/ergo-store.js");
const { ErgoPublisher } = await import("../dist/ergo-publisher.js");
const { ergoProfileIdentity } = await import("../dist/ergo-profile.js");
const { Chain, BranchSupplier, plainBox, recordOutput, transaction } = await import("../dist/ergo-synthetic.js");
const { encodeCommitment, signCommitment } = await import("../dist/commitment.js");
const { V3OperatorJournal } = await import("../dist/pool/v3/store.js");
const { RELATIONS } = await import("../dist/pool/v3/configuration.js");
const { payToPublicKeyTree } = await import("../dist/ergo-publisher.js");
const { secp256k1 } = await import("@noble/curves/secp256k1.js");
const { blake2b } = await import("@noble/hashes/blake2b.js");
const b = n => new Uint8Array(32).fill(n), directory = process.argv[3];
const chain = new Chain(), profile = chain.profile(1n), record = signCommitment(b(81), 1n, b(1));
const blocks = chain.extend(chain.anchor, 5, i => i === 0
  ? [transaction([recordOutput(1, record.operator, encodeCommitment(record))], 1n, "durable-record")] : []);
const more = chain.extend(blocks.at(-1), 2), serving = tip => new BranchSupplier("synthetic", tip, chain);
const journal = new ErgoVenueJournal(join(directory, "venue.sqlite"), ergoProfileIdentity(profile));
const venue = new ErgoVenue(profile, chain.context, {}, undefined, journal);
const request = { venue: venue.id, kind: 1, subject: record.operator, fromIndex: 0n, toIndex: 3n };
const range = () => venue.range(request, { maxBytes: 10000n, maxEntries: 10n });
if (action === "initialize") {
  await venue.sync([serving(blocks.at(-1))]); assert.equal(venue.witnessedIndex(), 3n);
  writeFileSync(join(directory, "range.bin"), range());
} else if (action === "verify-old" || action === "verify-new") {
  assert.equal(venue.witnessedIndex(), action === "verify-old" ? 3n : 5n);
  assert.deepEqual(Buffer.from(range()), readFileSync(join(directory, "range.bin")));
} else if (action === "mid-sync") {
  const source = serving(more.at(-1));
  source.before = async call => { if (call === "section") process.exit(29); };
  await venue.sync([source]); throw new Error("crash boundary not reached");
} else if (action === "before-commit" || action === "after-commit") {
  const commit = journal.commit.bind(journal);
  journal.commit = state => { if (action === "after-commit") commit(state); process.exit(29); };
  await venue.sync([serving(more.at(-1))]); throw new Error("crash boundary not reached");
} else if (action.startsWith("publication-")) {
  const configuration = { circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])),
    helper: Uint8Array.from(Buffer.from("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8", "hex")) };
  const owner = new V3OperatorJournal(join(directory, "operator.sqlite"), { configuration, secret: b(81), venue,
    reference: { context: profile.reference, profile }, verifier: { verify: async () => false } });
  const funding = b(82), tree = payToPublicKeyTree(secp256k1.getPublicKey(funding, true));
  const box = plainBox(tree, 10000000n, chain.anchor.height), boxId = blake2b(box, { dkLen: 32 });
  let submitted = false;
  const source = { name: "synthetic publication", unspentBoxes: async () => [box], hasTransaction: async () => false,
    hasBox: async id => Buffer.from(id).equals(boxId), submit: async (bytes, id) => {
      submitted = true;
      if (action === "publication-lost-reply") {
        writeFileSync(join(directory, "signed.bin"), bytes); writeFileSync(join(directory, "txid.bin"), id); process.exit(29);
      }
      assert.deepEqual(Buffer.from(bytes), readFileSync(join(directory, "signed.bin")));
      assert.deepEqual(Buffer.from(id), readFileSync(join(directory, "txid.bin")));
    } };
  venue.attachPublisher(new ErgoPublisher({ secretKey: funding, suppliers: [source], persistence: owner.publisherPersistence() }));
  await venue.publishRecord(1, record.operator, encodeCommitment(signCommitment(b(81), 2n, b(2))));
  assert(submitted); await owner.close();
} else if (action === "deep-failure") {
  const fork = chain.extend(chain.anchor, 9, () => [], 91);
  await assert.rejects(venue.sync([serving(fork.at(-1))]), /best chain left/); process.exit(29);
} else if (action === "verify-failure") {
  assert.throws(() => venue.witnessedIndex(), /best chain left/);
  await assert.rejects(venue.sync([serving(more.at(-1))]), /best chain left/);
} else throw new Error("unknown crash scenario");
journal.close();

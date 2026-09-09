import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  hkdfSync,
  webcrypto,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

import * as api from "./crypto.mjs";
import {
  CAPSULE_BYTES,
  CapsuleAssociationError,
  CapsuleFormatError,
  PROFILE,
  SYNTHETIC_VIEW,
  createCapsuleScanner,
  deliveryHash,
  deriveMasterKeys,
  deriveNonzeroField,
  deriveSettlementOwnerSecret,
  prepareExactOutput,
  recoverCapsule,
  requireDeliveryVector,
  restoreSyntheticView,
  u32be,
  u64be,
} from "./crypto.mjs";
import { commitmentOf, nullifierOf, ownerOf } from "../../../dist/pool/notes.js";
import { fieldToBytes, fieldToHex } from "../../../dist/pool/field.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = join(HERE, "../../../scratch/pool-delivery/results.json");
const utf8 = new TextEncoder();
const tested = [];

function sequence(start) {
  return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

function hex(value) {
  return Buffer.from(value).toString("hex");
}

function different(left, right, message) {
  assert.notEqual(hex(left), hex(right), message);
}

async function test(name, body) {
  await body();
  tested.push(name);
}

function vectorOutput(note) {
  return { cm: note.cm, capsule: note.capsule };
}

function encodeStatement(statement) {
  return {
    deliveryHash: hex(statement.deliveryHash),
    outputs: statement.outputs.map((output) => ({
      cm: fieldToHex(output.cm).slice(2),
      capsule: hex(output.capsule),
    })),
  };
}

function encodeSettlement(settlement) {
  return {
    createdBy: settlement.createdBy,
    demandStatementHash: hex(settlement.demandStatementHash),
    acceptanceDeadline: settlement.acceptanceDeadline.toString(),
    backing: hex(settlement.backing),
    value: settlement.value.toString(),
    owner: fieldToHex(settlement.owner).slice(2),
    rho: fieldToHex(settlement.rho).slice(2),
    cm: fieldToHex(settlement.cm).slice(2),
  };
}

function payloadKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) payloadKeys(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      payloadKeys(item, found);
    }
  }
  return found;
}

function forgeAssociatedCapsule({ recoveryKey, domain, cm, requestId, backing, value }) {
  // Test-only bypass: deliberately recreate the standard primitives here so
  // candidate crypto.mjs never exports encryption with a caller-selected cm.
  const capsuleInfo = Buffer.concat([
    Buffer.from("moe/wallet/recovery/v1/capsule", "ascii"),
    domain,
  ]);
  const key = new Uint8Array(hkdfSync("sha256", recoveryKey, fieldToBytes(cm), capsuleInfo, 32));
  const aad = Buffer.concat([
    Buffer.from("moe/wallet/recovery/v1/aad", "ascii"),
    Buffer.from([PROFILE]),
    domain,
    fieldToBytes(cm),
  ]);
  const plaintext = Buffer.concat([requestId, backing, u64be(value)]);
  const cipher = createCipheriv("aes-256-gcm", key, new Uint8Array(12), { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: 72 });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([PROFILE]), ciphertext, cipher.getAuthTag()]));
}

async function webCryptoEnvelope(seed, domain, cm, requestId, backing, value) {
  const subtle = webcrypto.subtle;
  const root = await subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
  const recoveryKey = new Uint8Array(await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: domain,
    info: utf8.encode("moe/wallet/recovery/v1/recovery"),
  }, root, 256));
  const recoveryBase = await subtle.importKey("raw", recoveryKey, "HKDF", false, ["deriveBits"]);
  const capsuleKey = new Uint8Array(await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: fieldToBytes(cm),
    info: Buffer.concat([Buffer.from("moe/wallet/recovery/v1/capsule", "ascii"), domain]),
  }, recoveryBase, 256));
  const aes = await subtle.importKey("raw", capsuleKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const aad = Buffer.concat([
    Buffer.from("moe/wallet/recovery/v1/aad", "ascii"),
    Buffer.from([PROFILE]),
    domain,
    fieldToBytes(cm),
  ]);
  const plaintext = Buffer.concat([requestId, backing, u64be(value)]);
  const ciphertextAndTag = new Uint8Array(await subtle.encrypt({
    name: "AES-GCM",
    iv: new Uint8Array(12),
    additionalData: aad,
    tagLength: 128,
  }, aes, plaintext));
  return new Uint8Array(Buffer.concat([Buffer.from([PROFILE]), ciphertextAndTag]));
}

function makeSettlement(seed, domain, demandStatementHash, acceptanceDeadline, backing, value, rho, createdBy = "prevalidated-canonical-finalized-settlement") {
  const secret = deriveSettlementOwnerSecret(seed, domain, demandStatementHash, acceptanceDeadline);
  const owner = ownerOf(secret.value);
  const opening = { backing, value, owner, rho };
  const cm = commitmentOf(domain, opening);
  return {
    createdBy,
    demandStatementHash,
    acceptanceDeadline,
    backing,
    value,
    owner,
    rho,
    cm,
    nf: nullifierOf(domain, cm, secret.value),
  };
}

function benchmarkTrials(seed, domain, foreign, count) {
  const scanner = createCapsuleScanner(seed, domain);
  const start = performance.now();
  for (let i = 0; i < count; i += 1) {
    assert.equal(scanner.tryRecover(foreign.cm, foreign.capsule), null);
  }
  const elapsedMs = performance.now() - start;
  return {
    trials: count,
    matches: scanner.stats().matches,
    elapsedMs,
    trialsPerSecond: count / (elapsedMs / 1000),
    microsecondsPerTrial: (elapsedMs * 1000) / count,
  };
}

function benchmarkOwnHashes(domain, note, secret, count) {
  let checksum = 0n;
  const start = performance.now();
  for (let i = 0; i < count; i += 1) {
    const cm = commitmentOf(domain, note);
    checksum ^= nullifierOf(domain, cm, secret);
  }
  const elapsedMs = performance.now() - start;
  return {
    pairs: count,
    hashesPerPair: 2,
    elapsedMs,
    microsecondsPerCommitmentAndNullifier: (elapsedMs * 1000) / count,
    checksum: fieldToHex(checksum),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceHashes() {
  const names = ["crypto.mjs", "restore-worker.mjs", "check.mjs"];
  return Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    sha256(await readFile(join(HERE, name))),
  ])));
}

const seed = sequence(0x01);
const otherSeed = sequence(0x91);
const domain = sequence(0x21);
const otherDomain = sequence(0xb1);
const backing = sequence(0x41);
const otherBacking = sequence(0xc1);
const requestId = sequence(0x61);
const otherRequestId = sequence(0xe1);

const base = prepareExactOutput(seed, domain, requestId, backing, 73n);
const exactRetry = prepareExactOutput(seed, domain, requestId, backing, 73n);
const idVariant = prepareExactOutput(seed, domain, otherRequestId, backing, 73n);
const domainVariant = prepareExactOutput(seed, otherDomain, requestId, backing, 73n);
const seedVariant = prepareExactOutput(otherSeed, domain, requestId, backing, 73n);
const backingVariant = prepareExactOutput(seed, domain, requestId, otherBacking, 73n);
const amountVariant = prepareExactOutput(seed, domain, requestId, backing, 74n);
const zero = prepareExactOutput(seed, domain, sequence(0x71), backing, 0n);
const max = prepareExactOutput(seed, domain, sequence(0x72), backing, (1n << 64n) - 1n);

await test("exact retry is byte-for-byte deterministic", () => {
  assert.equal(base.secret, exactRetry.secret);
  assert.equal(base.opening.rho, exactRetry.opening.rho);
  assert.equal(base.cm, exactRetry.cm);
  assert.equal(base.nf, exactRetry.nf);
  assert.equal(hex(base.capsule), hex(exactRetry.capsule));
  assert.deepEqual(base.attempts, exactRetry.attempts);
  assert.ok(base.attempts.spend > 0 || base.attempts.rho > 0, "fixed vector must exercise rejection retry");
});

await test("identifier, domain, seed, backing and amount variants are separated", () => {
  for (const candidate of [idVariant, domainVariant, seedVariant, backingVariant, amountVariant]) {
    assert.notEqual(candidate.cm, base.cm);
    different(candidate.capsule, base.capsule);
  }
  assert.notEqual(idVariant.secret, base.secret);
  assert.notEqual(domainVariant.secret, base.secret);
  assert.notEqual(seedVariant.secret, base.secret);
  assert.equal(backingVariant.secret, base.secret);
  assert.equal(amountVariant.secret, base.secret);
  assert.notEqual(backingVariant.opening.rho, base.opening.rho);
  assert.notEqual(amountVariant.opening.rho, base.opening.rho);
});

await test("master keys and settlement key are domain separated", () => {
  const keys = deriveMasterKeys(seed, domain);
  const values = [keys.spendKey, keys.rhoKey, keys.recoveryKey, keys.settlementKey].map(hex);
  assert.equal(new Set(values).size, 4);
});

await test("u64 zero and maximum are accepted and bounds are rejected", () => {
  assert.equal(zero.opening.value, 0n);
  assert.equal(max.opening.value, (1n << 64n) - 1n);
  assert.throws(() => prepareExactOutput(seed, domain, requestId, backing, -1n), CapsuleFormatError);
  assert.throws(() => prepareExactOutput(seed, domain, requestId, backing, 1n << 64n), CapsuleFormatError);
});

await test("fixed-width byte boundaries ignore subclass length and iterator overrides", () => {
  class ForgedLength32 extends Uint8Array { get length() { return 32; } }
  class ForgedLength89 extends Uint8Array { get length() { return 89; } }
  class PoisonIterator extends Uint8Array {
    *[Symbol.iterator]() { throw new Error("attacker iterator ran"); }
  }
  const poison = (source) => {
    const value = new PoisonIterator(source.length);
    Uint8Array.prototype.set.call(value, source);
    return value;
  };
  const short32 = new ForgedLength32(31);
  assert.throws(() => prepareExactOutput(short32, domain, requestId, backing, 1n), CapsuleFormatError);
  assert.throws(() => prepareExactOutput(seed, short32, requestId, backing, 1n), CapsuleFormatError);
  assert.throws(() => prepareExactOutput(seed, domain, short32, backing, 1n), CapsuleFormatError);
  assert.throws(() => prepareExactOutput(seed, domain, requestId, short32, 1n), CapsuleFormatError);
  assert.throws(() => recoverCapsule(seed, domain, base.cm, new ForgedLength89(88)), CapsuleFormatError);
  const withPoisonedInputs = prepareExactOutput(
    poison(seed),
    poison(domain),
    poison(requestId),
    poison(backing),
    73n,
  );
  assert.equal(withPoisonedInputs.cm, base.cm);
  assert.equal(hex(withPoisonedInputs.capsule), hex(base.capsule));
  assert.equal(recoverCapsule(poison(seed), poison(domain), base.cm, poison(base.capsule)).cm, base.cm);
});

await test("seed and exact public context recover the complete opening and nullifier", () => {
  const recovered = recoverCapsule(seed, domain, base.cm, base.capsule);
  assert.ok(recovered);
  assert.equal(hex(recovered.requestId), hex(requestId));
  assert.equal(hex(recovered.backing), hex(backing));
  assert.equal(recovered.value, 73n);
  assert.equal(recovered.secret, base.secret);
  assert.equal(recovered.opening.rho, base.opening.rho);
  assert.equal(recovered.cm, base.cm);
  assert.equal(recovered.nf, base.nf);
});

await test("wrong seed, commitment or domain is an ordinary no-match", () => {
  assert.equal(recoverCapsule(otherSeed, domain, base.cm, base.capsule), null);
  assert.equal(recoverCapsule(seed, domain, idVariant.cm, base.capsule), null);
  assert.equal(recoverCapsule(seed, otherDomain, base.cm, base.capsule), null);
});

await test("tamper is no-match while truncation and profile mismatch are malformed", () => {
  const tampered = base.capsule.slice();
  tampered[tampered.length - 1] ^= 1;
  assert.equal(recoverCapsule(seed, domain, base.cm, tampered), null);
  assert.throws(() => recoverCapsule(seed, domain, base.cm, base.capsule.slice(0, -1)), CapsuleFormatError);
  const wrongProfile = base.capsule.slice();
  wrongProfile[0] = 2;
  assert.throws(() => recoverCapsule(seed, domain, base.cm, wrongProfile), CapsuleFormatError);
});

await test("candidate API cannot encrypt under an arbitrary commitment", () => {
  assert.equal(Object.hasOwn(api, "encryptComputedCapsule"), false);
  assert.equal(Object.hasOwn(api, "capsuleKey"), false);
  assert.equal(Object.hasOwn(api, "encryptCapsule"), false);
});

await test("valid AEAD under a declared cm still fails recomputed-commitment association", () => {
  const forged = forgeAssociatedCapsule({
    recoveryKey: deriveMasterKeys(seed, domain).recoveryKey,
    domain,
    cm: base.cm,
    requestId,
    backing,
    value: 74n,
  });
  assert.throws(() => recoverCapsule(seed, domain, base.cm, forged), CapsuleAssociationError);
});

const initialOutputs = [vectorOutput(base), vectorOutput(zero), vectorOutput(seedVariant)];
const initialStatement = { outputs: initialOutputs, deliveryHash: deliveryHash(domain, initialOutputs) };

await test("delivery hash binds prefix, domain, count, order, cm and exact capsule", () => {
  const manual = createHash("sha256")
    .update(Buffer.from("moe/pool/v3/delivery", "ascii"))
    .update(domain)
    .update(u32be(initialOutputs.length));
  for (const output of initialOutputs) manual.update(fieldToBytes(output.cm)).update(output.capsule);
  assert.equal(hex(initialStatement.deliveryHash), manual.digest("hex"));
  assert.equal(hex(requireDeliveryVector(domain, initialOutputs, initialStatement.deliveryHash)), hex(initialStatement.deliveryHash));
  assert.throws(() => requireDeliveryVector(domain, [initialOutputs[1], initialOutputs[0], initialOutputs[2]], initialStatement.deliveryHash), CapsuleAssociationError);
  assert.throws(() => requireDeliveryVector(domain, initialOutputs.slice(0, 2), initialStatement.deliveryHash), CapsuleAssociationError);
  assert.throws(() => requireDeliveryVector(domain, undefined, initialStatement.deliveryHash), CapsuleFormatError);
  assert.throws(() => requireDeliveryVector(domain, initialOutputs, undefined), CapsuleFormatError);
});

await test("bound capsule corruption fails the statement hash before scanning", () => {
  const corrupted = structuredClone(initialOutputs);
  corrupted[0].capsule[20] ^= 1;
  assert.throws(() => requireDeliveryVector(domain, corrupted, initialStatement.deliveryHash), CapsuleAssociationError);
  const substituted = structuredClone(initialOutputs);
  [substituted[0].capsule, substituted[1].capsule] = [substituted[1].capsule, substituted[0].capsule];
  assert.throws(() => requireDeliveryVector(domain, substituted, initialStatement.deliveryHash), CapsuleAssociationError);
});

await test("Node WebCrypto independently reproduces one AES-GCM envelope", async () => {
  const independent = await webCryptoEnvelope(seed, domain, base.cm, requestId, backing, 73n);
  assert.equal(hex(independent), hex(base.capsule));
});

await test("an AEAD capsule subkey is separated from the spend master", () => {
  const keys = deriveMasterKeys(seed, domain);
  const capsuleSubkey = new Uint8Array(hkdfSync(
    "sha256",
    keys.recoveryKey,
    fieldToBytes(base.cm),
    Buffer.concat([Buffer.from("moe/wallet/recovery/v1/capsule", "ascii"), domain]),
    32,
  ));
  different(capsuleSubkey, keys.spendKey);
  assert.notEqual(deriveNonzeroField(capsuleSubkey, requestId), base.secret);
});

const issue = prepareExactOutput(seed, domain, sequence(0x11), backing, 101n);
const receiver = prepareExactOutput(seed, domain, sequence(0x12), backing, 37n);
const change = prepareExactOutput(seed, domain, sequence(0x13), backing, 62n);
const restoreZero = prepareExactOutput(seed, domain, sequence(0x14), backing, 0n);
const foreign = prepareExactOutput(otherSeed, domain, sequence(0x15), backing, 29n);
const restoreOutputs = [issue, receiver, change, restoreZero, foreign].map(vectorOutput);
const restoreStatement = { outputs: restoreOutputs, deliveryHash: deliveryHash(domain, restoreOutputs) };
const settlement = makeSettlement(
  seed,
  domain,
  sequence(0x31),
  9000n,
  backing,
  11n,
  deriveNonzeroField(deriveMasterKeys(otherSeed, domain).rhoKey, sequence(0x32)),
);
const forceAwaitingAdoption = makeSettlement(
  seed,
  domain,
  sequence(0x33),
  9001n,
  backing,
  13n,
  deriveNonzeroField(deriveMasterKeys(otherSeed, domain).rhoKey, sequence(0x34)),
  "prevalidated-force-created-awaiting-adoption",
);
const view = {
  viewKind: SYNTHETIC_VIEW,
  seed,
  domain,
  statements: [restoreStatement],
  spentNullifiers: [change.nf],
  settlements: [settlement, forceAwaitingAdoption],
};

let restored;
await test("synthetic restore finds issuer, receiver and lit-settlement notes", () => {
  restored = restoreSyntheticView(view);
  const commitments = new Set(restored.holdings.map((holding) => holding.cm));
  assert.deepEqual(commitments, new Set([issue.cm, receiver.cm, settlement.cm]));
  assert.equal(restored.stats.trials, 5);
  assert.equal(restored.stats.matches, 4);
  assert.equal(restored.stats.settlementTrials, 2);
  assert.equal(restored.stats.settlementMatches, 2);
  assert.equal(restored.pendingAdoption.length, 1);
  assert.equal(restored.pendingAdoption[0].cm, forceAwaitingAdoption.cm);
  assert.equal(restored.pendingAdoption[0].spendable, false);
  assert.equal(restored.pendingAdoption[0].status, "awaiting-canonical-adoption-and-certified-path");
});

await test("spent change and zero output are not returned as holdings", () => {
  const commitments = new Set(restored.holdings.map((holding) => holding.cm));
  assert.equal(commitments.has(change.cm), false);
  assert.equal(commitments.has(restoreZero.cm), false);
  assert.equal(commitments.has(foreign.cm), false);
});

await test("synthetic restore makes no authentication, finality or completeness claim", () => {
  assert.equal(restored.evidenceScope, SYNTHETIC_VIEW);
  assert.equal(restored.authenticatedFullV3Finality, false);
  assert.equal(restored.completenessClaim, false);
  assert.equal(restored.noMatchesMeansZeroBalance, false);
  assert.equal(restored.unresolvedCoverage, true);
});

await test("wrong-seed restore reports no matches without claiming zero completeness", () => {
  const wrong = restoreSyntheticView({ ...view, seed: sequence(0x81) });
  assert.equal(wrong.holdings.length, 0);
  assert.equal(wrong.stats.matches, 0);
  assert.equal(wrong.stats.settlementMatches, 0);
  assert.equal(wrong.noMatchesMeansZeroBalance, false);
  assert.equal(wrong.completenessClaim, false);
  assert.equal(wrong.unresolvedCoverage, true);
});

await test("settlement restoration requires a declared prevalidated canonical creation", () => {
  assert.throws(() => restoreSyntheticView({
    ...view,
    settlements: [{ ...settlement, createdBy: undefined }],
  }), CapsuleFormatError);
});

const childPayload = {
  viewKind: SYNTHETIC_VIEW,
  seed: hex(seed),
  domain: hex(domain),
  statements: [encodeStatement(restoreStatement)],
  spentNullifiers: [fieldToHex(change.nf).slice(2)],
  settlements: [encodeSettlement(settlement), encodeSettlement(forceAwaitingAdoption)],
};
let childResult;

await test("child restore receives only seed and declared public synthetic-view fields", () => {
  assert.deepEqual([...Object.keys(childPayload)].sort(), [
    "domain", "seed", "settlements", "spentNullifiers", "statements", "viewKind",
  ]);
  const forbidden = ["secret", "requestId", "wallet", "database", "operator", "callback", "sender"];
  const keys = [...payloadKeys(childPayload)];
  for (const fragment of forbidden) {
    assert.equal(keys.some((key) => key.toLowerCase().includes(fragment.toLowerCase())), false);
  }
  const child = spawnSync(process.execPath, [join(HERE, "restore-worker.mjs")], {
    input: JSON.stringify(childPayload),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  childResult = JSON.parse(child.stdout);
  assert.equal(childResult.ok, true);
  assert.deepEqual(
    new Set(childResult.holdings.map((holding) => holding.cm)),
    new Set([fieldToHex(issue.cm), fieldToHex(receiver.cm), fieldToHex(settlement.cm)]),
  );
  assert.equal(childResult.authenticatedFullV3Finality, false);
  assert.equal(childResult.completenessClaim, false);
  assert.equal(childResult.noMatchesMeansZeroBalance, false);
  assert.equal(childResult.pendingAdoption.length, 1);
  assert.equal(childResult.pendingAdoption[0].cm, fieldToHex(forceAwaitingAdoption.cm));
  assert.equal(childResult.pendingAdoption[0].spendable, false);
});

await test("restored worker creates new requests from fresh IDs without an index scan", () => {
  const oldIds = new Set([issue, receiver, change, restoreZero].map((note) => hex(note.requestId)));
  assert.equal(childResult.requestGeneration.strategy, "fresh-cryptographic-random-32-bytes");
  assert.equal(childResult.requestGeneration.indexScans, 0);
  assert.equal(childResult.requestGeneration.randomDraws, 1);
  assert.equal(oldIds.has(childResult.requestGeneration.requestId), false);
});

await test("child restore fails a missing bound delivery hash", () => {
  const malformed = structuredClone(childPayload);
  delete malformed.statements[0].deliveryHash;
  const child = spawnSync(process.execPath, [join(HERE, "restore-worker.mjs")], {
    input: JSON.stringify(malformed),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /delivery hash/);
});

const benchmark = {
  scope: "local profile-1 capsule trials only; excludes history transport/authentication, proof verification, finality and completeness",
  cachedPerDomainMasterKeys: true,
  perTrialWork: "one per-commitment HKDF-SHA256 plus one failed AES-256-GCM open and framing checks",
  repeatedEnvelopeCaveat: "each sample repeats one foreign cm/capsule without caching its per-commitment subkey; this does not measure traversal of distinct history entries",
  foreignCapsuleScans: [1_000, 10_000, 100_000].map((count) => benchmarkTrials(seed, domain, foreign, count)),
  ownNoteHashCost: benchmarkOwnHashes(domain, base.opening, base.secret, 250),
};

const results = {
  status: "pass",
  profile: PROFILE,
  capsuleBytes: CAPSULE_BYTES,
  tests: { passed: tested.length, names: tested },
  deterministicVector: {
    seed: hex(seed),
    domain: hex(domain),
    requestId: hex(requestId),
    backing: hex(backing),
    value: base.opening.value.toString(),
    spendAttempt: base.attempts.spend,
    rhoAttempt: base.attempts.rho,
    owner: fieldToHex(base.opening.owner),
    rho: fieldToHex(base.opening.rho),
    cm: fieldToHex(base.cm),
    nf: fieldToHex(base.nf),
    capsule: hex(base.capsule),
    capsuleSha256: sha256(base.capsule),
  },
  childProcessRestore: {
    inputTopLevelFields: Object.keys(childPayload),
    inputContainsRequestIdsOutsideCiphertext: false,
    inputContainsSenderSecretsOrOriginalWalletDatabase: false,
    restoredHoldings: childResult.holdings,
    pendingAdoption: childResult.pendingAdoption,
    stats: childResult.stats,
    requestGeneration: childResult.requestGeneration,
    evidenceScope: childResult.evidenceScope,
    authenticatedFullV3Finality: childResult.authenticatedFullV3Finality,
    completenessClaim: childResult.completenessClaim,
    noMatchesMeansZeroBalance: childResult.noMatchesMeansZeroBalance,
    unresolvedCoverage: childResult.unresolvedCoverage,
  },
  benchmark,
  limitations: [
    "Input is a declared prevalidated synthetic view, not authenticated complete v3 history or finality evidence.",
    "No-match and missing external coverage never establish a zero balance or restoration completeness.",
    "The probe does not implement venue/backing discovery, availability, proof verification, authenticated range reads or local path construction.",
    "Only a prevalidated canonical finalized settlement enters holdings; a prevalidated force-created output remains non-spendable pending adoption, and the probe does not validate either creation history.",
    "The capsule-subkey separation check is a deterministic regression vector, not a computational proof of HKDF security.",
  ],
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
  },
  sourceSha256: await sourceHashes(),
};

await mkdir(dirname(RESULTS_FILE), { recursive: true });
await writeFile(RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);

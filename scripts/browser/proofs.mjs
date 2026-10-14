// The in-browser proof check (slice 39): in a browser engine's worker, through the browser bundle's library, start the
// pinned backend from the proving parameters, derive and check the six relations' keys, verify a genuine proof of
// each proved kind and refuse a tampered one, prove a pool-v3 spend as a payer's device does and verify it, and scan
// capsules as a restore does; with each phase's time and the engine's memory after it (scripts/browser/check.mjs).
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoteTree } from "../../src/pool/note-tree.js";
import { BN254_PARAMETERS } from "../../src/pool/parameters.js";
import { startBackend } from "../../src/pool/proof-verifier.js";
import { createCapsuleScanner, prepareExactOutput } from "../../src/pool/v3/capsules.js";
import { adoptedConfiguration, configurationHash } from "../../src/pool/v3/configuration.js";
import { openV3Prover } from "../../src/pool/v3/prover.js";
import { encodeRootTerms, rootTermsName } from "../../src/pool/v3/terms.js";
import { spendTask } from "../../src/pool/v3/witness.js";
import { localVenueIdentity } from "../../src/record-venue.js";
import genuine from "../../test/fixtures/pool-v3-genuine-proofs.json";
import { finish, memory, report } from "./worker-report.mjs";

const phases = [];
async function phase(name, body) {
  const started = performance.now();
  const value = await body();
  const entry = { name, ms: Math.round(performance.now() - started), memoryBytes: await memory() };
  phases.push(entry);
  await report(entry);
  return value;
}
const bytes = async path => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
const base64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const b = n => new Uint8Array(32).fill(n);

const checks = {};
try {
  const api = await phase("start the backend from the parameters", async () =>
    startBackend({ g1: await bytes("/parameters/g1"), g2: await bytes("/parameters/g2") }));
  checks.points = BN254_PARAMETERS.points;
  const prover = await phase("derive and check the six relations' keys", () => openV3Prover(api));

  // A genuine proof of each proved kind verifies; the spend's with one byte changed does not.
  const verdicts = await phase("verify a genuine proof of each proved kind", async () => {
    const out = {};
    for (const [name, proof] of Object.entries(genuine.proofs)) {
      out[name] = await prover.verifier.verify(proof.kind, proof.publicInputs.map(BigInt), base64(proof.proof));
    }
    return out;
  });
  checks.genuine = verdicts;
  const spend = genuine.proofs.spend, tampered = base64(spend.proof);
  tampered[tampered.length - 100] ^= 1;
  checks.tampered = await prover.verifier.verify(spend.kind, spend.publicInputs.map(BigInt), tampered);

  // A spend as a payer proves one (the operator-journal tests' payment): two inputs, four outputs, real capsules.
  const domain = configurationHash(adoptedConfiguration()), issuer = ed25519.getPublicKey(b(15)), operator = ed25519.getPublicKey(b(16));
  const venue = localVenueIdentity(b(12), 2n);
  const backing = rootTermsName(encodeRootTerms({ obligor: issuer, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n },
    operator, configuration: domain, venue, interval: 10n }));
  const header = { domain, venue, operator, sequence: 1n, entries: [{ backing, link: backing }] };
  const output = (seed, id, value) => prepareExactOutput(seed, domain, b(id), backing, value);
  const payer = b(21), funded = output(payer, 31, 10n), pad = output(payer, 36, 0n);
  const outputs = [output(b(22), 32, 7n), output(b(23), 33, 1n), output(payer, 34, 2n), output(payer, 35, 0n)];
  const tree = new NoteTree();
  tree.append(funded.cm);
  const input = { note: funded, anchor: tree.root(), path: tree.path(0n) };
  const record = await phase("prove a spend", () => prover.prove(spendTask({ domain, header }, [input, { ...input, note: pad }], outputs)));
  checks.spendProofBytes = record.proof.length;
  checks.spendVerifies = await phase("verify the spend", () => prover.verifier.verify(record.kind, record.publicInputs, record.proof));

  // A restore's trial decryption: every output's capsule tried under one seed, a quarter of them its own.
  const trials = 4000, mine = outputs.filter((_, i) => i >= 2), theirs = outputs.filter((_, i) => i < 2);
  const scanned = await phase(`try ${trials} capsules`, () => {
    const scanner = createCapsuleScanner(payer, domain);
    let found = 0;
    for (let i = 0; i < trials; i++) {
      const o = i % 4 === 0 ? mine[i % 2] : theirs[i % 2];
      if (scanner.tryRecover(o.cm, o.capsule) !== null) found++;
    }
    return found;
  });
  checks.capsulesFound = scanned;
  checks.capsuleMs = phases.at(-1).ms / trials;
  await prover.close();
  await api.destroy();
  await finish({ kind: "proofs", phases, checks });
} catch (error) {
  await finish({ kind: "proofs", phases, checks, error: String(error?.stack ?? error) });
}

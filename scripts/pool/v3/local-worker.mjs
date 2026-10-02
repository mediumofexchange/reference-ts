// Fresh local fixture process. Artifact path is harness-owned; pins are fixed
// in the runtime manifest of the adopted configuration (pool-v3 §11.4),
// never read from the supplied record package. No witness or original journal.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { UltraHonkVerifierBackend } from "@aztec/bb.js";
import { startBackend } from "../../../dist/pool/proof-verifier.js";
import { PARAMETER_DIRECTORY, readParameters } from "../prepare-crs.mjs";
import { recordReader, replayEvidencePackage } from "./local-replay.mjs";
import { FixtureVenue, LOCAL_REFERENCE } from "../../../dist/record-venue.js";
import { ERGO_SYNTHETIC_REFERENCE } from "../../../dist/ergo-profile.js";
import { field } from "../fixtures.mjs";
import { loadManifest, checkSources, readKeys, adoptedConfiguration } from "./manifest.mjs";
import { v3Codec } from "./codec.mjs";

let api;
try {
  if (process.argv.length > 4 || (process.argv[3] !== undefined && !["--local", "--ergo", "--ergo-fixture", "--testnet"].includes(process.argv[3]))) throw new Error("unknown reader mode");
  const withTestnet = process.argv[3] === "--testnet";
  const withErgo = process.argv[3] === "--ergo";
  const withErgoReference = withErgo || process.argv[3] === "--ergo-fixture";
  const codec = v3Codec;
  const manifest = loadManifest(); checkSources(manifest);
  const keys = readKeys(fileURLToPath(process.argv[2]), manifest);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2_097_152) throw new Error("fixture IPC limit");
    chunks.push(chunk);
  }
  const input = deserialize(Buffer.concat(chunks));
  const fields = Object.keys(input).sort().join(",");
  if (withTestnet && fields !== "package,selection") throw new Error("testnet reader takes only public package and selection");
  if (!["package,selection", "package,seed,selection", "package,selection,venue", "package,seed,selection,venue"].includes(fields)) {
    throw new Error("unexpected fixture input");
  }
  // The harness's prepared parameters, checked again before this process loads them.
  api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
  const backend = new UltraHonkVerifierBackend(api);
  // The fixture venue record is this process's own range verifier (§13.2),
  // rebuilt from the fixture IPC beside the selection; the package cannot supply it.
  // Its keys are the manifest's (readKeys), so it declares the configuration's identities.
  const verifier = { reference: { context: LOCAL_REFERENCE, label: new Uint8Array(32).fill(12), lag: 2n }, identities: adoptedConfiguration().circuits,
    verify: (kind, publicInputs, proof) => backend.verifyProof({
    proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind),
  }, { verifierTarget: "noir-recursive" }), record: data => recordReader(FixtureVenue.from(data), "fixture-verifier") };
  // Both Ergo modes use this process's fixed profile. --ergo-fixture retains
  // FixtureVenue for differential checks; --ergo verifies blocks through its
  // own ErgoVenue up to the pin held beside the keys (never in the package).
  if (withErgoReference) {
    const { ergoRecord, ERGO_PROFILE } = await import("./ergo-check.mjs");
    verifier.reference = { context: ERGO_SYNTHETIC_REFERENCE, profile: ERGO_PROFILE };
    if (withErgo) {
      const pin = new Uint8Array(readFileSync(join(fileURLToPath(process.argv[2]), "ergo-pin.bin")));
      verifier.record = data => ergoRecord(data, { pin });
    }
  }
  if (withTestnet) {
    const { readTestnetSelection, testnetRecord } = await import("./testnet.mjs");
    const directory = fileURLToPath(process.argv[2]);
    const selected = readTestnetSelection(join(directory, "testnet-reader.json"));
    const pin = new Uint8Array(readFileSync(join(directory, "ergo-pin.bin")));
    if (input.selection?.judgingIndex !== selected.judgingIndex) throw new Error("testnet judging index differs from the reader's selection");
    verifier.reference = { context: selected.profile.reference, profile: selected.profile };
    verifier.record = () => testnetRecord(selected, pin);
  }
  // The existing replay harness uses venue presence to select range replay.
  // This reader-owned sentinel carries no supplier/profile data and its
  // record factory above ignores it; IPC cannot select trail-only fallback.
  process.stdout.write(JSON.stringify(await replayEvidencePackage(withTestnet ? { ...input, venue: {} } : input, verifier, codec)));
} catch {
  process.stderr.write("local replay fixture failed\n");
  process.exitCode = 1;
} finally {
  if (api) await api.destroy();
}

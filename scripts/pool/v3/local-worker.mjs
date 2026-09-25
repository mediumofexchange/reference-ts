// Fresh local fixture process. Artifact path is harness-owned; pins are fixed
// in the independently held candidate manifest,
// never read from the supplied record package. No witness or original journal.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { deserialize } from "node:v8";
import { Barretenberg, BackendType, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { recordReader, replayEvidencePackage } from "./local-replay.mjs";
import { FixtureVenue } from "../../../dist/record-venue.js";
import { field } from "../fixtures.mjs";
import { loadCandidateManifest, checkCandidateSources, candidateConfiguration, readCandidateKeys } from "./candidate.mjs";
import { v3Codec } from "./codec.mjs";

let api;
try {
  if (process.argv.length > 4 || (process.argv[3] !== undefined && process.argv[3] !== "--ergo")) throw new Error("unknown reader mode");
  const withErgo = process.argv[3] === "--ergo";
  const codec = v3Codec;
  const manifest = loadCandidateManifest(); checkCandidateSources(manifest);
  const configuration = candidateConfiguration(manifest, codec);
  const keys = readCandidateKeys(fileURLToPath(process.argv[2]), manifest);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2_097_152) throw new Error("fixture IPC limit");
    chunks.push(chunk);
  }
  const input = deserialize(Buffer.concat(chunks));
  const fields = Object.keys(input).sort().join(",");
  if (!["package,selection", "package,seed,selection", "package,selection,venue", "package,seed,selection,venue"].includes(fields)) {
    throw new Error("unexpected fixture input");
  }
  // Share the harness's prepared parameters instead of using a separate
  // environment-selected or user cache during fresh-process replay.
  api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1,
    crsPath: resolve(import.meta.dirname, "../../../scratch/private-payment-crs") });
  const backend = new UltraHonkVerifierBackend(api);
  // The fixture venue record is this process's own range verifier (§13.2),
  // rebuilt from the fixture IPC beside the selection; the package cannot supply it.
  const verifier = { configuration, verify: (kind, publicInputs, proof) => backend.verifyProof({
    proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind),
  }, { verifierTarget: "noir-recursive" }), record: data => recordReader(FixtureVenue.from(data), "fixture-verifier") };
  // Under --ergo the process's own ErgoVenue, on its own anchor context, verifies the package's blocks.
  if (withErgo) verifier.record = (await import("./ergo-check.mjs")).ergoRecord;
  process.stdout.write(JSON.stringify(await replayEvidencePackage(input, verifier, codec)));
} catch {
  process.stderr.write("local replay fixture failed\n");
  process.exitCode = 1;
} finally {
  if (api) await api.destroy();
}

// Fresh local fixture process. Artifact path is harness-owned; pins are fixed
// in the independently held candidate manifest,
// never read from the supplied record package. No witness or original journal.
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { Barretenberg, BackendType, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { loadEvidenceCodecs } from "../delivery/evidence-reader.mjs";
import { replayLocalPackage } from "./local-replay.mjs";
import { field } from "../fixtures.mjs";
import { loadCandidateManifest, checkCandidateSources, candidateConfiguration, readCandidateKeys,
  loadConfigurationCodecs } from "./candidate.mjs";

let api;
try {
  const codec = { ...await loadEvidenceCodecs(process.argv[2]), ...await loadConfigurationCodecs(process.argv[2]) };
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
  if (fields !== "package,selection" && fields !== "package,seed,selection") throw new Error("unexpected fixture input");
  api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1 });
  const backend = new UltraHonkVerifierBackend(api);
  const verifier = { configuration, verify: (kind, publicInputs, proof) => backend.verifyProof({
    proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind),
  }, { verifierTarget: "noir-recursive" }) };
  process.stdout.write(JSON.stringify(await replayLocalPackage(input, verifier, codec)));
} catch {
  process.stderr.write("local replay fixture failed\n");
  process.exitCode = 1;
} finally {
  if (api) await api.destroy();
}

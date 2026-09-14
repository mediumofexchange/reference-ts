// Fresh local fixture process. Artifact path is harness-owned; pins are fixed
// in the independently held candidate manifest,
// never read from the supplied record package. No witness or original journal.
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { Barretenberg, BackendType, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { loadEvidenceCodecs } from "../delivery/evidence-reader.mjs";
import { replayEvidencePackage, RANGE_LIMITS } from "./local-replay.mjs";
import { FixtureVenue } from "./fixture-venue.mjs";
import { field } from "../fixtures.mjs";
import { loadCandidateManifest, checkCandidateSources, candidateConfiguration, readCandidateKeys,
  loadConfigurationCodecs } from "./candidate.mjs";

let api;
try {
  const codec = { ...await loadEvidenceCodecs(process.argv[2]), ...await loadConfigurationCodecs(process.argv[2]),
    ...await import(new URL("model/pool-v3-package.js", process.argv[2])),
    ...await import(new URL("model/pool-v3-range.js", process.argv[2])) };
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
  api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1 });
  const backend = new UltraHonkVerifierBackend(api);
  // The fixture venue record is this process's own range verifier (§13.2),
  // rebuilt from the fixture IPC beside the selection; the package cannot supply it.
  const verifier = { configuration, verify: (kind, publicInputs, proof) => backend.verifyProof({
    proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind),
  }, { verifierTarget: "noir-recursive" }), record: data => {
    const witnessed = FixtureVenue.from(data);
    return { range: request => witnessed.answer(request, codec, RANGE_LIMITS), witnessedIndex: () => witnessed.witnessedIndex, lag: () => witnessed.lag };
  } };
  process.stdout.write(JSON.stringify(await replayEvidencePackage(input, verifier, codec)));
} catch {
  process.stderr.write("local replay fixture failed\n");
  process.exitCode = 1;
} finally {
  if (api) await api.destroy();
}
